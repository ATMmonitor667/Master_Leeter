import { describe, expect, it, vi } from "vitest";
import type { TransactionPool } from "../session/pg-event-log.js";
import { PgSocketTickets } from "./pg-socket-tickets.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

describe("PostgreSQL socket ticket protocol", () => {
  it("hashes the credential and commits its bounded issue transaction", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql: sql.trim(), ...(values ? { values } : {}) });
      if (sql.includes("COUNT(*)")) return { rows: [{ count: "0" }] };
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = { query: vi.fn(), connect: async () => ({ query, release }) } as unknown as TransactionPool;
    const ticket = await new PgSocketTickets(pool, () => 1_000).issue(sessionId, { userId, expiresAt: 60_000 });

    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(calls.map((call) => call.sql)).toEqual(expect.arrayContaining([
      "BEGIN",
      "COMMIT",
    ]));
    expect(calls.some((call) => call.sql.includes("pg_advisory_xact_lock"))).toBe(true);
    const insert = calls.find((call) => call.sql.includes("INSERT INTO public.socket_tickets"))!;
    expect(insert.values?.[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(insert.values).not.toContain(ticket);
    expect(release).toHaveBeenCalledOnce();
  });

  it("atomically consumes only a matching session ticket", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{
      user_id: userId,
      principal_expires_at: "2026-09-13T01:01:00.000Z",
      expires_at: "2026-09-13T01:00:30.000Z",
    }] }));
    const pool = { query, connect: vi.fn() } as unknown as TransactionPool;
    const store = new PgSocketTickets(pool, () => Date.parse("2026-09-13T01:00:00.000Z"));
    const token = "a".repeat(43);
    expect(await store.take(token, sessionId)).toEqual({ userId, expiresAt: Date.parse("2026-09-13T01:01:00.000Z") });
    expect(query.mock.calls[0]?.[0]).toContain("DELETE FROM public.socket_tickets");
    expect(query.mock.calls[0]?.[0]).toContain("RETURNING");
    expect(query.mock.calls[0]?.[1]?.[1]).toBe(sessionId);
  });

  it("rolls back when capacity is exhausted", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql.trim());
      return sql.includes("COUNT(*)") ? { rows: [{ count: "10000" }] } : { rows: [] };
    });
    const release = vi.fn();
    const pool = { query: vi.fn(), connect: async () => ({ query, release }) } as unknown as TransactionPool;
    await expect(new PgSocketTickets(pool, () => 1_000).issue(sessionId, { userId, expiresAt: 60_000 }))
      .rejects.toThrow("AUTH_UNAVAILABLE");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });
});
