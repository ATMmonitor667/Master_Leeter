import { randomUUID } from "node:crypto";
import type { InterviewState } from "@master-leeter/contracts";
import { INITIAL_STATE, policyFor } from "../orchestrator/index.js";
import type { QueryClient } from "./pg-event-log.js";
import { SessionNotFoundError, type CreateSessionRequest, type InterviewSession, type SessionStore } from "./session-store.js";
import type { LoadedScenario } from "../scenario/loader.js";

type Row = {
  id: string; user_id: string; scenario_version_id: string; scenario_hash: string;
  mode: InterviewSession["mode"]; policy: InterviewSession["policy"];
  state: InterviewState; language: string; trace_id: string;
  interviewer_tone: NonNullable<InterviewSession["interviewerTone"]>;
  created_at: Date | string; started_at: Date | string | null; ended_at: Date | string | null;
  expected_seconds: number; paused_seconds: number;
  deleted_at: Date | string | null;
};
const iso = (value: Date | string) => new Date(value).toISOString();
function session(row: Row): InterviewSession {
  return {
    id: row.id, userId: row.user_id, scenarioVersionId: row.scenario_version_id,
    scenarioHash: row.scenario_hash, mode: row.mode, policy: row.policy,
    state: row.state, language: row.language, interviewerTone: row.interviewer_tone, traceId: row.trace_id,
    createdAt: iso(row.created_at), startedAt: row.started_at ? iso(row.started_at) : null,
    endedAt: row.ended_at ? iso(row.ended_at) : null,
    expectedSeconds: row.expected_seconds, pausedSeconds: row.paused_seconds,
  };
}

/** Repository foundation only: server wiring/replay/privacy remain separate gates. */
export class PgSessionStore implements SessionStore {
  constructor(private readonly db: QueryClient) {}

  async create(req: CreateSessionRequest): Promise<InterviewSession> {
    const prior = await this.findByIdempotencyKey(req.userId, req.idempotencyKey);
    if (prior) return prior;
    if (req.scenario.version.status !== "ACTIVE") throw new Error("SCENARIO_NOT_ACTIVE");
    const result = await this.db.query<Row>(`
      INSERT INTO public.interview_sessions
      (id, user_id, scenario_version_id, scenario_hash, mode, policy, state,
       language, interviewer_tone, trace_id, expected_seconds, idempotency_key, scenario_snapshot)
      VALUES ($1::uuid,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13::jsonb)
      ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *`, [
      randomUUID(), req.userId, req.scenario.version.id, req.scenario.contentHash,
      req.mode, JSON.stringify(policyFor(req.mode)), INITIAL_STATE,
      req.language ?? "python", req.interviewerTone ?? "NORMAL", randomUUID(),
      req.expectedSeconds ?? req.scenario.version.target.expectedMinutes * 60,
      req.idempotencyKey, JSON.stringify(req.scenario),
    ]);
    if (result.rows[0]) return session(result.rows[0]);
    // A separate statement sees the winner after an ON CONFLICT wait under
    // READ COMMITTED. A same-statement fallback SELECT can miss that winner.
    const winner = await this.findByIdempotencyKey(req.userId, req.idempotencyKey);
    if (!winner) throw new Error("SESSION_CREATE_CONFLICT");
    return winner;
  }

  async findByIdempotencyKey(userId: string, key: string): Promise<InterviewSession | null> {
    const { rows } = await this.db.query<Row>("SELECT * FROM public.interview_sessions WHERE user_id=$1 AND idempotency_key=$2 AND deleted_at IS NULL", [userId, key]);
    return rows[0] ? session(rows[0]) : null;
  }

  async get(id: string): Promise<InterviewSession | null> {
    const { rows } = await this.db.query<Row>("SELECT * FROM public.interview_sessions WHERE id=$1::uuid AND deleted_at IS NULL", [id]);
    return rows[0] ? session(rows[0]) : null;
  }

  async dueForCompletion(at = new Date().toISOString(), limit = 100): Promise<InterviewSession[]> {
    const { rows } = await this.db.query<Row>(`
      SELECT * FROM public.interview_sessions
      WHERE deleted_at IS NULL AND ended_at IS NULL AND started_at IS NOT NULL
        AND started_at + ((expected_seconds + paused_seconds) * interval '1 second') <= $1::timestamptz
      ORDER BY started_at ASC
      LIMIT $2`, [at, limit]);
    return rows.map(session);
  }

  async expiredEnded(before: string, limit = 100): Promise<InterviewSession[]> {
    const { rows } = await this.db.query<Row>(`SELECT * FROM public.interview_sessions
      WHERE deleted_at IS NULL AND ended_at IS NOT NULL AND ended_at<=$1::timestamptz
      ORDER BY ended_at,id LIMIT $2`, [before,limit]);
    return rows.map(session);
  }

  async idsForUser(userId: string): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>("SELECT id FROM public.interview_sessions WHERE user_id=$1 AND deleted_at IS NULL ORDER BY created_at,id", [userId]);
    return rows.map((row) => row.id);
  }

  async listForUser(
    userId: string,
    limit: number,
    before?: { createdAt: string; id: string },
  ): Promise<InterviewSession[]> {
    const { rows } = await this.db.query<Row>(`
      SELECT * FROM public.interview_sessions
      WHERE user_id=$1 AND deleted_at IS NULL
        AND ($2::timestamptz IS NULL OR (created_at,id) < ($2::timestamptz,$3::uuid))
      ORDER BY created_at DESC,id DESC
      LIMIT $4`, [userId, before?.createdAt ?? null, before?.id ?? null, limit]);
    return rows.map(session);
  }

  async scenarioVersionIdsForUser(userId: string): Promise<string[]> {
    const { rows } = await this.db.query<{ scenario_version_id: string }>(
      "SELECT DISTINCT scenario_version_id FROM public.interview_sessions WHERE user_id=$1 AND deleted_at IS NULL",
      [userId],
    );
    return rows.map((row) => row.scenario_version_id);
  }

  /** Private server-only pin; never put this object in a browser response. */
  async pinnedScenario(id: string): Promise<LoadedScenario | null> {
    const { rows } = await this.db.query<{ scenario_snapshot: LoadedScenario | null }>(
      "SELECT scenario_snapshot FROM public.interview_sessions WHERE id=$1::uuid AND deleted_at IS NULL", [id]);
    return rows[0]?.scenario_snapshot ?? null;
  }

  async end(id: string, at = new Date().toISOString()): Promise<InterviewSession> {
    return this.update(id, `UPDATE public.interview_sessions SET
      ended_at=COALESCE(ended_at,$2::timestamptz), state='EVALUATION'
      WHERE id=$1::uuid AND deleted_at IS NULL RETURNING *`, [id, at]);
  }

  async transition(id: string, state: InterviewState): Promise<InterviewSession> {
    return this.update(id, `UPDATE public.interview_sessions SET
      state=CASE WHEN ended_at IS NULL THEN $2 ELSE state END,
      started_at=CASE WHEN ended_at IS NULL THEN COALESCE(started_at,now()) ELSE started_at END
      WHERE id=$1::uuid AND deleted_at IS NULL RETURNING *`, [id, state]);
  }

  async addPause(id: string, seconds: number): Promise<InterviewSession> {
    if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error("INVALID_PAUSE");
    return this.update(id, `UPDATE public.interview_sessions SET
      paused_seconds=paused_seconds + CASE WHEN ended_at IS NULL THEN $2::integer ELSE 0 END
      WHERE id=$1::uuid AND deleted_at IS NULL RETURNING *`, [id, seconds]);
  }

  async tombstone(id: string, at = new Date().toISOString()): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      "UPDATE public.interview_sessions SET deleted_at=COALESCE(deleted_at,$2::timestamptz) WHERE id=$1::uuid RETURNING id",
      [id, at],
    );
    if (!result.rows[0]) throw new SessionNotFoundError(id);
    return true;
  }

  private async update(id: string, sql: string, values: unknown[]): Promise<InterviewSession> {
    const { rows } = await this.db.query<Row>(sql, values);
    if (!rows[0]) throw new SessionNotFoundError(id);
    return session(rows[0]);
  }
}
