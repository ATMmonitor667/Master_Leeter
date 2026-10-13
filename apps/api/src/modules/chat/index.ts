import {
  ChatInputSchema, ChatReviewInputSchema, MAX_CHAT_TURNS, MAX_REVIEW_TURNS,
  type ChatReviewTurn, type ChatSnapshot, type ChatTurn, type EventType, type RunResult, type SessionEvent,
} from "@master-leeter/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { userIdFor } from "../auth/index.js";
import type { EventLog } from "../session/event-log.js";
import { remainingSeconds, type InterviewSession, type SessionStore } from "../session/session-store.js";
import type { PreparationStore } from "../preparation/store.js";
import { ResumeFactSchema, type ResumeFact } from "../preparation/types.js";
import { decideFollowUp, FOLLOW_UP_REPLIES, followUpsUsed } from "./follow-ups.js";
import { respondToSubmission, type ChatInterviewer } from "./interviewer.js";
import type { ChatProfessor } from "./professor.js";

interface Options {
  sessions: SessionStore; events: EventLog; preparations: PreparationStore;
  interviewer?: ChatInterviewer; professor?: ChatProfessor;
}
const turnsOf = (events: SessionEvent[]) => events.filter((e) => e.type === "CHAT_TURN")
  .map((e) => ({ ...e.payload, createdAt: e.occurredAt }) as unknown as ChatTurn);
const reviewOf = (events: SessionEvent[]) => events.filter((e) => e.type === "CHAT_REVIEW_TURN")
  .map((e) => ({ ...e.payload, createdAt: e.occurredAt }) as unknown as ChatReviewTurn);
/** Resume-only sessions get a saved transcript, never an invented resume score. */
const isScored = (session: InterviewSession) => session.chat?.focus !== "RESUME";

export async function registerChatModule(app: FastifyInstance, opts: Options) {
  // One provider call per session stream in this process. A retry of the
  // in-flight request (lost response, double click) joins it rather than failing.
  const pending = new Map<string, { requestId: string; work: Promise<ChatSnapshot> }>();
  const append = (session: InterviewSession, type: EventType, key: string, payload: Record<string, unknown>) =>
    opts.events.append({ sessionId: session.id, scenarioVersionId: session.scenarioVersionId,
      traceId: session.traceId, actor: "SYSTEM", type, idempotencyKey: key, payload });

  async function snapshot(session: InterviewSession): Promise<ChatSnapshot> {
    const events = await opts.events.read(session.id);
    const turns = turnsOf(events);
    const current = await opts.sessions.get(session.id);
    if (!current) throw new Error("UNKNOWN_SESSION");
    const scenario = await opts.sessions.pinnedScenario(session.id);
    const used = followUpsUsed(turns);
    const ended = Boolean(current.endedAt);
    return { sessionId: session.id, focus: session.chat!.focus,
      phase: turns.at(-1)?.phase ?? (session.chat!.focus === "CODING" ? "CODING" : "RESUME"),
      turns, nextTurn: turns.length, remainingSeconds: remainingSeconds(current, Date.now()),
      ended, available: Boolean(opts.interviewer),
      runs: events.filter((e) => e.type === "RUN_COMPLETED").map((e) => e.payload as unknown as RunResult),
      expectedSeconds: current.expectedSeconds,
      requirements: used.flatMap((id) => scenario?.version.followUps.find((f) => f.id === id)?.oralDelta ?? []),
      followUpsAvailable: Math.max(0, (scenario?.version.followUps.length ?? 0) - used.length),
      scored: isScored(current),
      review: reviewOf(events),
      reviewAvailable: ended && isScored(current) && Boolean(opts.professor) };
  }

  /**
   * Shared submission protocol for both conversation streams: idempotent on
   * requestId, ordered by turn number, serialized at the durable log key.
   */
  async function submitTurn<S extends { requestId: string; turn: number }>(req: FastifyRequest, reply: FastifyReply, spec: {
    session: InterviewSession; stream: "live" | "review"; input: { requestId: string; turn: number };
    history: S[]; reread: (events: SessionEvent[]) => S[];
    matches: (saved: S) => boolean; validate: () => string | null;
    compute: () => Promise<Record<string, unknown>>; type: EventType; key: string;
  }) {
    const { session, input, history, matches } = spec;
    const prior = history.find((t) => t.requestId === input.requestId);
    if (prior) return matches(prior) ? snapshot(session) : reply.code(409).send({ error: "CHAT_REQUEST_CONFLICT" });
    const slot = `${session.id}:${spec.stream}`;
    const inFlight = pending.get(slot);
    if (inFlight?.requestId === input.requestId) {
      try { await inFlight.work; } catch { /* The original request reports its own failure. */ }
      const saved = spec.reread(await opts.events.read(session.id)).find((t) => t.requestId === input.requestId);
      if (saved) return matches(saved) ? snapshot(session) : reply.code(409).send({ error: "CHAT_REQUEST_CONFLICT" });
      return reply.code(502).send({ error: "CHAT_PROVIDER_FAILED" });
    }
    const invalid = spec.validate();
    if (invalid) return reply.code(invalid === "CHAT_UNAVAILABLE" || invalid === "REVIEW_UNAVAILABLE" ? 503 : 409).send({ error: invalid });
    if (input.turn !== history.length) return reply.code(409).send({ error: "CHAT_STALE_TURN" });
    if (inFlight) return reply.code(409).send({ error: "CHAT_BUSY" });
    const work = (async () => {
      const response = await spec.compute();
      // A provider call can overlap end/delete. Never append a late live reply.
      const current = await opts.sessions.get(session.id);
      if (!current || (spec.stream === "live" && current.endedAt)) throw new Error("SESSION_ENDED");
      const saved = await append(session, spec.type, spec.key, { ...input, ...response });
      // The event key serializes competing tabs/replicas at the durable log.
      if (!matches(saved.event.payload as unknown as S)) throw new Error("CHAT_STALE_TURN");
      return snapshot(session);
    })();
    pending.set(slot, { requestId: input.requestId, work });
    try { return await work; }
    catch (error) {
      const code = error instanceof Error ? error.message : "";
      const known = ["CHAT_STALE_TURN", "SESSION_ENDED", "CHAT_UNAVAILABLE"];
      req.log.warn({ sessionId: session.id, stream: spec.stream, code: known.includes(code) ? code : "CHAT_PROVIDER_FAILED" }, "chat turn failed");
      return reply.code(code === "CHAT_UNAVAILABLE" ? 503 : known.includes(code) ? 409 : 502)
        .send({ error: known.includes(code) ? code : "CHAT_PROVIDER_FAILED" });
    } finally { pending.delete(slot); }
  }

  app.addHook("preHandler", async (req, reply) => {
    const id = (req.params as { id?: string }).id;
    if (!id || !z.string().uuid().safeParse(id).success) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
    const session = await opts.sessions.get(id);
    if (!session || session.userId !== userIdFor(req)) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
    if (!session.chat) return reply.code(409).send({ error: "NOT_CHAT_SESSION" });
    reply.header("Cache-Control", "no-store");
  });

  app.get("/interview-sessions/:id/chat", async (req) => {
    const session = (await opts.sessions.get((req.params as { id: string }).id))!;
    return snapshot(session);
  });

  // Explicit Start: the problem is delivered and the clock begins only here.
  app.post("/interview-sessions/:id/chat/start", async (req, reply) => {
    const session = (await opts.sessions.get((req.params as { id: string }).id))!;
    if (session.endedAt) return reply.code(409).send({ error: "SESSION_ENDED" });
    try {
      const scenario = await opts.sessions.pinnedScenario(session.id);
      if (!scenario) throw new Error("PINNED_QUESTION_UNAVAILABLE");
      const events = await opts.events.read(session.id);
      let context = events.find((e) => e.type === "CHAT_CONTEXT");
      if (!context) {
        let facts: ResumeFact[] = [];
        if (session.chat!.preparationId) {
          const prep = await opts.preparations.get(session.chat!.preparationId);
          if (prep?.userId === session.userId && prep.sessionId === session.id) {
            facts = prep.analysis?.facts.filter((f) => prep.confirmedFactIds.includes(f.id)) ?? [];
          }
        }
        if (session.chat!.focus !== "CODING" && !facts.length) throw new Error("CONFIRMED_RESUME_REQUIRED");
        context = (await append(session, "CHAT_CONTEXT", "chat-context", { facts })).event;
      }
      const facts = z.array(ResumeFactSchema).parse(context.payload["facts"]);
      const phase = session.chat!.focus === "CODING" ? "CODING" : "RESUME";
      const opening = phase === "CODING" ? scenario.version.oralBrief.openingScript
        : `Let's discuss your experience. Your resume mentions: ${facts[0]!.claim}\n\nWhat did you personally contribute, and what was one important technical decision you made?`;
      await append(session, "CHAT_TURN", "chat-turn:0", { turn: 0, requestId: "opening", kind: "OPENING",
        text: "", reply: opening, phase });
      // Starting the text conversation starts the interview clock. Idempotent.
      if (!session.startedAt) await opts.sessions.transition(session.id, "CLARIFICATION");
      return snapshot(session);
    } catch (error) {
      const code = error instanceof Error ? error.message : "CHAT_START_FAILED";
      return reply.code(409).send({ error: ["CONFIRMED_RESUME_REQUIRED", "SESSION_ENDED"].includes(code) ? code : "CHAT_START_FAILED" });
    }
  });

  app.post("/interview-sessions/:id/chat/turns", async (req, reply) => {
    const session = (await opts.sessions.get((req.params as { id: string }).id))!;
    const parsed = ChatInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_CHAT_INPUT" });
    const input = parsed.data;
    const events = await opts.events.read(session.id);
    const history = turnsOf(events);
    const phase = history.at(-1)?.phase ?? "CODING";
    return submitTurn(req, reply, {
      session, stream: "live", input, history, reread: turnsOf, type: "CHAT_TURN", key: `chat-turn:${input.turn}`,
      matches: (t) => t.requestId === input.requestId && t.kind === input.kind &&
        t.text === input.text && t.code === input.code && t.turn === input.turn,
      validate: () => {
        if (session.endedAt || remainingSeconds(session, Date.now()) <= 0) return "SESSION_ENDED";
        if (!history.length) return "CHAT_NOT_STARTED";
        if (history.length > MAX_CHAT_TURNS) return "CHAT_TURN_LIMIT";
        if (input.kind === "START_CODING" && (session.chat!.focus !== "COMBINED" || phase !== "RESUME")) return "INVALID_CHAT_PHASE";
        if (phase === "RESUME" && ["CODE", "HINT", "DONE"].includes(input.kind)) return "INVALID_CHAT_PHASE";
        return null;
      },
      compute: async () => {
        const scenario = await opts.sessions.pinnedScenario(session.id);
        if (!scenario) throw new Error("PINNED_QUESTION_UNAVAILABLE");
        if (input.kind === "START_CODING") {
          return { phase: "CODING", reply: `Thanks for walking me through your experience. Let's move to the coding problem.\n\n${scenario.version.oralBrief.openingScript}` };
        }
        if (input.kind === "DONE") {
          const decision = decideFollowUp({ scenario: scenario.version, history, events,
            remainingSeconds: remainingSeconds(session, Date.now()), now: new Date().toISOString() });
          return decision.kind === "PRESENT"
            ? { phase, reply: decision.followUp.oralDelta, followUpId: decision.followUp.id }
            : { phase, reply: FOLLOW_UP_REPLIES[decision.kind] };
        }
        const context = events.find((e) => e.type === "CHAT_CONTEXT");
        const facts = z.array(ResumeFactSchema).parse(context?.payload["facts"] ?? []);
        const requirements = followUpsUsed(history)
          .flatMap((id) => scenario.version.followUps.find((f) => f.id === id)?.oralDelta ?? []);
        return { phase, ...await respondToSubmission({ phase, scenario: scenario.version, policy: session.policy,
          tone: session.interviewerTone ?? "NORMAL", facts, history, input, requirements }, opts.interviewer) };
      },
    });
  });

  // Mode C: the professor review. Only after the interview has ended.
  app.post("/interview-sessions/:id/chat/review", async (req, reply) => {
    const session = (await opts.sessions.get((req.params as { id: string }).id))!;
    const parsed = ChatReviewInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_CHAT_INPUT" });
    const input = parsed.data;
    const events = await opts.events.read(session.id);
    const review = reviewOf(events);
    return submitTurn(req, reply, {
      session, stream: "review", input, history: review, reread: reviewOf, type: "CHAT_REVIEW_TURN", key: `chat-review:${input.turn}`,
      matches: (t) => t.requestId === input.requestId && t.kind === input.kind && t.text === input.text && t.turn === input.turn,
      validate: () => {
        if (!session.endedAt || !isScored(session)) return "REVIEW_NOT_AVAILABLE";
        if (!opts.professor) return "REVIEW_UNAVAILABLE";
        if (review.length >= MAX_REVIEW_TURNS) return "CHAT_TURN_LIMIT";
        // The debrief opens the review; questions follow it.
        if ((input.turn === 0) !== (input.kind === "DEBRIEF")) return "INVALID_CHAT_PHASE";
        return null;
      },
      compute: async () => {
        const scenario = await opts.sessions.pinnedScenario(session.id);
        if (!scenario) throw new Error("PINNED_QUESTION_UNAVAILABLE");
        const transcript = turnsOf(events).filter((t) => t.phase === "CODING");
        return opts.professor!.review({ scenario: scenario.version, transcript, review, input,
          runs: events.filter((e) => e.type === "RUN_COMPLETED").map((e) => e.payload as unknown as RunResult),
          hintsUsed: transcript.flatMap((t) => (t.hintLevel ? [t.hintLevel] : [])) });
      },
    });
  });
}
