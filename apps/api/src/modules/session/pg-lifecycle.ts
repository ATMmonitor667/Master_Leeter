import type { ReportJobStore } from "../report/report-store.js";
import type { InterviewState } from "@master-leeter/contracts";
import { PgReportJobStore } from "../report/pg-report-store.js";
import type { CreateSessionRequest, InterviewSession } from "./session-store.js";
import { PgSessionStore } from "./pg-session-store.js";
import { PgEventLog, type TransactionPool } from "./pg-event-log.js";
import type { SessionLifecycle } from "./lifecycle.js";

export class PgSessionLifecycle implements SessionLifecycle {
  constructor(private readonly db: TransactionPool, private readonly now = () => new Date().toISOString()) {}

  async createStarted(req: CreateSessionRequest): Promise<InterviewSession> {
    return this.transaction(async (connection) => {
      const session = await new PgSessionStore(connection).create(req);
      await new PgEventLog(this.db).appendInTransaction(connection, {
        sessionId: session.id,
        type: "SESSION_STARTED",
        actor: "SYSTEM",
        scenarioVersionId: session.scenarioVersionId,
        payload: { mode: session.mode, language: session.language, scenarioHash: session.scenarioHash },
        traceId: session.traceId,
        idempotencyKey: `session-started:${session.id}`,
      });
      return session;
    });
  }

  async endWithReport(sessionId: string, rubricId: string, at = this.now()): Promise<InterviewSession> {
    return this.transaction(async (connection) => {
      const sessions = new PgSessionStore(connection);
      const session = await sessions.end(sessionId, at);
      await new PgEventLog(this.db).appendInTransaction(connection, {
        sessionId: session.id,
        type: "SESSION_ENDED",
        actor: "SYSTEM",
        scenarioVersionId: session.scenarioVersionId,
        payload: {},
        traceId: session.traceId,
        idempotencyKey: `session-ended:${session.id}`,
      });
      const reports: ReportJobStore = new PgReportJobStore(connection);
      await reports.enqueue(session.id, rubricId, at);
      return session;
    });
  }

  async transitionWithEvent(sessionId: string, from: InterviewState, to: InterviewState, reason: string): Promise<InterviewSession> {
    return this.transaction(async (connection) => {
      await connection.query("SELECT id FROM public.interview_sessions WHERE id=$1::uuid FOR UPDATE", [sessionId]);
      const sessions = new PgSessionStore(connection);
      const current = await sessions.get(sessionId);
      if (!current || current.state !== from || current.endedAt) throw new Error("STALE_SESSION_STATE");
      const session = await sessions.transition(sessionId, to);
      await new PgEventLog(this.db).appendInTransaction(connection, {
        sessionId,
        type: "STATE_TRANSITIONED",
        actor: "SYSTEM",
        scenarioVersionId: session.scenarioVersionId,
        payload: { from, to, reason },
        traceId: session.traceId,
        idempotencyKey: `stage:${to}`,
      });
      return session;
    });
  }

  private async transaction<T>(work: (connection: Awaited<ReturnType<TransactionPool["connect"]>>) => Promise<T>): Promise<T> {
    const connection = await this.db.connect();
    try {
      await connection.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const result = await work(connection);
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      try { await connection.query("ROLLBACK"); } catch { /* Preserve original error. */ }
      throw error;
    } finally {
      connection.release();
    }
  }
}
