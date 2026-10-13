import { ChatInputSchema, MAX_CHAT_TURNS, type ChatSnapshot, type ChatTurn, type SessionEvent, type RunResult } from "@master-leeter/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { userIdFor } from "../auth/index.js";
import type { EventLog } from "../session/event-log.js";
import { remainingSeconds, type InterviewSession, type SessionStore } from "../session/session-store.js";
import type { PreparationStore } from "../preparation/store.js";
import { ResumeFactSchema, type ResumeFact } from "../preparation/types.js";
import { respondToSubmission, type ChatInterviewer } from "./interviewer.js";

interface Options { sessions: SessionStore; events: EventLog; preparations: PreparationStore; interviewer?: ChatInterviewer }
const turnsOf = (events: SessionEvent[]) => events.filter((e) => e.type === "CHAT_TURN")
  .map((e) => ({ ...e.payload, createdAt: e.occurredAt }) as unknown as ChatTurn);

export async function registerChatModule(app: FastifyInstance, opts: Options) {
  // One provider call per session in this process. A retry of the in-flight
  // request (lost response, double click) joins it rather than failing.
  const pending = new Map<string, { requestId: string; work: Promise<ChatSnapshot> }>();
  const append = (session: InterviewSession, type: "CHAT_TURN" | "CHAT_CONTEXT", key: string, payload: Record<string, unknown>) =>
    opts.events.append({ sessionId: session.id, scenarioVersionId: session.scenarioVersionId,
      traceId: session.traceId, actor: "SYSTEM", type, idempotencyKey: key, payload });

  async function snapshot(session: InterviewSession): Promise<ChatSnapshot> {
    const events = await opts.events.read(session.id);
    const turns = turnsOf(events);
    const current = await opts.sessions.get(session.id);
    if (!current) throw new Error("UNKNOWN_SESSION");
    return { sessionId: session.id, focus: session.chat!.focus,
      phase: turns.at(-1)?.phase ?? (session.chat!.focus === "CODING" ? "CODING" : "RESUME"),
      turns, nextTurn: turns.length, remainingSeconds: remainingSeconds(current, Date.now()),
      ended: Boolean(current.endedAt), available: Boolean(opts.interviewer),
      runs: events.filter((e) => e.type === "RUN_COMPLETED").map((e) => e.payload as unknown as RunResult) };
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

  app.post("/interview-sessions/:id/chat/start", async (req, reply) => {
    const session = (await opts.sessions.get((req.params as { id: string }).id))!;
    if (session.endedAt) return reply.code(409).send({ error: "SESSION_ENDED" });
    try {
      const scenario = await opts.sessions.pinnedScenario(session.id);
      if (!scenario) throw new Error("PINNED_QUESTION_UNAVAILABLE");
      let events = await opts.events.read(session.id);
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
    const prior = history.find((t) => t.requestId === input.requestId);
    const matches = (t: ChatTurn) => t.requestId === input.requestId && t.kind === input.kind &&
      t.text === input.text && t.code === input.code && t.turn === input.turn;
    if (prior) return matches(prior) ? snapshot(session) : reply.code(409).send({ error: "CHAT_REQUEST_CONFLICT" });
    if (session.endedAt || remainingSeconds(session, Date.now()) <= 0) return reply.code(409).send({ error: "SESSION_ENDED" });
    if (!history.length) return reply.code(409).send({ error: "CHAT_NOT_STARTED" });
    const inFlight = pending.get(session.id);
    if (inFlight?.requestId === input.requestId) {
      try { await inFlight.work; } catch { /* The original request reports its own failure. */ }
      const saved = turnsOf(await opts.events.read(session.id)).find((t) => t.requestId === input.requestId);
      if (saved) return matches(saved) ? snapshot(session) : reply.code(409).send({ error: "CHAT_REQUEST_CONFLICT" });
      return reply.code(502).send({ error: "CHAT_PROVIDER_FAILED" });
    }
    if (input.turn !== history.length) return reply.code(409).send({ error: "CHAT_STALE_TURN" });
    if (inFlight) return reply.code(409).send({ error: "CHAT_BUSY" });
    if (history.length > MAX_CHAT_TURNS) return reply.code(409).send({ error: "CHAT_TURN_LIMIT" });
    const phase = history.at(-1)!.phase;
    if (input.kind === "START_CODING" && (session.chat!.focus !== "COMBINED" || phase !== "RESUME")) {
      return reply.code(409).send({ error: "INVALID_CHAT_PHASE" });
    }
    if (phase === "RESUME" && (input.kind === "CODE" || input.kind === "HINT")) {
      return reply.code(409).send({ error: "INVALID_CHAT_PHASE" });
    }
    const work = (async () => {
      const scenario = await opts.sessions.pinnedScenario(session.id);
      if (!scenario) throw new Error("PINNED_QUESTION_UNAVAILABLE");
      const context = events.find((e) => e.type === "CHAT_CONTEXT");
      const facts = z.array(ResumeFactSchema).parse(context?.payload["facts"] ?? []);
      const response = input.kind === "START_CODING"
        ? { reply: `Thanks for walking me through your experience. Let's move to the coding problem.

${scenario.version.oralBrief.openingScript}` }
        : await respondToSubmission({ phase, scenario: scenario.version, policy: session.policy,
          tone: session.interviewerTone ?? "NORMAL", facts, history, input }, opts.interviewer);
      // A provider call can overlap end/delete. Never append a late reply.
      const current = await opts.sessions.get(session.id);
      if (!current || current.endedAt) throw new Error("SESSION_ENDED");
      const saved = await append(session, "CHAT_TURN", `chat-turn:${input.turn}`, {
        ...input, ...response, phase: input.kind === "START_CODING" ? "CODING" : phase,
      });
      // The event key serializes competing tabs/replicas at the durable log.
      if (!matches(saved.event.payload as unknown as ChatTurn)) throw new Error("CHAT_STALE_TURN");
      return snapshot(session);
    })();
    pending.set(session.id, { requestId: input.requestId, work });
    try { return await work; }
    catch (error) {
      const code = error instanceof Error ? error.message : "";
      const known = ["CHAT_STALE_TURN", "SESSION_ENDED", "CHAT_UNAVAILABLE"];
      req.log.warn({ sessionId: session.id, code: known.includes(code) ? code : "CHAT_PROVIDER_FAILED" }, "chat turn failed");
      return reply.code(code === "CHAT_UNAVAILABLE" ? 503 : known.includes(code) ? 409 : 502)
        .send({ error: known.includes(code) ? code : "CHAT_PROVIDER_FAILED" });
    } finally { pending.delete(session.id); }
  });
}
