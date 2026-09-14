import type { QueryClient } from "./pg-event-log.js";

export interface PendingRuntimeInput { sessionId: string; inputSeq: number }

/** Unresolved inputs can already have partial outputs; callers must reconcile. */
export class PgRuntimeInputs {
  constructor(private readonly db: QueryClient) {}

  async pending(limit = 100): Promise<PendingRuntimeInput[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("INVALID_INPUT_LIMIT");
    const result = await this.db.query<{ session_id: string; input_seq: number }>(
      `SELECT i.session_id,i.input_seq FROM public.runtime_inputs i
       JOIN public.interview_sessions s ON s.id=i.session_id
       WHERE i.completed_at IS NULL AND s.deleted_at IS NULL AND s.ended_at IS NULL
       ORDER BY s.created_at,i.session_id,i.input_seq LIMIT $1`, [limit],
    );
    return result.rows.map((row) => ({ sessionId: row.session_id, inputSeq: row.input_seq }));
  }
}
