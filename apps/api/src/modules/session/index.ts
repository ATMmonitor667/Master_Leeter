import { InterviewModeSchema, type InterviewState, type ServerMessage, type SessionEvent } from "@master-leeter/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { userIdFor } from "../auth/index.js";
import { InterviewRuntime, type IntentClassifier } from "../orchestrator/index.js";
import {
  MintLimiter,
  RealtimeTokenError,
  VoiceResumptionStore,
  executeVoiceTool,
  type RealtimeTokenMinter,
} from "../realtime/index.js";
import { RunQueue, type CodeRunner, hashInput } from "../runner/index.js";
import { type LoadedScenario } from "../scenario/loader.js";
import { type QuestionBank, FileQuestionBank, QuestionBankError, chooseQuestion } from "../scenario/question-bank.js";
import { SessionChannel } from "./channel.js";
import { InMemoryEventLog, type EventLog } from "./event-log.js";
import { isAbandoned, type LeaseState, newLease, onDisconnect, onReconnect, pendingCredit } from "./lease.js";
import { reconstruct } from "./resume.js";
import { buildSessionReview } from "./review.js";
import { enqueueRun, handleRunRequestedEvent, type RunContext } from "./runs.js";
import {
  InMemorySessionStore,
  type InterviewSession,
  type SessionStore,
  SessionNotFoundError,
  remainingSeconds,
} from "./session-store.js";
import { registerEventsSocket } from "./ws.js";
import { FinalInputsPendingError, type SessionLifecycle } from "./lifecycle.js";
import { RuntimeOwnerHandles, type RuntimeOwnership } from "./runtime-ownership.js";
import { AdmissionError } from "../admission/index.js";
import { ProviderCircuit } from "../../lib/provider-circuit.js";

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
  DEFAULT_INTERVIEW_SECONDS,
  type InterviewSession,
  type SessionStore,
} from "./session-store.js";
export { SessionChannel, type ChannelDeps } from "./channel.js";
export { InMemorySessionLifecycle, type SessionLifecycle } from "./lifecycle.js";
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
export { buildSessionReview, reviewAsTsv, type ReviewEntry } from "./review.js";
export { handleConnection, registerEventsSocket, type SocketLike } from "./ws.js";

const CreateSessionBody = z.object({
  /** Opaque public ref from GET /scenarios. Internal ids are also accepted. */
  scenarioRef: z.string().min(1).max(200).optional(),
  mode: InterviewModeSchema.default("MOCK"),
  language: z.string().default("python"),
});

const VoiceToolBody = z.object({
  name: z.string().min(1),
  args: z.record(z.unknown()).default({}),
});

const VoiceResumptionBody = z.object({
  /** Opaque handle emitted by the provider to the browser holding the socket. */
  handle: z.string().min(1).max(16_384),
});

const RunBody = z.object({
  source: z.string().max(200_000),
  revision: z.number().int().nonnegative(),
  input: z.string().max(100_000).default(""),
});

const EndBody = z.object({
  /** Highest browser event acknowledged before requesting the atomic seal. */
  finalClientSeq: z.number().int().min(-1).default(-1),
});

export interface SessionModuleOptions {
  library: Map<string, LoadedScenario>;
  questionBank?: QuestionBank;
  store?: SessionStore;
  eventLog?: EventLog;
  /** Absent until a judge model is configured. The interview works without it. */
  runner?: CodeRunner;
  /** Enqueued on end. Never awaited — evaluation is off the live path (ADR-004). */
  evaluationQueue?: { enqueue(sessionId: string, rubricId: string): Promise<unknown> };
  lifecycle?: SessionLifecycle;
  runtimeOwnership?: RuntimeOwnership;
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
  maxRealtimeMintsPerSession?: number;
  realtimeCircuit?: ProviderCircuit;
  onRealtimeCircuitOpen?: (sessionId: string, failureKind: string) => void;
}

export async function registerSessionModule(
  app: FastifyInstance,
  opts: SessionModuleOptions,
): Promise<void> {
  const store = opts.store ?? new InMemorySessionStore();
  const eventLog = opts.eventLog ?? new InMemoryEventLog();
  const questionBank = opts.questionBank ?? new FileQuestionBank(opts.library);

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
  const mintLimiter = new MintLimiter(opts.maxRealtimeMintsPerSession);
  const realtimeCircuit = opts.realtimeCircuit ?? new ProviderCircuit(3, 60_000);
  // Handles are reported by the browser and read back here at mint time. The
  // mint route never reads a handle out of its own request body — see
  // VoiceResumptionStore for why that distinction is the whole point.
  const resumption = new VoiceResumptionStore();

  /**
   * Live orchestrators, one per active session.
   *
   * Created lazily on first event rather than at session creation, because a
   * session that is created and abandoned should not hold interview state. Also
   * per-process — a multi-node deployment needs the lease to pin a session to
   * one node, which is the same constraint the WebSocket already imposes.
   */
  const runtimes = new Map<string, InterviewRuntime>();

  /**
   * The latest persisted session behind each live runtime.
   *
   * `store.transition` and `store.addPause` return NEW objects, so a runtime
   * closing over the one it was built from reports a clock frozen at creation.
   * Since `startedAt` is set by the first transition, that meant "full time
   * remaining" for the whole interview — and the gate's wrap-up rule reads it.
   */
  const liveSessions = new Map<string, InterviewSession>();
  const owners = opts.runtimeOwnership ? new RuntimeOwnerHandles(opts.runtimeOwnership, (id) => {
    runtimes.get(id)?.dispose();
    runtimes.delete(id);
    liveSessions.delete(id);
  }) : undefined;
  const channel = new SessionChannel({ sessions: store, eventLog: owners ? {
    read: (id, seq) => eventLog.read(id, seq),
    latestSeq: (id) => eventLog.latestSeq(id),
    latestClientSeq: (id) => eventLog.latestClientSeq(id),
    append: async (req) => {
      const token = await owners.ensure(req.sessionId);
      if (!token) throw new Error("RUNTIME_OWNERSHIP_LOST");
      return eventLog.append({ ...req, runtimeToken: token });
    },
  } : eventLog });
  const ownershipTimer = owners ? setInterval(() => { void owners.heartbeat(); }, 10_000) : undefined;
  let completionTimer: ReturnType<typeof setInterval> | undefined;
  ownershipTimer?.unref();
  app.addHook("onClose", async () => {
    if (ownershipTimer) clearInterval(ownershipTimer);
    if (completionTimer) clearInterval(completionTimer);
    await owners?.close();
    for (const runtime of runtimes.values()) runtime.dispose();
  });

  // Until command routing exists, reject commands on a non-owner explicitly.
  // Never return success for a voice command that this process cannot handle.
  if (owners) app.addHook("preHandler", async (req, reply) => {
    const id = (req.params as { id?: string }).id;
    if (!id || !req.routeOptions.url?.includes("/interview-sessions/:id")) return;
    if (req.method !== "POST" && !req.routeOptions.url.endsWith("/events")) return;
    const session = await store.get(id);
    if (!session || session.endedAt) return;
    try {
      if (!await owners.ensure(id)) return reply.code(409).send({ error: "RUNTIME_OWNED_ELSEWHERE" });
    } catch {
      return reply.code(503).send({ error: "RUNTIME_OWNERSHIP_UNAVAILABLE" });
    }
  });

  const pendingRuntimes = new Map<string, Promise<InterviewRuntime | null>>();
  const dispatchTails = new Map<string, Promise<void>>();

  async function runtimeFor(sessionId: string, beforeSeq?: number): Promise<InterviewRuntime | null> {
    const pending = pendingRuntimes.get(sessionId);
    if (pending) return pending;
    const task = createRuntime(sessionId, beforeSeq).finally(() => pendingRuntimes.delete(sessionId));
    pendingRuntimes.set(sessionId, task);
    return task;
  }

  async function createRuntime(sessionId: string, beforeSeq?: number): Promise<InterviewRuntime | null> {
    const runtimeToken = await owners?.ensure(sessionId);
    if (owners && !runtimeToken) return null;
    const existing = runtimes.get(sessionId);
    if (existing) return existing;

    const session = await store.get(sessionId);
    if (!session || session.endedAt) return null;

    const scenario = await store.pinnedScenario(session.id);
    if (!scenario || scenario.version.id !== session.scenarioVersionId ||
        scenario.contentHash !== session.scenarioHash) {
      app.log.error({ sessionId }, "session scenario snapshot is missing or does not match its pin");
      return null;
    }

    let liveSession = session;
    liveSessions.set(session.id, session);

    const runtime = new InterviewRuntime({
      sessionId: session.id,
      scenario: scenario.version,
      // The policy PINNED at session creation, not looked up by mode. A policy
      // change deployed mid-interview must not alter a session in flight.
      policy: session.policy,
      scenarioVersionId: session.scenarioVersionId,
      traceId: session.traceId,
      events: runtimeToken ? { append: async (req) => {
        if (!await owners!.verify(sessionId, runtimeToken)) throw new Error("RUNTIME_OWNERSHIP_LOST");
        return eventLog.append({ ...req, runtimeToken });
      } } : eventLog,
      remainingSeconds: () => remainingSeconds(liveSessions.get(session.id) ?? liveSession ?? session, Date.now()),
      // Without this the runtime silently falls back to the rule stub, and
      // every session runs on `stub-rules-v1` while CLASSIFIER_MODEL is read by
      // nothing. The failure is invisible in the logs and only shows up as an
      // interviewer that never notices a complexity claim.
      ...(opts.classifier ? { classifier: opts.classifier } : {}),
      // A decision reached by the re-evaluation timer has no caller awaiting it.
      onAuthorized: (result) => {
        void deliverOwned(session.id, result, runtimeToken ?? undefined);
      },
      ...(opts.lifecycle ? {
        commitTransition: async (from: InterviewState, to: InterviewState, reason: string) => {
          const updated = await opts.lifecycle!.transitionWithEvent(session.id, from, to, reason, runtimeToken ?? undefined);
          liveSession = updated;
          liveSessions.set(session.id, updated);
          pushToSession(session.id, {
            kind: "STATE",
            state: updated.state,
            remainingSeconds: remainingSeconds(updated, Date.now()),
            interviewerStatus: "LISTENING",
          });
        },
      } : {}),
      onTransition: async (to) => {
        if (opts.lifecycle) return;
        const updated = await store.transition(session.id, to);
        liveSession = updated;
        liveSessions.set(session.id, updated);
        pushToSession(session.id, {
          kind: "STATE",
          state: updated.state,
          remainingSeconds: remainingSeconds(updated, Date.now()),
          interviewerStatus: "LISTENING",
        });
      },
    });

    try {
      const history = await eventLog.read(session.id);
      runtime.restore(beforeSeq === undefined ? history : history.filter((event) => event.seq < beforeSeq));
    } catch (error) {
      app.log.error({ sessionId, errorType: error instanceof Error ? error.name : typeof error }, "session runtime could not be restored");
      liveSessions.delete(session.id);
      return null;
    }

    if (runtimeToken && !await owners!.verify(sessionId, runtimeToken)) return null;
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
  function dispatch(event: SessionEvent, replayExisting = false): Promise<void> {
    const previous = dispatchTails.get(event.sessionId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => dispatchOne(event, replayExisting));
    dispatchTails.set(event.sessionId, current);
    const cleanup = () => {
      if (dispatchTails.get(event.sessionId) === current) dispatchTails.delete(event.sessionId);
    };
    void current.then(cleanup, cleanup);
    return current;
  }

  async function dispatchOne(event: SessionEvent, replayExisting = false): Promise<void> {
    const runtime = await runtimeFor(event.sessionId, replayExisting ? undefined : event.seq);
    if (!runtime) return;

    if (event.type === "RUN_REQUESTED") {
      await handleRunRequestedEvent(event, runDeps);
    }

    try {
      const result = await runtime.ingest(event);
      if (runtimes.get(event.sessionId) === runtime) await deliverOwned(event.sessionId, result);
    } catch (error) {
      app.log.error({ sessionId: event.sessionId, errorType: error instanceof Error ? error.name : typeof error }, "orchestrator ingest failed");
    }
  }

  async function deliverOwned(sessionId: string, result: { decision: unknown; utterance: unknown }, expectedToken?: string): Promise<void> {
    if (owners) {
      try {
        if (expectedToken && !await owners.verify(sessionId, expectedToken)) return;
        const token = await owners.ensure(sessionId);
        if (!token || (expectedToken && token !== expectedToken)) return;
      } catch { return; }
    }
    deliver(sessionId, result);
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
        if (!sessionPushers.has(sessionId)) void runtime?.markSpeechFinished();
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
          app.log.warn({ runId: request.runId, errorType: error.name }, "runner unavailable");
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

    const userId = userIdFor(req);

    try {
      let session = await store.findByIdempotencyKey(userId, idempotencyKey);
      if (!session) {
        const scenario = body.data.scenarioRef
          ? await questionBank.get(body.data.scenarioRef)
          : chooseQuestion(
              await questionBank.listActive(),
              await store.scenarioVersionIdsForUser(userId),
            );
        if (!scenario) {
          return reply.code(body.data.scenarioRef ? 404 : 503).send({ error: body.data.scenarioRef ? "UNKNOWN_SCENARIO" : "QUESTION_BANK_EMPTY" });
        }
        if (scenario.version.status !== "ACTIVE") {
          return reply.code(409).send({ error: "SCENARIO_NOT_ACTIVE" });
        }
        // Runtime/tools use this immutable pin, never a later database fetch.
        const pinned = opts.library.get(scenario.version.id);
        if (pinned && pinned.contentHash !== scenario.contentHash) throw new QuestionBankError("VERSION_CONFLICT");
        opts.library.set(scenario.version.id, pinned ?? scenario);
        const createRequest = {
          userId,
          scenario,
          mode: body.data.mode,
          language: body.data.language,
          idempotencyKey,
        };
        session = opts.lifecycle
          ? await opts.lifecycle.createStarted(createRequest)
          : await store.create(createRequest);
      }

      if (!opts.lifecycle) {
        await eventLog.append({
          sessionId: session.id,
          type: "SESSION_STARTED",
          actor: "SYSTEM",
          scenarioVersionId: session.scenarioVersionId,
          payload: { mode: session.mode, language: session.language, scenarioHash: session.scenarioHash,
            interviewerTone: session.interviewerTone ?? "NORMAL", expectedSeconds: session.expectedSeconds },
          traceId: session.traceId,
          idempotencyKey: `session-started:${session.id}`,
        });
      }

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
      if (err instanceof AdmissionError) {
        const status = err.code === "ACTIVE_SESSION_EXISTS" ? 409 : err.code === "ADMISSION_PAUSED" ? 503 : 429;
        const message = err.code === "ACTIVE_SESSION_EXISTS"
          ? "Finish your active interview before starting another."
          : err.code === "MONTHLY_QUOTA_REACHED"
            ? "Your interview allowance has been used for this month."
            : "Interview capacity is temporarily unavailable. Please retry later.";
        return reply.code(status).header("Retry-After", status === 409 ? "0" : "60")
          .send({ error: err.code, message });
      }
      if (err instanceof QuestionBankError) {
        app.log.warn({ code: err.code }, "question bank could not supply a validated question");
        return reply.code(503).send({ error: "QUESTION_BANK_UNAVAILABLE", message: "Interview questions are temporarily unavailable. Please retry shortly." });
      }
      req.log.error({ code: "CANNOT_CREATE" }, "interview creation failed");
      return reply.code(409).send({ error: "CANNOT_CREATE", message: "Unable to create interview. Please retry." });
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

  /**
   * Post-session interviewer self-review (M4-5b).
   *
   * Ended sessions only: exposing authored wording while a round is live would
   * turn a developer tool into a solution-content side channel.
   */
  app.get("/interview-sessions/:id/review", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await store.get(id);
    if (!session) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
    if (!session.endedAt) return reply.code(409).send({ error: "SESSION_ACTIVE" });
    const loaded = opts.library.get(session.scenarioVersionId);
    if (!loaded) return reply.code(409).send({ error: "SCENARIO_UNAVAILABLE" });

    const entries = buildSessionReview(await eventLog.read(id), loaded.version);
    return reply.send({ sessionId: id, entries });
  });

  const finalizing = new Map<string, Promise<InterviewSession>>();

  async function finalizeSession(id: string, expectedClientSeq = -1): Promise<InterviewSession> {
    const existing = finalizing.get(id);
    if (existing) return existing;

    const work = (async () => {
      const beforeEnd = await store.get(id);
      if (!beforeEnd) throw new SessionNotFoundError(id);
      // ACK means the input is durable, while this tail means its live derived
      // state has also settled. Seal only after both, otherwise the final input
      // can be present in evidence while its checkpoint is rejected as late.
      for (;;) {
        const tail = dispatchTails.get(id);
        if (!tail) break;
        await tail.catch(() => {});
        if (dispatchTails.get(id) === tail) break;
      }
      const rubricId = opts.library.get(beforeEnd.scenarioVersionId)?.version.rubricId ?? "rubric-coding-v1";
      if (!opts.lifecycle) {
        const durableClientSeq = await eventLog.latestClientSeq(id);
        if (durableClientSeq < expectedClientSeq) {
          throw new FinalInputsPendingError(expectedClientSeq, durableClientSeq);
        }
      }
      const session = opts.lifecycle
        ? await opts.lifecycle.endWithReport(id, rubricId, undefined, expectedClientSeq)
        : await store.end(id);

      if (!opts.lifecycle) {
        await eventLog.append({
          sessionId: session.id,
          type: "SESSION_ENDED",
          actor: "SYSTEM",
          scenarioVersionId: session.scenarioVersionId,
          payload: { sealedClientSeq: await eventLog.latestClientSeq(id) },
          traceId: session.traceId,
          idempotencyKey: `session-ended:${session.id}`,
        });
      }

      const runtime = runtimes.get(session.id);
      if (runtime) {
        await runtime.settled();
        runtime.dispose();
        runtimes.delete(session.id);
        liveSessions.delete(session.id);
      }
      channel.forget(session.id);
      dispatchTails.delete(session.id);
      mintLimiter.forget(session.id);
      resumption.clear(session.id);
      leases.delete(session.id);

      const scenario = opts.library.get(session.scenarioVersionId);
      if (opts.evaluationQueue) {
        void opts.evaluationQueue.enqueue(session.id, scenario?.version.rubricId ?? "rubric-coding-v1")
          .catch((error: unknown) => app.log.error({ sessionId: session.id, errorType: error instanceof Error ? error.name : typeof error }, "report job enqueue failed"));
      }

      return session;
    })().finally(() => finalizing.delete(id));

    finalizing.set(id, work);
    return work;
  }

  let completionSweepRunning = false;
  completionTimer = setInterval(() => {
    if (completionSweepRunning) return;
    completionSweepRunning = true;
    void (async () => {
      const now = new Date();
      const due = await store.dueForCompletion(now.toISOString());
      const ids = new Set(due.map((session) => session.id));
      for (const [id, lease] of leases) {
        if (isAbandoned(lease, now.getTime())) ids.add(id);
      }

      for (const id of ids) {
        try {
          await finalizeSession(id);
          pushToSession(id, {
            kind: "ERROR",
            code: "SESSION_ENDED",
            message: "Interview time is complete. Your report is being prepared.",
          });
        } catch (error) {
          if (!(error instanceof SessionNotFoundError)) {
            app.log.error({ sessionId: id, errorType: error instanceof Error ? error.name : typeof error }, "automatic session completion failed");
          }
        }
      }
    })().finally(() => { completionSweepRunning = false; });
  }, 5_000);
  completionTimer.unref();

  app.post("/interview-sessions/:id/end", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = EndBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "INVALID_BODY", detail: body.error.issues });
    try {
      const session = await finalizeSession(id, body.data.finalClientSeq);
      return reply.send({ sessionId: session.id, endedAt: session.endedAt });
    } catch (err) {
      if (err instanceof SessionNotFoundError) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
      if (err instanceof FinalInputsPendingError) {
        return reply.code(409).send({
          error: "FINAL_INPUTS_PENDING",
          expectedClientSeq: err.expectedClientSeq,
          durableClientSeq: err.durableClientSeq,
        });
      }
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
      const creditedSession = await store.addPause(id, credited.creditedSeconds);
      // The runtime's clock has to see the credit too, or the wrap-up rule
      // counts minutes the candidate did not spend.
      if (liveSessions.has(id)) liveSessions.set(id, creditedSession);
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

    if (!realtimeCircuit.tryAcquire()) {
      return reply.code(503).header("Retry-After", "60").send({
        error: "REALTIME_CIRCUIT_OPEN",
        message: "Voice credentials are temporarily unavailable. Retry shortly.",
      });
    }

    if (!mintLimiter.take(id)) {
      realtimeCircuit.release();
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
      // Continuity comes from what this server stored for THIS session id.
      const storedHandle = resumption.get(id);
      const credential = await opts.realtimeTokenMinter.mint({
        tone: session.interviewerTone ?? "NORMAL",
        ...(storedHandle ? { resumptionHandle: storedHandle } : {}),
      });
      realtimeCircuit.success();

      app.log.info(
        {
          sessionId: id,
          traceId: session.traceId,
          model: credential.model,
          expiresAt: credential.expiresAt,
          mints: mintLimiter.used(id),
          resumed: Boolean(storedHandle),
        },
        "minted realtime credential",
      );

      return reply.code(201).send(credential);
    } catch (err) {
      const kind = err instanceof RealtimeTokenError ? err.kind : "PROVIDER_ERROR";

      realtimeCircuit.failure(kind === "RATE_LIMITED");
      if (realtimeCircuit.state() === "OPEN") opts.onRealtimeCircuitOpen?.(id, kind);
      // Provider bodies can contain request fragments. Keep routine diagnostics
      // to an opaque session id and typed failure kind.
      app.log.error({ sessionId: id, kind }, "realtime token mint failed");

      // A handle the provider will not accept would fail every retry the same
      // way. Drop it so the next attempt opens a fresh provider session; the
      // interview itself is unaffected, only the carried audio context.
      resumption.clear(id);

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
  /**
   * The browser reports the provider's latest resumption handle (I04-2).
   *
   * Report-only. Nothing here decides which handle a credential is minted with;
   * that is read from this session's own stored entry at mint time. Ownership is
   * enforced by the API access-control hook, so a handle can only be written
   * against a session the caller owns. The browser still supplies the opaque
   * value; the important boundary here is that another account cannot write it
   * and the later mint request cannot substitute a different value.
   */
  app.post("/interview-sessions/:id/voice-resumption", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = VoiceResumptionBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "INVALID_BODY" });

    const session = await store.get(id);
    if (!session) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
    if (session.endedAt) {
      // An ended session must not be resumable. Drop anything still held.
      resumption.clear(id);
      return reply.code(409).send({ error: "SESSION_ENDED" });
    }

    resumption.record(id, body.data.handle);
    return reply.send({ ok: true });
  });

  app.post("/interview-sessions/:id/voice-ready", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await store.get(id);
    if (!session) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
    if (session.endedAt) return reply.code(409).send({ error: "SESSION_ENDED" });

    const started = (await eventLog.read(id)).find((e) => e.type === "SESSION_STARTED");
    if (!started) return reply.code(409).send({ error: "NO_SESSION_STARTED" });

    // Idempotent by construction: the gate only authorizes the brief while
    // briefDeliveryCount is 0, so a retried call decides STAY_SILENT.
    await dispatch(started, true);
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

    await runtime.markSpeechFinished();
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

    const scenario = await store.pinnedScenario(session.id);
    const runtime = runtimes.get(id);
    if (!scenario || !runtime) {
      // No live orchestrator means no authorization to check against, and an
      // unchecked tool call is exactly what this surface exists to prevent.
      return reply.code(409).send({ error: "NO_LIVE_SESSION" });
    }

    const voice = runtime.voiceContext();
    const deliveryToken = await owners?.ensure(id);
    if (owners && (!deliveryToken || runtimes.get(id) !== runtime)) {
      return reply.code(409).send({ error: "RUNTIME_OWNERSHIP_LOST" });
    }

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
            ...(deliveryToken ? { runtimeToken: deliveryToken } : {}),
          });
        },
      },
    );

    if (deliveryToken && !await owners!.verify(id, deliveryToken)) {
      return reply.code(409).send({ error: "RUNTIME_OWNERSHIP_LOST" });
    }
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
