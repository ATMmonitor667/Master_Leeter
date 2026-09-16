import type { QueryClient } from "../session/pg-event-log.js";
import { ConsentGrantSchema, type ConsentGrant, type ConsentState } from "./consent.js";
import type { ConsentStore } from "./consent-store.js";

interface ConsentRow {
  scope: string;
  granted: boolean;
  decided_at: Date | string;
  notice_version: string;
}

export class PgConsentStore implements ConsentStore {
  constructor(private readonly db: QueryClient) {}

  async get(userId: string): Promise<ConsentState> {
    const result = await this.db.query<ConsentRow>(
      "SELECT scope,granted,decided_at,notice_version FROM public.consent_grants WHERE user_id=$1 ORDER BY decided_at,id",
      [userId],
    );
    const grants = result.rows.map((row) => ConsentGrantSchema.parse({
      scope: row.scope,
      granted: row.granted,
      decidedAt: new Date(row.decided_at).toISOString(),
      noticeVersion: row.notice_version,
    }));
    return { userId, grants };
  }

  async record(userId: string, grant: ConsentGrant): Promise<ConsentState> {
    const validated = ConsentGrantSchema.parse(grant);
    await this.db.query(
      `INSERT INTO public.consent_grants (user_id,scope,granted,decided_at,notice_version)
       VALUES ($1,$2,$3,$4::timestamptz,$5)`,
      [userId, validated.scope, validated.granted, validated.decidedAt, validated.noticeVersion],
    );
    return this.get(userId);
  }

  async deleteForUser(userId: string): Promise<number> {
    const result = await this.db.query<{ id: string }>(
      "DELETE FROM public.consent_grants WHERE user_id=$1 RETURNING id",
      [userId],
    );
    return result.rows.length;
  }
}
