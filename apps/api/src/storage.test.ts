import { describe, expect, it, vi } from "vitest";
import { buildServer } from "./index.js";
import { assertDurableSchema, createSupabaseStorage, type StorageDatabase } from "./storage.js";

function fakeDatabase(change: Record<string, boolean | null> = {}) {
  const ready = Object.fromEntries(Array.from({ length: 19 }, (_, i) => [`check${i}`, true]));
  const close = vi.fn(async () => {});
  const queries: string[] = [];
  const db: StorageDatabase = {
    async query<R>(sql: string) {
      queries.push(sql);
      if (sql.startsWith("SELECT r.session_id")) return { rows: [] };
      return { rows: [{ ...ready, ...change } as R] };
    },
    async connect() { throw new Error("No writes expected during composition"); },
    close,
  };
  return { db, close, queries };
}

describe("durable storage composition", () => {
  it("checks schema without writes and closes with the server exactly once", async () => {
    const { db, close, queries } = fakeDatabase();
    const storage = await createSupabaseStorage("test-only", () => db);
    const app = buildServer({ library: new Map(), ...storage });
    await app.ready();
    await app.close();
    await storage.closeStorage();
    expect(close).toHaveBeenCalledOnce();
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatch(/^SELECT/);
    expect(queries[0]).toContain("'INSERT') AS session_events_insert");
  });

  it.each([false, null])("refuses one absent permission or migration (%s)", async (value) => {
    const { db, close } = fakeDatabase({ check0: value });
    await expect(createSupabaseStorage("test-only", () => db)).rejects.toThrow("STORAGE_SCHEMA_INCOMPLETE");
    expect(close).toHaveBeenCalledOnce();
  });

  it("refuses empty readiness results", async () => {
    await expect(assertDurableSchema({ query: async () => ({ rows: [] }) }))
      .rejects.toThrow("STORAGE_SCHEMA_INCOMPLETE");
  });

  it("sanitizes connection failures and still closes the pool", async () => {
    const { db, close } = fakeDatabase();
    db.query = async () => { throw new Error("private connection details"); };
    await expect(createSupabaseStorage("test-only", () => db)).rejects.toThrow(/^STORAGE_UNAVAILABLE$/);
    expect(close).toHaveBeenCalledOnce();
  });
});
