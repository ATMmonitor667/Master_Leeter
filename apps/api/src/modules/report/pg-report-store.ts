import { randomUUID } from "node:crypto";
import type { QueryClient } from "../session/pg-event-log.js";
import type { SessionReport } from "./evaluator.js";
import type { ReportClaim, ReportJob, ReportJobStore } from "./report-store.js";

interface ReportRow {
  session_id: string;
  rubric_id: string;
  status: ReportJob["status"];
  body: SessionReport | null;
  error: string | null;
  attempts: number;
  created_at: Date | string;
  completed_at: Date | string | null;
}

const toJob = (row: ReportRow): ReportJob => ({
  sessionId: row.session_id,
  rubricId: row.rubric_id,
  status: row.status,
  report: row.body,
  error: row.error,
  attempts: row.attempts,
  queuedAt: new Date(row.created_at).toISOString(),
  completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
});

export class PgReportJobStore implements ReportJobStore {
  constructor(private readonly db: QueryClient) {}

  async enqueue(sessionId: string, rubricId: string, queuedAt: string): Promise<ReportJob> {
    const result = await this.db.query<ReportRow>(
      `INSERT INTO public.session_reports (session_id,rubric_id,status,created_at)
       VALUES ($1::uuid,$2,'QUEUED',$3::timestamptz)
       ON CONFLICT (session_id) DO UPDATE SET
         rubric_id=EXCLUDED.rubric_id,status='QUEUED',body=NULL,error=NULL,
         completed_at=NULL,lease_token=NULL,lease_expires_at=NULL,created_at=EXCLUDED.created_at
       WHERE public.session_reports.status='FAILED'
       RETURNING *`,
      [sessionId, rubricId, queuedAt],
    );
    if (result.rows[0]) return toJob(result.rows[0]);
    const existing = await this.get(sessionId);
    if (!existing) throw new Error("REPORT_ENQUEUE_CONFLICT");
    return existing;
  }

  async get(sessionId: string): Promise<ReportJob | null> {
    const result = await this.db.query<ReportRow>("SELECT * FROM public.session_reports WHERE session_id=$1::uuid", [sessionId]);
    return result.rows[0] ? toJob(result.rows[0]) : null;
  }

  async claim(sessionId: string, now: string, leaseExpiresAt: string): Promise<ReportClaim | null> {
    const token = randomUUID();
    const result = await this.db.query<ReportRow>(
      `UPDATE public.session_reports SET
         status='RUNNING',attempts=attempts+1,error=NULL,completed_at=NULL,
         lease_token=$2::uuid,lease_expires_at=$4::timestamptz
       WHERE session_id=$1::uuid AND
         (status='QUEUED' OR (status='RUNNING' AND lease_expires_at <= $3::timestamptz))
       RETURNING *`,
      [sessionId, token, now, leaseExpiresAt],
    );
    return result.rows[0] ? { token, job: toJob(result.rows[0]) } : null;
  }

  async complete(sessionId: string, token: string, report: SessionReport, completedAt: string): Promise<ReportJob | null> {
    return this.finish(sessionId, token, "READY", JSON.stringify(report), null, completedAt);
  }

  async fail(sessionId: string, token: string, error: string, completedAt: string): Promise<ReportJob | null> {
    return this.finish(sessionId, token, "FAILED", null, error.slice(0, 2_000), completedAt);
  }

  async delete(sessionId: string): Promise<boolean> {
    const result = await this.db.query<{ session_id: string }>("DELETE FROM public.session_reports WHERE session_id=$1::uuid RETURNING session_id", [sessionId]);
    return result.rows.length > 0;
  }

  private async finish(sessionId: string, token: string, status: "READY" | "FAILED", body: string | null, error: string | null, completedAt: string): Promise<ReportJob | null> {
    const result = await this.db.query<ReportRow>(
      `UPDATE public.session_reports SET
         status=$3,body=$4::jsonb,error=$5,completed_at=$6::timestamptz,
         lease_token=NULL,lease_expires_at=NULL
       WHERE session_id=$1::uuid AND lease_token=$2::uuid AND status='RUNNING'
       RETURNING *`,
      [sessionId, token, status, body, error, completedAt],
    );
    return result.rows[0] ? toJob(result.rows[0]) : null;
  }
}
