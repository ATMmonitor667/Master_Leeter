import { randomUUID } from "node:crypto";
import type { QueryClient, TransactionPool } from "./pg-event-log.js";

export interface RuntimeOwnership {
  claim(sessionId: string): Promise<string | null>;
  renew(sessionId: string, token: string): Promise<boolean>;
  release(sessionId: string, token: string): Promise<void>;
}

/** Caller holds the session row lock until its evidence/state transaction ends. */
export async function assertRuntimeOwner(db: QueryClient, sessionId: string, token: string): Promise<void> {
  const result = await db.query(
    `SELECT 1 FROM public.session_runtime_owners o JOIN public.interview_sessions s ON s.id=o.session_id
     WHERE o.session_id=$1::uuid AND o.token=$2::uuid AND o.expires_at > clock_timestamp()
       AND s.deleted_at IS NULL AND s.ended_at IS NULL`,
    [sessionId, token],
  );
  if (!result.rows.length) throw new Error("RUNTIME_OWNERSHIP_LOST");
}

/** Per-process handles; the store remains authoritative. One acquisition per ID. */
export class RuntimeOwnerHandles {
  private readonly tokens = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string | null>>();
  private stopped = false;
  constructor(private readonly store: RuntimeOwnership, private readonly lost: (id: string) => void) {}

  ensure(id: string): Promise<string | null> {
    if (this.stopped) return Promise.resolve(null);
    const existing = this.pending.get(id);
    if (existing) return existing;
    const task = this.acquire(id).finally(() => this.pending.delete(id));
    this.pending.set(id, task);
    return task;
  }

  private async acquire(id: string): Promise<string | null> {
    const token = this.tokens.get(id);
    try {
      if (token) {
        if (await this.store.renew(id, token)) return token;
        this.tokens.delete(id);
        this.lost(id);
        return null;
      }
      const claimed = await this.store.claim(id);
      if (claimed) this.tokens.set(id, claimed);
      return claimed;
    } catch (error) {
      this.tokens.delete(id);
      this.lost(id);
      throw error;
    }
  }

  async heartbeat(): Promise<void> {
    await Promise.allSettled([...this.tokens.keys()].map((id) => this.ensure(id)));
  }

  async verify(id: string, token: string): Promise<boolean> {
    if (this.tokens.get(id) !== token || this.stopped) return false;
    return await this.ensure(id) === token;
  }

  async close(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.pending.values()]);
    await Promise.allSettled([...this.tokens].map(async ([id, token]) => {
      this.lost(id);
      await this.store.release(id, token);
    }));
    this.tokens.clear();
  }
}

export class PgRuntimeOwnership implements RuntimeOwnership {
  constructor(private readonly db: TransactionPool, private readonly ttlMs = 30_000) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300_000) throw new Error("INVALID_LEASE_TTL");
  }

  async claim(sessionId: string): Promise<string | null> {
    const token = randomUUID();
    const accepted = await this.locked(sessionId, async (db) => {
      const result = await db.query(
        `INSERT INTO public.session_runtime_owners (session_id,token,expires_at)
         VALUES ($1::uuid,$2::uuid,clock_timestamp()+$3::integer*interval '1 millisecond')
         ON CONFLICT (session_id) DO UPDATE SET token=EXCLUDED.token,expires_at=EXCLUDED.expires_at
         WHERE session_runtime_owners.expires_at <= clock_timestamp() RETURNING token`,
        [sessionId, token, this.ttlMs],
      );
      return result.rows.length > 0;
    });
    return accepted ? token : null;
  }

  async renew(sessionId: string, token: string): Promise<boolean> {
    return this.locked(sessionId, async (db) => {
      const result = await db.query(
        `UPDATE public.session_runtime_owners
         SET expires_at=clock_timestamp()+$3::integer*interval '1 millisecond'
         WHERE session_id=$1::uuid AND token=$2::uuid AND expires_at > clock_timestamp() RETURNING token`,
        [sessionId, token, this.ttlMs],
      );
      return result.rows.length > 0;
    });
  }

  async release(sessionId: string, token: string): Promise<void> {
    await this.db.query("DELETE FROM public.session_runtime_owners WHERE session_id=$1::uuid AND token=$2::uuid", [sessionId, token]);
  }

  private async locked(sessionId: string, work: (db: QueryClient) => Promise<boolean>): Promise<boolean> {
    const db = await this.db.connect();
    try {
      await db.query("BEGIN");
      const session = await db.query(
        "SELECT id FROM public.interview_sessions WHERE id=$1::uuid AND deleted_at IS NULL AND ended_at IS NULL FOR UPDATE", [sessionId]);
      const accepted = session.rows.length > 0 ? await work(db) : false;
      await db.query("COMMIT");
      return accepted;
    } catch (error) {
      try { await db.query("ROLLBACK"); } catch { /* Original failure wins. */ }
      throw error;
    } finally { db.release(); }
  }
}
