import { InterviewModeSchema, type ServerMessage, type SessionEvent } from "@master-leeter/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { InterviewRuntime, type IntentClassifier } from "../orchestrator/index.js";
import {
  MintLimiter,
  RealtimeTokenError,
  executeVoiceTool,
  type RealtimeTokenMinter,
} from "../realtime/index.js";
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

const VoiceToolBody = z.object({
  name: z.string().min(1),
  args: z.record(z.unknown()).default({}),
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
      // A decision reached by the re-evaluation timer has no caller awaiting it.
      onAuthorized: (result) => deliver(session.id, result),
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
      const result = await runtime.ingest(event);
      deliver(event.sessionId, result);
    } catch (err) {
      app.log.error({ sessionId: event.sessionId, err }, "orchestrator ingest failed");
    }
  }

  /**
   * Hand an authorized decision to the speech path.
   *
   * Shared by `dispatch` and by the runtime's `onAuthorized` callback. A turn
   * re-judged after its silence floor elapses is decided by a timer with nobody
   * awaiting it, so without a single place for this the interviewer would decide
   * to speak and then say nothing.
   */
  function deliver(sessionId: string, result: { decision: unknown; utterance: unknown }): void {
    const runtime = runtimes.get(sessionId);
    const decision = result.decision as { action: string; reason: string } | null;
    const utterance = result.utterance;

    if (decision && decision.action !== "STAY_SILENT") {
        // M3-5 wires this to realtime response creation. Until then the
        // decision and its authored wording live in the log, which is what the
        // eval harness reads — so silence quality is measurable before a single
        // byte of audio exists.
        app.log.info(
          { sessionId, action: decision.action, reason: decision.reason },
          "interviewer authorized to speak",
        );

        /**
         * M3-5. The client is told THAT the interviewer may speak, never what it
         * will say.
         *
         * The wording is authored scenario content — probe variants, hint text,
         * a canonical fact — and putting it on this channel would land it in the
         * browser where a candidate can read ahead. The voice agent fetches it
         * from the tool surface instead, which checks the same authorization
         * this message reflects.
         */
        const utteranceId = (utterance as { utteranceId?: string } | null)?.utteranceId;
        pushToSession(sessionId, {
          kind: "ACTION",
          action: decision.action,
          ...(utteranceId ? { utteranceId } : {}),
        } as ServerMessage);
        void utterance;

        /**
         * Close the window only when nobody can tell us it closed.
         *
         * The authorization is what the voice tool surface checks, so clearing
         * it here unconditionally — which is what this did — meant the browser
         * received ACTION, asked the model to speak, the model called
         * get_probe_wording, and got NOT_AUTHORIZED. Every voice turn died
         * silently, and the log showed a perfectly good decision behind it.
         *
         * With a socket attached the client reports completion (see
         * /voice-utterance-complete) once the model's audio ends, which is also
         * when barge-in stops applying. With no socket there is nothing to
         * report it, and leaving the flag set would make gate rule 1 read every
         * later turn as a barge-in and mute the interviewer for good.
         */
        if (!sessionPushers.has(sessionId)) runtime?.markSpeechFinished();
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

  /**
   * Voice agent tool relay (M3-5, completing M3-3).
   *
   * Gemini Live delivers tool calls to whoever holds the socket, which is the
   * browser. So the browser relays them here rather than answering them: the
   * five tools read pinned scenario content and check the gate's authorization,
   * and neither of those may live in a client the candidate controls.
   *
   * The browser therefore sees a tool result in flight. That is a real and
   * accepted narrowing of invariant 2 — it is transient, never rendered, and the
   * alternative is holding the Live socket server-side and relaying audio both
   * ways, which ADR-001 did not choose. What must never happen is the wording
   * arriving unsolicited on the app channel, and it does not.
   */
  /**
   * The voice session is connected and can be spoken through (M3-4).
   *
   * This is what opens the interview. SESSION_STARTED is appended at creation
   * but was never dispatched to the orchestrator, so `openInterview` — the whole
   * brief-delivery path — was unreachable: the problem only got delivered if the
   * candidate happened to speak first, which is backwards, since they are
   * waiting to hear it.
   *
   * It is deliberately driven by the CLIENT being ready rather than by session
   * creation. A brief delivered before anything could play it is a brief nobody
   * hears, and the authorization would be spent on silence.
   *
   * Replays through the same path: the opening is triggered by ingesting the
   * logged SESSION_STARTED, so a replay reaches it without this route existing.
   */
  app.post("/interview-sessions/:id/voice-ready", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await store.get(id);
    if (!session) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
    if (session.endedAt) return reply.code(409).send({ error: "SESSION_ENDED" });

    const started = (await eventLog.read(id)).find((e) => e.type === "SESSION_STARTED");
    if (!started) return reply.code(409).send({ error: "NO_SESSION_STARTED" });

    // Idempotent by construction: the gate only authorizes the brief while
    // briefDeliveryCount is 0, so a retried call decides STAY_SILENT.
    await dispatch(started);
    return reply.send({ ok: true });
  });

  /**
   * The interviewer's audio finished (M3-5).
   *
   * Reported by the browser when the model's turn completes. Two things end
   * here: the authorization the tool surface checks, and the window in which a
   * candidate speaking counts as barge-in.
   */
  app.post("/interview-sessions/:id/voice-utterance-complete", async (req, reply) => {
    const { id } = req.params as { id: string };
    const runtime = runtimes.get(id);
    if (!runtime) return reply.code(409).send({ error: "NO_LIVE_SESSION" });

    runtime.markSpeechFinished();
    return reply.send({ ok: true });
  });

  app.post("/interview-sessions/:id/voice-tool", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await store.get(id);
    if (!session) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
    if (session.endedAt) return reply.code(409).send({ error: "SESSION_ENDED" });

    const body = VoiceToolBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "INVALID_BODY", detail: body.error.issues });
    }

    const scenario = opts.library.get(session.scenarioVersionId);
    const runtime = runtimes.get(id);
    if (!scenario || !runtime) {
      // No live orchestrator means no authorization to check against, and an
      // unchecked tool call is exactly what this surface exists to prevent.
      return reply.code(409).send({ error: "NO_LIVE_SESSION" });
    }

    const voice = runtime.voiceContext();

    const result = await executeVoiceTool(
      { name: body.data.name, args: body.data.args },
      {
        scenario: scenario.version,
        state: voice.state,
        remainingSeconds: remainingSeconds(session, Date.now()),
        candidateState: voice.candidateState,
        probeUseCounts: voice.probeUseCounts,
        answeredFactKeys: voice.answeredFactKeys,
        authorized: voice.authorized,
      },
      {
        recordDelivery: async (entry) => {
          await eventLog.append({
            sessionId: id,
            type: "BRIEF_DELIVERED",
            actor: "INTERVIEWER",
            scenarioVersionId: session.scenarioVersionId,
            payload: { ...entry, utteranceId: voice.utteranceId },
            traceId: session.traceId,
            idempotencyKey: `delivery:${voice.utteranceId ?? "none"}:${entry.kind}`,
          });
        },
      },
    );

    if (!result.ok) {
      app.log.info({ sessionId: id, tool: body.data.name, refusal: result.refusal }, "voice tool refused");
      // 200 with a refusal, not an HTTP error: the model needs to read this and
      // carry on, and a 4xx would look like a transport fault to the relay.
      return reply.send(result);
    }

    return reply.send(result);
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
