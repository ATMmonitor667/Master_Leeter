import type { InterviewState } from "@master-leeter/contracts";
import type { EventLog } from "./event-log.js";
import type { CreateSessionRequest, InterviewSession, SessionStore } from "./session-store.js";

export interface SessionLifecycle {
  createStarted(req: CreateSessionRequest): Promise<InterviewSession>;
  endWithReport(sessionId: string, rubricId: string, at?: string): Promise<InterviewSession>;
  transitionWithEvent(sessionId: string, from: InterviewState, to: InterviewState, reason: string, runtimeToken?: string): Promise<InterviewSession>;
}

/** Local/test composition. Durable implementations provide real transactions. */
export class InMemorySessionLifecycle implements SessionLifecycle {
  constructor(
    private readonly sessions: SessionStore,
    private readonly events: EventLog,
    private readonly enqueueReport: (sessionId: string, rubricId: string) => Promise<unknown>,
  ) {}

  async createStarted(req: CreateSessionRequest): Promise<InterviewSession> {
    const session = await this.sessions.create(req);
    await this.events.append({
      sessionId: session.id,
      type: "SESSION_STARTED",
      actor: "SYSTEM",
      scenarioVersionId: session.scenarioVersionId,
      payload: { mode: session.mode, language: session.language, scenarioHash: session.scenarioHash },
      traceId: session.traceId,
      idempotencyKey: `session-started:${session.id}`,
    });
    return session;
  }

  async endWithReport(sessionId: string, rubricId: string, at?: string): Promise<InterviewSession> {
    const session = await this.sessions.end(sessionId, at);
    await this.events.append({
      sessionId: session.id,
      type: "SESSION_ENDED",
      actor: "SYSTEM",
      scenarioVersionId: session.scenarioVersionId,
      payload: {},
      traceId: session.traceId,
      idempotencyKey: `session-ended:${session.id}`,
    });
    await this.enqueueReport(session.id, rubricId);
    return session;
  }

  async transitionWithEvent(sessionId: string, from: InterviewState, to: InterviewState, reason: string): Promise<InterviewSession> {
    const current = await this.sessions.get(sessionId);
    if (!current || current.state !== from) throw new Error("STALE_SESSION_STATE");
    const session = await this.sessions.transition(sessionId, to);
    await this.events.append({
      sessionId,
      type: "STATE_TRANSITIONED",
      actor: "SYSTEM",
      scenarioVersionId: session.scenarioVersionId,
      payload: { from, to, reason },
      traceId: session.traceId,
      idempotencyKey: `stage:${to}`,
    });
    return session;
  }
}
