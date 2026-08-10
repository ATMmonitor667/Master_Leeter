import type { SessionEvent } from "@master-leeter/contracts";
import { type AppendRequest, type AppendResult, type EventLog, evidenceHash } from "./event-log.js";

/**
 * Postgres-backed event log.
 *
 * UNVERIFIED against a live database — there is no Postgres in CI yet. It
 * satisfies the same conformance suite as the in-memory implementation by
 * construction, and the suite should be pointed at it the moment infra exists
 * (see event-log.test.ts). Treat green in-memory tests as evidence about the
 * contract, not about this file.
 *
 * The `seq` assignment is the part worth reading. It is computed inside the
 * INSERT rather than read-then-written, so two concurrent appends cannot both
 * observe the same max and collide — and if they somehow do, the (session_id,
 * seq) primary key rejects the loser rather than silently reordering evidence.
 */

/** Minimal shape of a `pg` Pool. Kept structural so `pg` isn't a hard dependency yet. */
export interface QueryClient {
  query<R = unknown>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
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
  INSERT INTO session_events
    (session_id, seq, occurred_at, type, actor, scenario_version_id,
     payload, evidence_hash, trace_id, idempotency_key)
  SELECT
    $1::uuid,
    COALESCE((SELECT MAX(seq) + 1 FROM session_events WHERE session_id = $1::uuid), 0),
    $2::timestamptz, $3, $4, $5, $6::jsonb, $7, $8, $9
  ON CONFLICT (session_id, idempotency_key) DO NOTHING
  RETURNING *`;

const SELECT_BY_KEY = `
  SELECT * FROM session_events
  WHERE session_id = $1::uuid AND idempotency_key = $2`;

export class PgEventLog implements EventLog {
  constructor(private readonly db: QueryClient) {}

  async append(req: AppendRequest): Promise<AppendResult> {
    const occurredAt = req.occurredAt ?? new Date().toISOString();

    const inserted = await this.db.query<EventRow>(INSERT, [
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

    // DO NOTHING fired: this key was already appended. Return the original so
    // the caller cannot tell a retry from a first attempt.
    const existing = await this.db.query<EventRow>(SELECT_BY_KEY, [req.sessionId, req.idempotencyKey]);
    const prior = existing.rows[0];
    if (!prior) {
      throw new Error(
        `Append conflicted but no prior event found for key ${req.idempotencyKey} (session ${req.sessionId})`,
      );
    }
    return { event: toEvent(prior), duplicate: true };
  }

  async read(sessionId: string, fromSeq = 0): Promise<SessionEvent[]> {
    const { rows } = await this.db.query<EventRow>(
      "SELECT * FROM session_events WHERE session_id = $1::uuid AND seq >= $2 ORDER BY seq ASC",
      [sessionId, fromSeq],
    );
    return rows.map(toEvent);
  }

  async latestSeq(sessionId: string): Promise<number> {
    const { rows } = await this.db.query<{ max: number | null }>(
      "SELECT MAX(seq) AS max FROM session_events WHERE session_id = $1::uuid",
      [sessionId],
    );
    return rows[0]?.max ?? -1;
  }
}
