import {
  ChatTurnInputSchema, HINTS_BY_STYLE, InterviewFormatSchema, InterviewMinutesSchema, InterviewStyleSchema,
  LiveEventBatchSchema, MAX_CHAT_TURNS, MAX_REVIEW_TURNS, ReviewInputSchema,
  type LiveEvent, type ReviewTurn, type RoomSnapshot, type RunReport, type SessionEvent,
} from "@master-leeter/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { GeminiClient } from "../../lib/gemini.js";
import { AdmissionError } from "../admission/index.js";
import { userIdFor } from "../auth/index.js";
import type { PreparationStore } from "../preparation/store.js";
import type { PreferredRunner } from "../runner/index.js";
import type { EventLog } from "../session/event-log.js";
import type { SessionLifecycle } from "../session/lifecycle.js";
import { remainingSeconds, SessionNotFoundError, type InterviewSession, type SessionStore } from "../session/session-store.js";
import { LiveCredentialError, type LiveMinter } from "./live.js";
import { MODE_FOR_STYLE, snapshotFor, TONE_FOR_STYLE, type LivePin } from "./pin.js";
import { PastedProblemError, publicProblem, reskin, specFromPaste, type BankEntry } from "./problem.js";
import { interviewerPrompt } from "./prompt.js";
import type { Professor } from "./review.js";
import { conversationOf, hasStarted, hintsUsed, latestCode, latestNotes, latestRun, transcriptOf } from "./transcript.js";

/**
 * Interview routes.
 *
 *   POST /interview-sessions            create a session: reskin and pin the problem
 *   GET  /interview-sessions/:id        everything the room needs to render or restore
 *   POST /interview-sessions/:id/live   mint a live voice credential (prompt pinned inside)
 *   POST /interview-sessions/:id/events batch of transcript / code / cue events (append-only)
 *   POST /interview-sessions/:id/chat   one chat turn, streamed
 *   POST /interview-sessions/:id/runs   run the candidate's code against the tests
 *   POST /interview-sessions/:id/end    end, and queue the report
 *
 * None of these sit on the speaking path. During a spoken exchange the browser
 * talks to the realtime model directly; if this server is slow or restarting,
 * the conversation continues and only the transcript upload retries.
 */

export interface InterviewModuleOptions {
  store: SessionStore;
  eventLog: EventLog;
  lifecycle?: SessionLifecycle;
  evaluationQueue?: { enqueue(sessionId: string, rubricId: string): Promise<unknown> };
  bank: BankEntry[];
  preparations: PreparationStore;
  runner: PreferredRunner;
  /** Rewrites the problem at session creation. Absent: the source wording is used. */
  reskinClient?: GeminiClient;
  chatClient?: GeminiClient;
  professor?: Professor;
  liveMinter?: LiveMinter | null;
  onCompletionDiscoveryFailure?: (consecutiveFailures: number) => void;
}

const RUBRIC = "rubric-coding-v1";
const MAX_LIVE_MINTS = 40;

const CreateBody = z.object({
  format: InterviewFormatSchema.default("VOICE"),
  style: InterviewStyleSchema.default("NEUTRAL"),
  minutes: InterviewMinutesSchema.default(45),
  language: z.literal("python").default("python"),
  problemRef: z.string().max(40).optional(),
  difficulty: z.enum(["EASY", "MEDIUM", "HARD"]).optional(),
  topic: z.string().max(40).optional(),
  pastedProblem: z.string().trim().min(40).max(12_000).optional(),
  preparationId: z.string().uuid().optional(),
}).strict();

const RunBody = z.object({ source: z.string().max(100_000), revision: z.number().int().nonnegative() }).strict();
const LiveBody = z.object({ resumptionHandle: z.string().min(1).max(16_384).optional() }).strict();
const ListQuery = z.object({ cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();
const Cursor = z.object({ createdAt: z.string().datetime(), id: z.string().uuid() }).strict();

const formatOf = (session: InterviewSession) => session.live?.format ?? (session.legacyChat ? "CHAT" : "VOICE");

export async function registerInterviewModule(app: FastifyInstance, opts: InterviewModuleOptions): Promise<void> {
  const { store, eventLog } = opts;
  const mints = new Map<string, number>();
  const chatInFlight = new Set<string>();
  const finalizing = new Map<string, Promise<InterviewSession>>();

  async function append(session: InterviewSession, type: SessionEvent["type"], actor: SessionEvent["actor"],
    payload: Record<string, unknown>, idempotencyKey: string, occurredAt?: string) {
    return eventLog.append({
      sessionId: session.id, type, actor, scenarioVersionId: session.scenarioVersionId, payload,
      traceId: session.traceId, idempotencyKey, ...(occurredAt ? { occurredAt } : {}),
    });
  }

  /** The interview clock starts at the first START cue, not at creation. */
  async function startClock(session: InterviewSession): Promise<InterviewSession> {
    if (session.startedAt || session.endedAt) return session;
    return store.transition(session.id, "CLARIFICATION");
  }

  async function finalize(id: string): Promise<InterviewSession> {
    const existing = finalizing.get(id);
    if (existing) return existing;
    const work = (async () => {
      const before = await store.get(id);
      if (!before) throw new SessionNotFoundError(id);
      if (before.endedAt) return before;
      let session: InterviewSession;
      if (opts.lifecycle) session = await opts.lifecycle.endWithReport(id, RUBRIC);
      else {
        session = await store.end(id);
        await eventLog.append({
          sessionId: id, type: "SESSION_ENDED", actor: "SYSTEM", scenarioVersionId: session.scenarioVersionId,
          payload: {}, traceId: session.traceId, idempotencyKey: `session-ended:${id}`,
        });
      }
      mints.delete(id);
      void opts.evaluationQueue?.enqueue(id, RUBRIC)
        .catch((error: unknown) => app.log.error({ sessionId: id, errorType: error instanceof Error ? error.name : typeof error }, "report enqueue failed"));
      return session;
    })().finally(() => finalizing.delete(id));
    finalizing.set(id, work);
    return work;
  }

  // Sessions whose time has run out are closed by the server, not by the browser.
  let sweeping = false;
  let sweepFailures = 0;
  const sweep = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void (async () => {
      const due = await store.dueForCompletion(new Date().toISOString());
      sweepFailures = 0;
      for (const session of due) {
        try { await finalize(session.id); }
        catch (error) {
          if (!(error instanceof SessionNotFoundError)) app.log.error({ sessionId: session.id }, "automatic completion failed");
        }
      }
    })().catch(() => {
      sweepFailures += 1;
      if (sweepFailures === 1 || sweepFailures % 12 === 0) opts.onCompletionDiscoveryFailure?.(sweepFailures);
    }).finally(() => { sweeping = false; });
  }, 5_000);
  sweep.unref();
  app.addHook("onClose", async () => { clearInterval(sweep); });

  async function snapshot(session: InterviewSession, events?: SessionEvent[]): Promise<RoomSnapshot | null> {
    const pin = session.live;
    if (!pin) return null;
    const log = events ?? await eventLog.read(session.id);
    return {
      sessionId: session.id,
      format: pin.format,
      style: pin.style,
      language: session.language,
      problem: publicProblem(pin.problem),
      started: Boolean(session.startedAt) || hasStarted(log),
      ended: Boolean(session.endedAt),
      expectedSeconds: session.expectedSeconds,
      remainingSeconds: remainingSeconds(session, Date.now()),
      hintsAllowed: HINTS_BY_STYLE[pin.style],
      hintsUsed: hintsUsed(log),
      transcript: transcriptOf(log),
      code: latestCode(log),
      notes: latestNotes(log),
      lastRun: latestRun(log),
      liveAvailable: Boolean(opts.liveMinter),
      chatAvailable: Boolean(opts.chatClient),
    };
  }

  /** Catalogue for setup: enough to choose, nothing that names the problem. */
  app.get("/problems", async () => ({
    problems: opts.bank.map((entry) => ({ ref: entry.ref, difficulty: entry.spec.difficulty, topics: entry.spec.topics })),
    pasteAvailable: Boolean(opts.reskinClient),
  }));

  app.post("/interview-sessions", async (req, reply) => {
    const body = CreateBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "INVALID_BODY", detail: body.error.issues });
    const idempotencyKey = req.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey) return reply.code(400).send({ error: "MISSING_IDEMPOTENCY_KEY" });
    const userId = userIdFor(req);
    const input = body.data;

    try {
      let session = await store.findByIdempotencyKey(userId, idempotencyKey);
      if (!session) {
        // Refuse before spending model calls on a problem nobody will see.
        const active = (await store.listForUser(userId, 20)).find((s) => !s.endedAt);
        if (active && opts.lifecycle) {
          return reply.code(409).send({ error: "ACTIVE_SESSION_EXISTS", activeSessionId: active.id,
            message: "Finish your active interview before starting another." });
        }

        let spec;
        if (input.pastedProblem) {
          spec = await specFromPaste(input.pastedProblem, opts.reskinClient);
        } else if (input.problemRef) {
          spec = opts.bank.find((entry) => entry.ref === input.problemRef)?.spec;
          if (!spec) return reply.code(404).send({ error: "UNKNOWN_PROBLEM" });
        } else {
          const seen = new Set(await store.scenarioVersionIdsForUser(userId));
          const matching = opts.bank.filter((entry) =>
            (!input.difficulty || entry.spec.difficulty === input.difficulty) &&
            (!input.topic || entry.spec.topics.includes(input.topic)));
          const pool = matching.length ? matching : opts.bank;
          const unseen = pool.filter((entry) => !seen.has(`${entry.spec.id}@1`));
          const candidates = unseen.length ? unseen : pool;
          spec = candidates[Math.floor(Math.random() * candidates.length)]?.spec;
          if (!spec) return reply.code(503).send({ error: "PROBLEM_BANK_EMPTY" });
        }

        let resumeFacts: string[] | undefined;
        if (input.preparationId) {
          const preparation = await opts.preparations.get(input.preparationId);
          if (!preparation || preparation.userId !== userId) return reply.code(404).send({ error: "UNKNOWN_PREPARATION" });
          const confirmed = new Set(preparation.confirmedFactIds);
          resumeFacts = (preparation.analysis?.facts ?? []).filter((fact) => confirmed.has(fact.id)).map((fact) => fact.claim);
        }

        const result = await reskin(spec, opts.reskinClient);
        if (result.rejected.length) {
          app.log.warn({ problem: spec.id, attempts: result.attempts, rejected: result.rejected, fallback: result.problem.fallback },
            result.problem.fallback ? "problem reskin rejected; using the source wording" : "problem reskin needed a retry");
        }
        const pin: LivePin = {
          format: input.format, style: input.style, minutes: input.minutes, problem: result.problem,
          ...(resumeFacts?.length ? { resumeFacts } : {}),
        };
        const request = {
          userId, scenario: snapshotFor(pin), mode: MODE_FOR_STYLE[input.style], language: input.language,
          interviewerTone: TONE_FOR_STYLE[input.style], idempotencyKey, expectedSeconds: input.minutes * 60,
        };
        if (opts.lifecycle) session = await opts.lifecycle.createStarted(request);
        else {
          session = await store.create(request);
          await append(session, "SESSION_STARTED", "SYSTEM",
            { format: pin.format, style: pin.style, language: session.language, scenarioHash: session.scenarioHash, expectedSeconds: session.expectedSeconds },
            `session-started:${session.id}`);
        }
      }
      return reply.code(201).send({ sessionId: session.id, format: formatOf(session), expectedSeconds: session.expectedSeconds });
    } catch (error) {
      if (error instanceof PastedProblemError) {
        return reply.code(error.code === "UNREADABLE" ? 422 : 503).send({
          error: `PASTED_PROBLEM_${error.code}`,
          message: error.code === "UNREADABLE"
            ? "That problem could not be turned into an interview. Include the full statement and at least one example."
            : "Pasted problems need the text model, which is not available right now.",
        });
      }
      if (error instanceof AdmissionError) {
        const status = error.code === "ACTIVE_SESSION_EXISTS" ? 409 : error.code === "ADMISSION_PAUSED" ? 503 : 429;
        return reply.code(status).send({ error: error.code, message: error.code === "ACTIVE_SESSION_EXISTS"
          ? "Finish your active interview before starting another."
          : error.code === "MONTHLY_QUOTA_REACHED" ? "Your interview allowance has been used for this month."
            : "Interview capacity is temporarily unavailable. Please retry later." });
      }
      req.log.error({ errorType: error instanceof Error ? error.name : typeof error }, "interview creation failed");
      return reply.code(409).send({ error: "CANNOT_CREATE", message: "Unable to create the interview. Please retry." });
    }
  });

  app.get("/interview-sessions", async (req, reply) => {
    const query = ListQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "INVALID_SESSION_LIST" });
    let before: z.infer<typeof Cursor> | undefined;
    if (query.data.cursor) {
      try {
        const parsed = Cursor.safeParse(JSON.parse(Buffer.from(query.data.cursor, "base64url").toString("utf8")));
        if (!parsed.success) throw new Error("INVALID_CURSOR");
        before = parsed.data;
      } catch { return reply.code(400).send({ error: "INVALID_SESSION_CURSOR" }); }
    }
    const rows = await store.listForUser(userIdFor(req), query.data.limit + 1, before);
    const page = rows.slice(0, query.data.limit);
    const tail = page.at(-1);
    return reply.header("Cache-Control", "no-store").send({
      sessions: page.map((session) => ({
        sessionId: session.id,
        format: formatOf(session),
        style: session.live?.style ?? null,
        mode: session.mode,
        state: session.state,
        createdAt: session.createdAt,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        expectedSeconds: session.expectedSeconds,
        remainingSeconds: remainingSeconds(session, Date.now()),
      })),
      nextCursor: rows.length > query.data.limit && tail
        ? Buffer.from(JSON.stringify({ createdAt: tail.createdAt, id: tail.id })).toString("base64url") : null,
    });
  });

  app.get("/interview-sessions/:id", async (req, reply) => {
    const session = await store.get((req.params as { id: string }).id);
    if (!session) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
    const room = await snapshot(session);
    // Sessions created before the live rebuild have no pinned problem to show.
    if (!room) return reply.code(410).send({ error: "LEGACY_SESSION", ended: Boolean(session.endedAt) });
    return reply.header("Cache-Control", "no-store").send(room);
  });

  app.post("/interview-sessions/:id/live", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = LiveBody.safeParse(req.body ?? {});
    const session = await store.get(id);
    if (!session || !session.live) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
    if (!body.success) return reply.code(400).send({ error: "INVALID_BODY" });
    if (session.endedAt) return reply.code(409).send({ error: "SESSION_ENDED" });
    if (session.live.format !== "VOICE") return reply.code(409).send({ error: "NOT_A_VOICE_SESSION" });
    if (!opts.liveMinter) {
      return reply.code(503).send({ error: "LIVE_UNAVAILABLE", message: "Voice is not configured. Set REALTIME_API_KEY or GEMINI_API_KEY." });
    }
    const used = mints.get(id) ?? 0;
    if (used >= MAX_LIVE_MINTS) return reply.code(429).send({ error: "LIVE_CREDENTIAL_CAP" });
    mints.set(id, used + 1);
    try {
      const pin = session.live;
      const prompt = interviewerPrompt({
        problem: pin.problem, style: pin.style, format: "VOICE", minutes: pin.minutes,
        ...(pin.resumeFacts ? { resumeFacts: pin.resumeFacts } : {}),
      });
      // The prompt is locked inside the token. It is never part of this response.
      const credential = await opts.liveMinter.mint(prompt, body.data.resumptionHandle);
      return reply.header("Cache-Control", "no-store").send(credential);
    } catch (error) {
      const kind = error instanceof LiveCredentialError ? error.kind : "PROVIDER";
      app.log.warn({ sessionId: id, kind }, "live credential mint failed");
      return reply.code(kind === "RATE_LIMITED" ? 429 : 502).send({
        error: kind === "RATE_LIMITED" ? "LIVE_RATE_LIMITED" : "LIVE_MINT_FAILED",
        message: kind === "RATE_LIMITED" ? "The voice provider is rate limiting. Retry in a minute." : "The voice provider did not issue a credential.",
      });
    }
  });

  async function appendLive(session: InterviewSession, event: LiveEvent): Promise<InterviewSession> {
    switch (event.type) {
      case "TRANSCRIPT":
        await append(session, "TRANSCRIPT_TURN", event.speaker, { speaker: event.speaker, text: event.text, medium: "VOICE" }, `t:${event.id}`, event.at);
        return session;
      case "CODE":
        await append(session, "CODE_DELTA", "CANDIDATE", { revision: event.revision, text: event.text }, `code:${event.revision}`, event.at);
        return session;
      case "NOTES":
        await append(session, "NOTE_DELTA", "CANDIDATE", { text: event.text }, `notes:${event.id}`, event.at);
        return session;
      case "LATENCY":
        await append(session, "VOICE_LATENCY_MEASURED", "SYSTEM", { speechEndToFirstAudioMs: event.speechEndToFirstAudioMs }, `latency:${event.id}`, event.at);
        return session;
      case "CUE": {
        const started = event.kind === "START" ? await startClock(session) : session;
        await append(started, "CUE", "SYSTEM", { kind: event.kind, ...(event.n !== undefined ? { n: event.n } : {}) }, `cue:${event.id}`, event.at);
        return started;
      }
    }
  }

  app.post("/interview-sessions/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = LiveEventBatchSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_EVENTS" });
    let session = await store.get(id);
    if (!session || !session.live) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
    if (session.endedAt) return reply.code(409).send({ error: "SESSION_ENDED" });
    try {
      for (const event of body.data.events) session = await appendLive(session, event);
    } catch (error) {
      if (error instanceof Error && error.message === "SESSION_ENDED") return reply.code(409).send({ error: "SESSION_ENDED" });
      throw error;
    }
    return reply.send({ accepted: body.data.events.length, remainingSeconds: remainingSeconds(session, Date.now()) });
  });

  app.post("/interview-sessions/:id/chat", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ChatTurnInputSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_CHAT_INPUT" });
    let session = await store.get(id);
    if (!session || !session.live) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
    if (session.live.format !== "CHAT") return reply.code(409).send({ error: "NOT_A_CHAT_SESSION" });
    if (!opts.chatClient) return reply.code(503).send({ error: "CHAT_UNAVAILABLE" });
    const input = body.data;
    const pin = session.live;

    let events = await eventLog.read(id);
    const mine = (event: SessionEvent) => event.payload["requestId"] === input.requestId;
    const answered = events.find((event) => event.type === "TRANSCRIPT_TURN" && event.payload["speaker"] === "INTERVIEWER" && mine(event));

    const stream = openStream(reply);
    // A retry of a turn that already has its reply gets that reply back, once.
    if (answered) {
      stream.send({ delta: String(answered.payload["text"] ?? "") });
      stream.send({ done: true, room: await snapshot(session, events) });
      return stream.end();
    }
    if (session.endedAt) { stream.send({ error: "SESSION_ENDED" }); return stream.end(); }
    if (chatInFlight.has(id)) { stream.send({ error: "CHAT_BUSY" }); return stream.end(); }
    if (transcriptOf(events).length >= MAX_CHAT_TURNS * 2) { stream.send({ error: "CHAT_TURN_LIMIT" }); return stream.end(); }

    chatInFlight.add(id);
    try {
      if (input.code && input.code.text !== latestCode(events)?.text) {
        await append(session, "CODE_DELTA", "CANDIDATE", { revision: input.code.revision, text: input.code.text }, `code:${input.code.revision}`);
      }
      if (input.cue) {
        if (input.cue === "START") session = await startClock(session);
        const n = input.cue === "HINT" ? hintsUsed(events) + 1 : undefined;
        await append(session, "CUE", "SYSTEM", { kind: input.cue, requestId: input.requestId, ...(n ? { n } : {}) }, `chat:${input.requestId}:cue`);
      }
      if (input.text) {
        await append(session, "TRANSCRIPT_TURN", "CANDIDATE",
          { speaker: "CANDIDATE", text: input.text, medium: "CHAT", requestId: input.requestId }, `chat:${input.requestId}:c`);
      }
      events = await eventLog.read(id);

      let replyText = "";
      const system = interviewerPrompt({ problem: pin.problem, style: pin.style, format: "CHAT", minutes: pin.minutes,
        ...(pin.resumeFacts ? { resumeFacts: pin.resumeFacts } : {}) });
      // A provider hiccup before the first word is retried once; after that the
      // candidate has already seen part of a reply, so it is surfaced instead.
      for (let attempt = 1; ; attempt++) {
        try {
          for await (const piece of opts.chatClient.streamText({
            system, turns: conversationOf(events), temperature: 0.6, maxOutputTokens: 700, thinkingBudget: 0,
          })) {
            replyText += piece;
            stream.send({ delta: piece });
          }
          break;
        } catch (error) {
          if (attempt >= 2 || replyText) throw error;
          req.log.warn({ sessionId: id, kind: (error as { kind?: string }).kind }, "chat reply failed before its first word; retrying once");
          await new Promise((resolve) => setTimeout(resolve, 700));
        }
      }
      replyText = replyText.trim();
      if (!replyText) throw new Error("EMPTY_REPLY");
      await append(session, "TRANSCRIPT_TURN", "INTERVIEWER",
        { speaker: "INTERVIEWER", text: replyText, medium: "CHAT", requestId: input.requestId }, `chat:${input.requestId}:i`);
      stream.send({ done: true, room: await snapshot((await store.get(id)) ?? session) });
    } catch (error) {
      const ended = error instanceof Error && error.message === "SESSION_ENDED";
      if (!ended) {
        req.log.error({ sessionId: id, errorType: error instanceof Error ? error.name : typeof error,
          kind: (error as { kind?: string }).kind, status: (error as { status?: number }).status }, "chat turn failed");
      }
      // The candidate's message is already saved; retrying the same requestId regenerates only the reply.
      stream.send({ error: ended ? "SESSION_ENDED" : "CHAT_PROVIDER_FAILED" });
    } finally {
      chatInFlight.delete(id);
      stream.end();
    }
  });

  app.post("/interview-sessions/:id/runs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = RunBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_BODY" });
    const session = await store.get(id);
    if (!session || !session.live) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
    if (session.endedAt) return reply.code(409).send({ error: "SESSION_ENDED" });
    if (!opts.runner.available) {
      return reply.code(503).send({ error: "RUNNER_UNAVAILABLE", message: "Running code is not configured. Keep going; the interviewer can still read your code." });
    }
    const { source, revision } = body.data;
    await append(session, "CODE_DELTA", "CANDIDATE", { revision, text: source }, `code:${revision}`);
    await append(session, "RUN_REQUESTED", "CANDIDATE", { revision }, `run-requested:${revision}`);
    let report: RunReport;
    try { report = await opts.runner.run(session.live.problem, source, revision); }
    catch (error) {
      app.log.warn({ sessionId: id, errorType: error instanceof Error ? error.name : typeof error }, "run failed");
      return reply.code(503).send({ error: "RUNNER_UNAVAILABLE", message: "The code could not be run right now. Try again in a moment." });
    }
    // Shaped as a normalized run result so the evaluator reads it unchanged.
    await append(session, "RUN_COMPLETED", "SYSTEM", {
      runId: report.runId, language: session.language, codeRevision: revision, inputHash: "problem-tests",
      status: report.status === "PASSED" ? "PASSED" : report.status === "FAILED" ? "FAILED" : "RUNTIME_ERROR",
      exitCode: null, cpuTimeMs: 0, memoryKb: 0, stdout: report.summary, stderr: report.stderr, truncated: false,
      visibleTestsPassed: report.passed, visibleTestsTotal: report.total, method: report.method, report,
    }, `run-completed:${report.runId}`);
    return reply.send(report);
  });

  app.post("/interview-sessions/:id/end", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const session = await finalize(id);
      return reply.send({ sessionId: session.id, endedAt: session.endedAt });
    } catch (error) {
      if (error instanceof SessionNotFoundError) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
      throw error;
    }
  });

  /** The professor review. Only after the interview has ended. */
  app.get("/interview-sessions/:id/review", async (req, reply) => {
    const session = await store.get((req.params as { id: string }).id);
    if (!session) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
    const events = await eventLog.read(session.id);
    return reply.header("Cache-Control", "no-store").send({
      turns: reviewStore.get(session.id), transcript: transcriptOf(events),
      available: Boolean(opts.professor && session.endedAt && session.live),
    });
  });

  const reviewInFlight = new Set<string>();
  app.post("/interview-sessions/:id/review", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ReviewInputSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "INVALID_REVIEW_INPUT" });
    const session = await store.get(id);
    if (!session || !session.live) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
    if (!session.endedAt) return reply.code(409).send({ error: "REVIEW_NOT_AVAILABLE" });
    if (!opts.professor) return reply.code(503).send({ error: "REVIEW_UNAVAILABLE" });
    const events = await eventLog.read(id);
    const turns = reviewStore.get(id);
    const prior = turns.find((turn) => turn.requestId === body.data.requestId);
    if (prior) return reply.send({ turns });
    if (turns.length >= MAX_REVIEW_TURNS) return reply.code(409).send({ error: "REVIEW_TURN_LIMIT" });
    if (reviewInFlight.has(id)) return reply.code(409).send({ error: "REVIEW_BUSY" });
    reviewInFlight.add(id);
    try {
      const answer = await opts.professor.review({
        problem: session.live.problem, transcript: transcriptOf(events), finalCode: latestCode(events)?.text ?? "",
        lastRun: latestRun(events), hintsUsed: hintsUsed(events), review: turns, question: body.data.question,
      });
      // The event log is sealed once a session ends, so review turns are kept beside it.
      reviewStore.push(id, { requestId: body.data.requestId, question: body.data.question, reply: answer, createdAt: new Date().toISOString() });
      return reply.send({ turns: reviewStore.get(id) });
    } catch (error) {
      req.log.error({ sessionId: id, errorType: error instanceof Error ? error.name : typeof error }, "review failed");
      return reply.code(502).send({ error: "REVIEW_PROVIDER_FAILED" });
    } finally { reviewInFlight.delete(id); }
  });
}

/** Review turns for the lifetime of the process. Regenerable, so not persisted. */
const reviewStore = {
  turns: new Map<string, ReviewTurn[]>(),
  get(id: string): ReviewTurn[] { return this.turns.get(id) ?? []; },
  push(id: string, turn: ReviewTurn): void { this.turns.set(id, [...this.get(id), turn]); },
};

/** Server-sent events over the raw socket, keeping the headers earlier hooks set (CORS). */
function openStream(reply: FastifyReply) {
  reply.hijack();
  const headers: Record<string, string | number | string[]> = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) headers[name] = value;
  reply.raw.writeHead(200, { ...headers, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
  return {
    send(data: unknown): void { reply.raw.write(`data: ${JSON.stringify(data)}\n\n`); },
    end(): void { reply.raw.end(); },
  };
}
