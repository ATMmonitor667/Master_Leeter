import { describe, expect, it, vi } from "vitest";
import type { QueryClient } from "../session/pg-event-log.js";
import { PgConsentStore } from "./pg-consent-store.js";

describe("PostgreSQL consent repository protocol", () => {
  it("appends a decision then returns the ordered durable history", async () => {
    const rows = [{
      scope: "RAW_AUDIO",
      granted: true,
      decided_at: "2026-09-13T00:00:00.000Z",
      notice_version: "consent-2026-08-1",
    }];
    const query = vi.fn(async (sql: string, _values?: unknown[]) => ({ rows: sql.includes("SELECT scope") ? rows : [] }));
    const store = new PgConsentStore({ query } as QueryClient);
    const state = await store.record("user-1", {
      scope: "RAW_AUDIO",
      granted: true,
      decidedAt: "2026-09-13T00:00:00.000Z",
      noticeVersion: "consent-2026-08-1",
    });
    expect(query.mock.calls[0]?.[0]).toContain("INSERT INTO public.consent_grants");
    expect(query.mock.calls[1]?.[0]).toContain("ORDER BY decided_at,id");
    expect(state.grants).toHaveLength(1);
  });

  it("rejects malformed rows instead of granting consent", async () => {
    const query = vi.fn(async () => ({ rows: [{
      scope: "RAW_AUDIO",
      granted: "yes",
      decided_at: "2026-09-13T00:00:00.000Z",
      notice_version: "consent-2026-08-1",
    }] }));
    await expect(new PgConsentStore({ query } as unknown as QueryClient).get("user-1")).rejects.toThrow();
  });
});
