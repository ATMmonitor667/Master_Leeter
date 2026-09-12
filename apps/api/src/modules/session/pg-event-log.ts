import type { SessionEvent } from "@master-leeter/contracts";
import { type AppendRequest, type AppendResult, type EventLog, evidenceHash } from "./event-log.js";

/**
 * Postgres-backed event log.
 *
 * UNVERIFIED against a live database — there is no Postgres in CI yet. It
 * targets the same conformance contract as the in-memory implementation; the
 * suite must run against a real database before deployment. Adapter protocol
 * tests do not establish PostgreSQL concurrency or permission guarantees.
 *
 * Appends lock the parent session row on a dedicated connection. All reads and
 * writes use that transaction, so concurrent writers serialize before reading
 * MAX(seq). An INSERT containing MAX(seq) without this lock is NOT race-safe.
 */

/** Minimal shape of a `pg` Pool. Kept structural so `pg` isn't a hard dependency yet. */
export interface QueryClient {
  query<R = unknown>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}
export interface TransactionClient extends QueryClient { release(): void }
export interface TransactionPool extends QueryClient {
  connect(): Promise<TransactionClient>;
}

interface EventRow {
  session_id: string;
  seq: number;
  occurred_at: Date | string;
  type: string;
  actor: string;
  scenario_version_id: string;
  payload: Record<string, unknown>;
  evidence_hash: string;
  trace_id: string;
}

function toEvent(row: EventRow): SessionEvent {
  return {
    sessionId: row.session_id,
    seq: row.seq,
    occurredAt: new Date(row.occurred_at).toISOString(),
    type: row.type as SessionEvent["type"],
    actor: row.actor as SessionEvent["actor"],
    scenarioVersionId: row.scenario_version_id,
    payload: row.payload,
    evidenceHash: row.evidence_hash,
    traceId: row.trace_id,
  };
}

const INSERT = `
  INSERT INTO public.session_events
    (session_id, seq, occurred_at, type, actor, scenario_version_id,
     payload, evidence_hash, trace_id, idempotency_key)
  SELECT
    $1::uuid,
    COALESCE((SELECT MAX(seq) + 1 FROM public.session_events WHERE session_id = $1::uuid), 0),
    $2::timestamptz, $3, $4, $5, $6::jsonb, $7, $8, $9
  ON CONFLICT (session_id, idempotency_key) DO NOTHING
  RETURNING *`;

const SELECT_BY_KEY = `
  SELECT * FROM public.session_events
  WHERE session_id = $1::uuid AND idempotency_key = $2`;

export class PgEventLog implements EventLog {
  constructor(private readonly db: TransactionPool) {}

  async append(req: AppendRequest): Promise<AppendResult> {
    const connection = await this.db.connect();
    try {
      await connection.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const locked = await connection.query<{ id: string; scenario_version_id: string }>(
        "SELECT id, scenario_version_id FROM public.interview_sessions WHERE id=$1::uuid FOR UPDATE", [req.sessionId]);
      if (!locked.rows[0]) throw new Error("UNKNOWN_SESSION");
      if (locked.rows[0].scenario_version_id !== req.scenarioVersionId) throw new Error("SCENARIO_PIN_MISMATCH");
      const result = await this.appendLocked(connection, req);
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      try { await connection.query("ROLLBACK"); } catch { /* Preserve original failure. */ }
      throw error;
    } finally { connection.release(); }
  }

  private async appendLocked(db: QueryClient, req: AppendRequest): Promise<AppendResult> {
    const prior = await db.query<EventRow>(SELECT_BY_KEY, [req.sessionId, req.idempotencyKey]);
    if (prior.rows[0]) return { event: toEvent(prior.rows[0]), duplicate: true };
    const occurredAt = req.occurredAt ?? new Date().toISOString();

    const inserted = await db.query<EventRow>(INSERT, [
      req.sessionId,
      occurredAt,
      req.type,
      req.actor,
      req.scenarioVersionId,
      JSON.stringify(req.payload),
      evidenceHash(req),
      req.traceId,
      req.idempotencyKey,
    ]);

    const row = inserted.rows[0];
    if (row) return { event: toEvent(row), duplicate: false };

    // A writer bypassing the parent lock can still conflict. Fail safely; the
    // transaction rolls back and a caller retry can find the committed winner.
    throw new Error("EVENT_APPEND_CONFLICT");
  }

  async read(sessionId: string, fromSeq = 0): Promise<SessionEvent[]> {
    const { rows } = await this.db.query<EventRow>(
      "SELECT * FROM public.session_events WHERE session_id = $1::uuid AND seq >= $2 ORDER BY seq ASC",
      [sessionId, fromSeq],
    );
    return rows.map(toEvent);
  }

  async latestSeq(sessionId: string): Promise<number> {
    const { rows } = await this.db.query<{ max: number | null }>(
      "SELECT MAX(seq) AS max FROM public.session_events WHERE session_id = $1::uuid",
      [sessionId],
    );
    return rows[0]?.max ?? -1;
  }
}
