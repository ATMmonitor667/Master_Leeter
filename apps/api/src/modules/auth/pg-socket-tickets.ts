import { createHash, randomBytes } from "node:crypto";
import type { TransactionPool } from "../session/pg-event-log.js";
import { AuthError, type Principal, type SocketTicketStore } from "./index.js";

interface TicketRow {
  user_id: string;
  principal_expires_at: Date | string;
  expires_at: Date | string;
}

/** Shared, single-use WebSocket tickets for multi-process API deployments. */
export class PgSocketTickets implements SocketTicketStore {
  constructor(private readonly db: TransactionPool, private readonly now = Date.now) {}

  async issue(sessionId: string, principal: Principal): Promise<string> {
    const now = this.now();
    if (principal.expiresAt <= now) throw new AuthError("UNAUTHORIZED");

    const token = randomBytes(32).toString("base64url");
    const hash = this.hash(token);
    const expiresAt = Math.min(now + 30_000, principal.expiresAt);
    const connection = await this.db.connect();
    try {
      await connection.query("BEGIN");
      // Serialize the bounded credential set across API replicas.
      await connection.query("SELECT pg_advisory_xact_lock(hashtext('master_leeter_socket_ticket_capacity'))");
      await connection.query(
        "DELETE FROM public.socket_tickets WHERE expires_at <= $1::timestamptz OR (session_id=$2::uuid AND user_id=$3)",
        [new Date(now).toISOString(), sessionId, principal.userId],
      );
      const count = await connection.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM public.socket_tickets");
      if (Number(count.rows[0]?.count ?? 0) >= 10_000) throw new AuthError("AUTH_UNAVAILABLE");
      await connection.query(
        `INSERT INTO public.socket_tickets
          (token_hash, session_id, user_id, principal_expires_at, expires_at)
         VALUES ($1,$2::uuid,$3,$4::timestamptz,$5::timestamptz)`,
        [hash, sessionId, principal.userId, new Date(principal.expiresAt).toISOString(), new Date(expiresAt).toISOString()],
      );
      await connection.query("COMMIT");
      return token;
    } catch (error) {
      try { await connection.query("ROLLBACK"); } catch { /* Preserve original error. */ }
      throw error;
    } finally {
      connection.release();
    }
  }

  async take(token: string, sessionId: string): Promise<Principal | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const result = await this.db.query<TicketRow>(
      `DELETE FROM public.socket_tickets
       WHERE token_hash=$1 AND session_id=$2::uuid
       RETURNING user_id, principal_expires_at, expires_at`,
      [this.hash(token), sessionId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const now = this.now();
    const expiresAt = new Date(row.expires_at).getTime();
    const principalExpiresAt = new Date(row.principal_expires_at).getTime();
    if (expiresAt <= now || principalExpiresAt <= now) return null;
    return { userId: row.user_id, expiresAt: principalExpiresAt };
  }

  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}
