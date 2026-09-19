import { randomUUID } from "node:crypto";
import type { QueryClient } from "../session/pg-event-log.js";
import type { DeletionReceipt } from "./deletion.js";
import type { DeletionClaim, DeletionRecord, DeletionStore, NewDeletion } from "./deletion-store.js";

type Row = { id: string; dedupe_key: string; scope: "SESSION" | "ACCOUNT"; reason: DeletionRecord["reason"];
  user_id: string; session_ids: string[]; requested_at: Date | string; completed_at: Date | string | null;
  receipt: DeletionReceipt | null; lease_token?: string };
const record = (row: Row): DeletionRecord => ({ id: row.id, dedupeKey: row.dedupe_key, scope: row.scope,
  reason: row.reason, userId: row.user_id, sessionIds: row.session_ids, requestedAt: new Date(row.requested_at).toISOString(),
  completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null, receipt: row.receipt });

export class PgDeletionStore implements DeletionStore {
  constructor(private readonly db: QueryClient) {}
  async enqueue(input: NewDeletion): Promise<DeletionRecord> {
    const id = randomUUID();
    await this.db.query(`INSERT INTO public.privacy_deletion_requests
      (id,dedupe_key,scope,reason,user_id,session_ids,requested_at)
      VALUES ($1::uuid,$2,$3,$4,$5,$6::uuid[],$7::timestamptz)
      ON CONFLICT DO NOTHING`, [id,input.dedupeKey,input.scope,input.reason,input.userId,input.sessionIds,input.requestedAt]);
    const result = await this.db.query<Row>("SELECT * FROM public.privacy_deletion_requests WHERE dedupe_key=$1", [input.dedupeKey]);
    if (result.rows[0]) return record(result.rows[0]);
    const pending = input.scope === "ACCOUNT" ? await this.pendingForUser(input.userId) : null;
    if (!pending) throw new Error("DELETION_ENQUEUE_FAILED");
    return pending;
  }
  async claim(id: string, leaseMs: number): Promise<DeletionClaim | null> {
    const token = randomUUID();
    const result = await this.db.query<Row>(`UPDATE public.privacy_deletion_requests SET
      lease_token=$2::uuid,lease_expires_at=now()+($3::integer*interval '1 millisecond')
      WHERE id=$1::uuid AND completed_at IS NULL AND (lease_token IS NULL OR lease_expires_at<=now()) RETURNING *`, [id,token,leaseMs]);
    return result.rows[0] ? { ...record(result.rows[0]), token } : null;
  }
  async pendingForUser(userId: string): Promise<DeletionRecord | null> {
    const result = await this.db.query<Row>(`SELECT * FROM public.privacy_deletion_requests
      WHERE scope='ACCOUNT' AND user_id=$1 AND completed_at IS NULL ORDER BY requested_at,id LIMIT 1`, [userId]);
    return result.rows[0] ? record(result.rows[0]) : null;
  }
  async recoverable(limit: number, leaseMs: number): Promise<DeletionClaim[]> {
    const token = randomUUID();
    const result = await this.db.query<Row>(`WITH candidates AS (
      SELECT id FROM public.privacy_deletion_requests WHERE completed_at IS NULL
        AND (lease_token IS NULL OR lease_expires_at<=now()) ORDER BY requested_at,id FOR UPDATE SKIP LOCKED LIMIT $1
    ) UPDATE public.privacy_deletion_requests d SET lease_token=$2::uuid,
      lease_expires_at=now()+($3::integer*interval '1 millisecond') FROM candidates c
      WHERE d.id=c.id RETURNING d.*`, [limit,token,leaseMs]);
    return result.rows.map((row) => ({ ...record(row), token }));
  }
  async complete(id: string, token: string, receipt: DeletionReceipt): Promise<void> {
    const result = await this.db.query<{ id: string }>(`UPDATE public.privacy_deletion_requests SET
      completed_at=now(),receipt=$3::jsonb,lease_token=NULL,lease_expires_at=NULL
      WHERE id=$1::uuid AND lease_token=$2::uuid AND completed_at IS NULL RETURNING id`, [id,token,JSON.stringify(receipt)]);
    if (!result.rows[0]) throw new Error("DELETION_CLAIM_LOST");
  }
  async release(id: string, token: string): Promise<void> {
    await this.db.query(`UPDATE public.privacy_deletion_requests SET lease_token=NULL,lease_expires_at=NULL
      WHERE id=$1::uuid AND lease_token=$2::uuid AND completed_at IS NULL`, [id,token]);
  }
}
