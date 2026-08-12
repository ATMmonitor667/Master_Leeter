import { InterviewModeSchema, type ServerMessage, type SessionEvent } from "@master-leeter/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { InterviewRuntime, type IntentClassifier } from "../orchestrator/index.js";
import { MintLimiter, RealtimeTokenError, type RealtimeTokenMinter } from "../realtime/index.js";
import { RunQueue, type CodeRunner, hashInput } from "../runner/index.js";
import { type LoadedScenario, resolveScenario } from "../scenario/loader.js";
import { SessionChannel } from "./channel.js";
import { InMemoryEventLog } from "./event-log.js";
import { type LeaseState, newLease, onDisconnect, onReconnect, pendingCredit } from "./lease.js";
import { reconstruct } from "./resume.js";
import { enqueueRun, handleRunRequestedEvent, type RunContext } from "./runs.js";
import { InMemorySessionStore, SessionNotFoundError, remainingSeconds } from "./session-store.js";
import { registerEventsSocket } from "./ws.js";

/**
 * Session module — session lifecycle, the app WebSocket, and the event log.
 *
 * Stays THIN. Auth, token minting, routing, trace IDs, and event persistence.
 * Interview policy lives in the orchestrator, not here.
 */

export { InMemoryEventLog, evidenceHash, type AppendRequest, type EventLog } from "./event-log.js";
export { PgEventLog, type QueryClient } from "./pg-event-log.js";
export {
  InMemorySessionStore,
  SessionNotFoundError,
  remainingSeconds,
  type InterviewSession,
  type SessionStore,
} from "./session-store.js";
export { SessionChannel, type ChannelDeps } from "./channel.js";
export {
  GRACE_SECONDS,
  isAbandoned,
  isTimerRunning,
  newLease,
  onDisconnect,
  onReconnect,
  pendingCredit,
  type LeaseState,
} from "./lease.js";
export { reconstruct, type ResumeState } from "./resume.js";
export { handleConnection, registerEventsSocket, type SocketLike } from "./ws.js";

const CreateSessionBody = z.object({
  /** Opaque public ref from GET /scenarios. Internal ids are also accepted. */
  scenarioRef: z.string().min(1),
  mode: InterviewModeSchema.default("MOCK"),
  language: z.string().default("python"),
});

const RunBody = z.object({
  source: z.string().max(200_000),
  revision: z.number().int().nonnegative(),
  input: z.string().max(100_000).default(""),
});

export interface SessionModuleOptions {
  library: Map<string, LoadedScenario>;
  store?: InMemorySessionStore;
  eventLog?: InMemoryEventLog;
  /** Absent until a judge model is configured. The interview works without it. */
  runner?: CodeRunner;
  /** Enqueued on end. Never awaited — evaluation is off the live path (ADR-004). */
  evaluationQueue?: { enqueue(sessionId: string, rubricId: string): unknown };
  /**
   * Shared across every session in the process, deliberately.
   *
   * The cache warms across sessions, and — more importantly — one circuit
   * breaker protects the whole process. A quota exhaustion is an account-level
   * fact, not a session-level one, so per-session breakers would each have to
   * discover it independently, at the cost of three timed-out turns apiece.
   *
   * Omitted in tests, where `InterviewRuntime` falls back to the rule stub.
   */
  classifier?: IntentClassifier;
  /**
   * Absent until voice is configured, and absent in most tests.
   *
   * Its absence is a 503 on the token route and nothing else — the interview
   * runs without voice exactly as it runs without a runner.
   */
  realtimeTokenMinter?: RealtimeTokenMinter;
}

export async function registerSessionModule(
  app: FastifyInstance,
  opts: SessionModuleOptions,
): Promise<void> {
  const store = opts.store ?? new InMemorySessionStore();
  const eventLog = opts.eventLog ?? new InMemoryEventLog();
  const channel = new SessionChannel({ sessions: store, eventLog });

  /**
   * runId -> the session context needed to attribute the result on the way back.
   *
   * Runs complete asynchronously, so the result arrives with no memory of which
   * session or scenario version it belonged to. An unattributable run is
   * unusable evidence.
   */
  const runContext = new Map<string, RunContext>();

  /** Connected app sockets, for async pushes such as RUN_RESULT. */
  const sessionPushers = new Map<string, Set<(msg: ServerMessage) => void>>();

  function pushToSession(sessionId: string, msg: ServerMessage): void {
    for (const push of sessionPushers.get(sessionId) ?? []) {
      try {
        push(msg);
      } catch {
        // A dead socket must not break run completion for everyone else.
      }
    }
  }

  function attachSessionSocket(sessionId: string, push: (msg: ServerMessage) => void): () => void {
    let set = sessionPushers.get(sessionId);
    if (!set) {
      set = new Set();
      sessionPushers.set(sessionId, set);
    }
    set.add(push);
    return () => {
      set!.delete(push);
      if (set!.size === 0) sessionPushers.delete(sessionId);
    };
  }

  /** Per-session connection leases. Per-process for now; Redis when multi-node. */
  const leases = new Map<string, LeaseState>();

  /** Caps realtime credential minting per session. Cleared when the session ends. */
  const mintLimiter = new MintLimiter();

  /**
   * Live orchestrators, one per active session.
   *
   * Created lazily on first event rather than at session creation, because a
   * session that is created and abandoned should not hold interview state. Also
   * per-process — a multi-node deployment needs the lease to pin a session to
   * one node, which is the same constraint the WebSocket already imposes.
   */
  const runtimes = new Map<string, InterviewRuntime>();

  async function runtimeFor(sessionId: string): Promise<InterviewRuntime | null> {
    const existing = runtimes.get(sessionId);
    if (existing) return existing;

    const session = await store.get(sessionId);
    if (!session || session.endedAt) return null;

    const scenario = opts.library.get(session.scenarioVersionId);
    if (!scenario) return null;

    const runtime = new InterviewRuntime({
      sessionId: session.id,
      scenario: scenario.version,
      // The policy PINNED at session creation, not looked up by mode. A policy
      // change deployed mid-interview must not alter a session in flight.
      policy: session.policy,
      scenarioVersionId: session.scenarioVersionId,
      traceId: session.traceId,
      events: eventLog,
      remainingSeconds: () => remainingSeconds(session, Date.now()),
      // Without this the runtime silently falls back to the rule stub, and
      // every session runs on `stub-rules-v1` while CLASSIFIER_MODEL is read by
      // nothing. The failure is invisible in the logs and only shows up as an
      // interviewer that never notices a complexity claim.
      ...(opts.classifier ? { classifier: opts.classifier } : {}),
    });

    runtimes.set(session.id, runtime);
    return runtime;
  }

  let queue: RunQueue | null = null;

  const runDeps = {
    get queue() {
      return queue;
    },
    store,
    runtimeFor,
    runContext,
    pushToSession,
  };

  /**
   * Hands a committed event to the orchestrator.
   *
   * Failures are logged and swallowed on purpose. The event is already durable;
   * an orchestrator that throws must not roll back evidence or drop the
   * candidate's connection. A quiet interviewer is a degraded interview, a lost
   * event log is an unrecoverable one.
   */
  async function dispatch(event: SessionEvent): Promise<void> {
    if (event.type === "RUN_REQUESTED") {
      await handleRunRequestedEvent(event, runDeps);
    }

    const runtime = await runtimeFor(event.sessionId);
    if (!runtime) return;

    try {
      const { decision, utterance } = await runtime.ingest(event);
      if (decision && decision.action !== "STAY_SILENT") {
        // M3-5 wires this to realtime response creation. Until then the
        // decision and its authored wording live in the log, which is what the
        // eval harness reads — so silence quality is measurable before a single
        // byte of audio exists.
        app.log.info(
          { sessionId: event.sessionId, action: decision.action, reason: decision.reason },
          "interviewer authorized to speak",
        );
        void utterance;

        // No audio pipeline yet, so the utterance is "finished" the instant it
        // is produced. M3-5 replaces this with the realtime response-done
        // event, at which point barge-in has a real window to interrupt.
        runtime.markSpeechFinished();
      }
    } catch (err) {
      app.log.error({ sessionId: event.sessionId, err }, "orchestrator ingest failed");
    }
  }

  queue = opts.runner
    ? new RunQueue({
        runner: opts.runner,
        onResult: async (result) => {
          const ctx = runContext.get(result.runId);
          runContext.delete(result.runId);
          if (!ctx) return;

          const appended = await eventLog.append({
            sessionId: ctx.sessionId,
            type: "RUN_COMPLETED",
            actor: "SYSTEM",
            scenarioVersionId: ctx.scenarioVersionId,
            payload: { ...result },
            traceId: ctx.traceId,
            idempotencyKey: `run-completed:${result.runId}`,
          });

          // The observer needs run results as much as it needs code: a green
          // run is what clears the stuck score, and a third identical failure
          // is what makes a debugging probe defensible.
          if (!appended.duplicate) await dispatch(appended.event);

          pushToSession(ctx.sessionId, { kind: "RUN_RESULT", result });
        },
        onUnavailable: (request, error) => {
          // Logged, not thrown. A runner outage must not end the interview.
          runContext.delete(request.runId);
          app.log.warn({ runId: request.runId, err: error.message }, "runner unavailable");
          pushToSession(request.sessionId, {
            kind: "ERROR",
            code: "RUNNER_UNAVAILABLE",
            message: "Execution is temporarily unavailable. Keep going.",
          });
        },
      })
    : null;

  app.post("/interview-sessions", async (req, reply) => {
    const body = CreateSessionBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "INVALID_BODY", detail: body.error.issues });
    }

    // Every mutating operation carries an idempotency key. Without one, a retried
    // create silently produces two sessions and the candidate loses their work.
    const idempotencyKey = req.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      return reply.code(400).send({ error: "MISSING_IDEMPOTENCY_KEY" });
    }

    const scenario = resolveScenario(opts.library, body.data.scenarioRef);
    if (!scenario) {
      return reply.code(404).send({ error: "UNKNOWN_SCENARIO" });
    }

    // M2-8: userId comes from the auth context once a provider is chosen.
    const userId = (req.headers["x-user-id"] as string) ?? "anonymous";

    try {
      const session = await store.create({
        userId,
        scenario,
        mode: body.data.mode,
        language: body.data.language,
        idempotencyKey,
      });

      await eventLog.append({
        sessionId: session.id,
        type: "SESSION_STARTED",
        actor: "SYSTEM",
        scenarioVersionId: session.scenarioVersionId,
        payload: { mode: session.mode, language: session.language, scenarioHash: session.scenarioHash },
        traceId: session.traceId,
        idempotencyKey: `session-started:${session.id}`,
      });

      // Note what is NOT in this response: no oral brief, no facts, no tests.
      // The problem reaches the candidate through the voice agent or not at all.
      return reply.code(201).send({
        sessionId: session.id,
        state: session.state,
        expectedSeconds: session.expectedSeconds,
        mode: session.mode,
        language: session.language,
      });
    } catch (err) {
      return reply.code(409).send({ error: "CANNOT_CREATE", message: (err as Error).message });
    }
  });

  app.get("/interview-sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await store.get(id);
    if (!session) return reply.code(404).send({ error: "UNKNOWN_SESSION" });

    return reply.send({
      sessionId: session.id,
      state: session.state,
      remainingSeconds: remainingSeconds(session, Date.now()),
      endedAt: session.endedAt,
    });
  });

  app.post("/interview-sessions/:id/end", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const session = await store.end(id);

      await eventLog.append({
        sessionId: session.id,
        type: "SESSION_ENDED",
        actor: "SYSTEM",
        scenarioVersionId: session.scenarioVersionId,
        payload: {},
        traceId: session.traceId,
        // Idempotent by construction: ending twice appends once.
        idempotencyKey: `session-ended:${session.id}`,
      });

      // Let the orchestrator settle its final observation pass before the
      // evaluator reads the log, then drop it. Without this the last code delta
      // of a session can lose its snapshot to the process moving on.
      const runtime = runtimes.get(session.id);
      if (runtime) {
        await runtime.settled();
        runtimes.delete(session.id);
      }
      channel.forget(session.id);
      mintLimiter.forget(session.id);

      // Fire and forget. The live phase must complete regardless of evaluator
      // health, so this is deliberately not awaited and its failure cannot
      // affect the response (ADR-004).
      const scenario = opts.library.get(session.scenarioVersionId);
      opts.evaluationQueue?.enqueue(session.id, scenario?.version.rubricId ?? "rubric-coding-v1");

      return reply.send({ sessionId: session.id, endedAt: session.endedAt });
    } catch (err) {
      if (err instanceof SessionNotFoundError) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
      throw err;
    }
  });

  /**
   * Resume after a refresh or a drop.
   *
   * Rebuilt from the append-only log rather than a cache. If the log cannot
   * restore the candidate's screen, it cannot be trusted to justify their score
   * either -- so this endpoint doubles as a standing check that the log is
   * complete.
   */
  app.get("/interview-sessions/:id/resume", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await store.get(id);
    if (!session) return reply.code(404).send({ error: "UNKNOWN_SESSION" });

    const resumed = await reconstruct(eventLog, id, session.state);
    if (!resumed) return reply.code(404).send({ error: "NO_EVENTS" });

    const lease = leases.get(id) ?? newLease();
    const credited = onReconnect(lease, Date.now());
    leases.set(id, credited.lease);

    if (credited.creditedSeconds > 0) {
      // Credit the clock before reporting remaining time, so the candidate
      // never sees the minutes they lost to a drop.
      await store.addPause(id, credited.creditedSeconds);
      await eventLog.append({
        sessionId: id,
        type: "TIMER_RESUMED",
        actor: "SYSTEM",
        scenarioVersionId: session.scenarioVersionId,
        payload: { creditedSeconds: credited.creditedSeconds, drops: credited.lease.dropCount },
        traceId: session.traceId,
        idempotencyKey: `resume:${id}:${credited.lease.dropCount}`,
      });
    }

    const current = (await store.get(id)) ?? session;

    return reply.send({
      ...resumed,
      remainingSeconds: remainingSeconds(current, Date.now()),
      creditedSeconds: credited.creditedSeconds,
      drops: credited.lease.dropCount,
    });
  });

  /** Called by the client when its socket closes. Starts the grace window. */
  app.post("/interview-sessions/:id/disconnected", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await store.get(id);
    if (!session) return reply.code(404).send({ error: "UNKNOWN_SESSION" });

    const lease = onDisconnect(leases.get(id) ?? newLease(), Date.now());
    leases.set(id, lease);

    await eventLog.append({
      sessionId: id,
      type: "CONNECTION_LOST",
      actor: "SYSTEM",
      scenarioVersionId: session.scenarioVersionId,
      payload: { drop: lease.dropCount },
      traceId: session.traceId,
      idempotencyKey: `disconnect:${id}:${lease.dropCount}`,
    });

    return reply.send({ ok: true, pendingCredit: pendingCredit(lease, Date.now()) });
  });

  /**
   * Mint a short-lived realtime credential (M3-1).
   *
   * The response is on its way to a browser, so the rules are strict: the
   * provider key never appears in it, no provider error text is echoed back, and
   * no scenario content rides along. The token itself is safe to send — it is
   * single-use, expires in minutes, and is locked to a connect config that
   * cannot auto-respond.
   */
  app.post("/interview-sessions/:id/realtime-token", async (req, reply) => {
    const { id } = req.params as { id: string };

    const session = await store.get(id);
    if (!session) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
    if (session.endedAt) return reply.code(409).send({ error: "SESSION_ENDED" });

    if (!opts.realtimeTokenMinter) {
      // Same posture as the runner: a missing capability is a 503 that explains
      // itself, not a boot failure and not a silent stub.
      return reply.code(503).send({
        error: "REALTIME_UNAVAILABLE",
        message: "Voice is not configured. Set REALTIME_MODEL and REALTIME_API_KEY.",
      });
    }

    if (!mintLimiter.take(id)) {
      // Almost always a client retry loop rather than an attacker, and the
      // symptom of not catching it — voice dying for every session once the
      // quota is gone — looks nothing like the cause.
      app.log.warn({ sessionId: id, mints: mintLimiter.used(id) }, "realtime token cap reached");
      return reply.code(429).send({
        error: "TOKEN_CAP_REACHED",
        message: "Too many realtime credentials issued for this session.",
      });
    }

    try {
      const credential = await opts.realtimeTokenMinter.mint();

      app.log.info(
        {
          sessionId: id,
          traceId: session.traceId,
          model: credential.model,
          expiresAt: credential.expiresAt,
          mints: mintLimiter.used(id),
        },
        "minted realtime credential",
      );

      return reply.code(201).send(credential);
    } catch (err) {
      const kind = err instanceof RealtimeTokenError ? err.kind : "PROVIDER_ERROR";

      // Full detail to the log — a rejected constraint is explained precisely in
      // the provider's body and that is the first thing anyone debugging this
      // will want. The client gets a code and nothing else.
      app.log.error({ sessionId: id, kind, err }, "realtime token mint failed");

      return reply.code(kind === "RATE_LIMITED" ? 429 : 502).send({
        error: kind === "RATE_LIMITED" ? "TOKEN_CAP_REACHED" : "REALTIME_MINT_FAILED",
        message: "Could not obtain a voice credential. Retry shortly.",
      });
    }
  });

  app.post("/interview-sessions/:id/runs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await store.get(id);
    if (!session) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
    if (session.endedAt) return reply.code(409).send({ error: "SESSION_ENDED" });

    if (!queue) {
      return reply.code(503).send({
        error: "RUNNER_UNAVAILABLE",
        message: "Execution is temporarily unavailable. Keep going.",
      });
    }

    const body = RunBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "INVALID_BODY", detail: body.error.issues });
    }

    const enqueued = enqueueRun(
      session,
      { source: body.data.source, revision: body.data.revision, input: body.data.input },
      runDeps,
    );

    if (!enqueued) {
      return reply.code(429).send({ error: "RUNNER_BUSY", message: "Too many runs queued." });
    }

    await eventLog.append({
      sessionId: session.id,
      type: "RUN_REQUESTED",
      actor: "CANDIDATE",
      scenarioVersionId: session.scenarioVersionId,
      payload: {
        runId: enqueued.runId,
        revision: body.data.revision,
        inputHash: hashInput(body.data.input),
      },
      traceId: session.traceId,
      idempotencyKey: `run-requested:${enqueued.runId}`,
    });

    // 202: the work is queued, not done. Execution is asynchronous from this
    // thread by design — a runaway submission must never pin the session
    // service, which also holds the editor channel and the timer.
    return reply.code(202).send({ runId: enqueued.runId, revision: body.data.revision });
  });

  // WS /v1/interview-sessions/:id/events — M2-2's transport, finally attached.
  // The channel owns the protocol and the runtime owns the interview; this only
  // moves bytes between them.
  await registerEventsSocket(app, { channel, dispatch, attach: attachSessionSocket });
}
