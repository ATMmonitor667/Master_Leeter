import { describe, expect, it, vi } from "vitest";
import type { TransactionPool } from "./pg-event-log.js";
import { PgSessionLifecycle } from "./pg-lifecycle.js";

describe("PostgreSQL lifecycle transaction protocol", () => {
  it("rolls back and releases when session creation fails", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql.trim());
      if (sql.includes("WHERE user_id")) return { rows: [] };
      if (sql.includes("INSERT INTO public.interview_sessions")) throw new Error("create failed");
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = { query: vi.fn(), connect: async () => ({ query, release }) } as unknown as TransactionPool;
    const lifecycle = new PgSessionLifecycle(pool);
    await expect(lifecycle.createStarted({
      userId: "user",
      scenario: {
        contentHash: "sha256:test",
        version: { id: "scenario@1", status: "ACTIVE", target: { expectedMinutes: 45 } },
      } as never,
      mode: "MOCK",
      idempotencyKey: "key",
    })).rejects.toThrow("create failed");
    expect(statements[0]).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });
});
