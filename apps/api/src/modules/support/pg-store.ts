import { randomUUID } from "node:crypto";
import type { QueryClient } from "../session/pg-event-log.js";
import type { NewSupportIncident, SupportIncident, SupportIncidentStore } from "./store.js";

interface Row {
  id: string;
  idempotency_key: string;
  user_id: string;
  session_id: string;
  category: SupportIncident["category"];
  diagnostics: SupportIncident["diagnostics"];
  request_id: string;
  created_at: Date | string;
  expires_at: Date | string;
}

function incident(row: Row): SupportIncident {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    userId: row.user_id,
    sessionId: row.session_id,
    category: row.category,
    diagnostics: row.diagnostics,
    requestId: row.request_id,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

export class PgSupportIncidentStore implements SupportIncidentStore {
  readonly name = "support incidents" as const;
  constructor(private readonly db: QueryClient) {}

  async create(input: NewSupportIncident): Promise<SupportIncident> {
    const result = await this.db.query<Row>(`INSERT INTO public.support_incidents
      (id,idempotency_key,user_id,session_id,category,diagnostics,request_id,created_at,expires_at)
      VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5,$6::jsonb,$7,$8::timestamptz,$9::timestamptz)
      ON CONFLICT (user_id,idempotency_key) DO UPDATE SET user_id=EXCLUDED.user_id
      RETURNING *`, [
      randomUUID(), input.idempotencyKey, input.userId, input.sessionId, input.category,
      JSON.stringify(input.diagnostics), input.requestId, input.createdAt, input.expiresAt,
    ]);
    if (!result.rows[0]) throw new Error("SUPPORT_INCIDENT_WRITE_FAILED");
    return incident(result.rows[0]);
  }

  async purgeExpired(at: string): Promise<number> {
    const result = await this.db.query<{ id: string }>(
      "DELETE FROM public.support_incidents WHERE expires_at <= $1::timestamptz RETURNING id", [at]);
    return result.rows.length;
  }

  async deleteForSession(sessionId: string): Promise<number> {
    const result = await this.db.query<{ id: string }>(
      "DELETE FROM public.support_incidents WHERE session_id=$1::uuid RETURNING id", [sessionId]);
    return result.rows.length;
  }

  async deleteForUser(userId: string): Promise<number> {
    const result = await this.db.query<{ id: string }>(
      "DELETE FROM public.support_incidents WHERE user_id=$1 RETURNING id", [userId]);
    return result.rows.length;
  }
}
