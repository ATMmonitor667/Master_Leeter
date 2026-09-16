import type { ReportJobStore } from "../report/report-store.js";
import type { InterviewState } from "@master-leeter/contracts";
import { PgReportJobStore } from "../report/pg-report-store.js";
import type { CreateSessionRequest, InterviewSession } from "./session-store.js";
import { PgSessionStore } from "./pg-session-store.js";
import { PgEventLog, type QueryClient, type TransactionPool } from "./pg-event-log.js";
import { FinalInputsPendingError, type SessionLifecycle } from "./lifecycle.js";
import { assertRuntimeOwner } from "./runtime-ownership.js";
import { AdmissionError, type SessionAdmissionPolicy } from "../admission/index.js";

export class PgSessionLifecycle implements SessionLifecycle {
  constructor(
    private readonly db: TransactionPool,
    private readonly now = () => new Date().toISOString(),
    private readonly admission?: SessionAdmissionPolicy,
  ) {}

  async createStarted(req: CreateSessionRequest): Promise<InterviewSession> {
    return this.transaction(async (connection) => {
      const sessions = new PgSessionStore(connection);
      const existing = await sessions.findByIdempotencyKey(req.userId, req.idempotencyKey);
      if (existing) return existing;
      if (this.admission) await this.assertAdmission(connection, req.userId, this.admission);
      const session = await sessions.create(req);
      await new PgEventLog(this.db).appendInTransaction(connection, {
        sessionId: session.id,
        type: "SESSION_STARTED",
        actor: "SYSTEM",
        scenarioVersionId: session.scenarioVersionId,
        payload: { mode: session.mode, language: session.language, scenarioHash: session.scenarioHash,
          interviewerTone: session.interviewerTone ?? "NORMAL", expectedSeconds: session.expectedSeconds },
        traceId: session.traceId,
        idempotencyKey: `session-started:${session.id}`,
      });
      return session;
    });
  }

  /** Serialize paid-session admission across every API replica. */
  private async assertAdmission(db: QueryClient, userId: string, policy: SessionAdmissionPolicy): Promise<void> {
    if (!policy.enabled) throw new AdmissionError("ADMISSION_PAUSED");
    // Transaction-scoped and constant across the deployment. Counts and insert
    // happen under the same lock, so two replicas cannot both claim the last slot.
    await db.query("SELECT pg_advisory_xact_lock(506205347141724092::bigint)");
    const result = await db.query<{ active: number; monthly: number; user_active: boolean }>(`
      SELECT
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND ended_at IS NULL)::integer AS active,
        COUNT(*) FILTER (WHERE user_id=$1 AND created_at >=
          (date_trunc('month',$2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))::integer AS monthly,
        COALESCE(bool_or(user_id=$1 AND deleted_at IS NULL AND ended_at IS NULL),false) AS user_active
      FROM public.interview_sessions`, [userId, this.now()]);
    const usage = result.rows[0];
    if (!usage) throw new Error("ADMISSION_QUERY_FAILED");
    if (usage.user_active) throw new AdmissionError("ACTIVE_SESSION_EXISTS");
    if (usage.active >= policy.maxActiveInterviews) throw new AdmissionError("GLOBAL_CAPACITY_REACHED");
    if (usage.monthly >= policy.monthlyInterviewsPerUser) throw new AdmissionError("MONTHLY_QUOTA_REACHED");
  }

  async endWithReport(sessionId: string, rubricId: string, at = this.now(), expectedClientSeq = -1): Promise<InterviewSession> {
    return this.transaction(async (connection) => {
      await connection.query("SELECT id FROM public.interview_sessions WHERE id=$1::uuid FOR UPDATE", [sessionId]);
      const durable = await connection.query<{ max: number | null }>(
        "SELECT MAX(client_seq) AS max FROM public.session_events WHERE session_id=$1::uuid",
        [sessionId],
      );
      const durableClientSeq = durable.rows[0]?.max ?? -1;
      if (durableClientSeq < expectedClientSeq) {
        throw new FinalInputsPendingError(expectedClientSeq, durableClientSeq);
      }
      const sessions = new PgSessionStore(connection);
      const session = await sessions.end(sessionId, at);
      await new PgEventLog(this.db).appendInTransaction(connection, {
        sessionId: session.id,
        type: "SESSION_ENDED",
        actor: "SYSTEM",
        scenarioVersionId: session.scenarioVersionId,
        payload: { sealedClientSeq: durableClientSeq },
        traceId: session.traceId,
        idempotencyKey: `session-ended:${session.id}`,
      });
      const reports: ReportJobStore = new PgReportJobStore(connection);
      await reports.enqueue(session.id, rubricId, at);
      return session;
    });
  }

  async transitionWithEvent(sessionId: string, from: InterviewState, to: InterviewState, reason: string, runtimeToken?: string): Promise<InterviewSession> {
    return this.transaction(async (connection) => {
      await connection.query("SELECT id FROM public.interview_sessions WHERE id=$1::uuid FOR UPDATE", [sessionId]);
      if (runtimeToken) await assertRuntimeOwner(connection, sessionId, runtimeToken);
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
