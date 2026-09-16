import { beforeAll, describe, expect, it, vi } from "vitest";
import { PgEventLog, type QueryClient, type TransactionPool } from "./pg-event-log.js";
import { PgSessionStore } from "./pg-session-store.js";
import { InMemorySessionStore } from "./session-store.js";
import { loadScenarioLibrary, type LoadedScenario } from "../scenario/loader.js";
import { CONTENT_ROOT } from "../../index.js";

const id = "11111111-1111-4111-8111-111111111111";
const row = {
  id, user_id: "owner", scenario_version_id: "conveyor-rescan@1", scenario_hash: "hash",
  mode: "MOCK", policy: {}, state: "IMPLEMENTATION", language: "python", trace_id: "trace",
  created_at: "2026-09-12T10:00:00Z", started_at: null, ended_at: null,
  expected_seconds: 2700, paused_seconds: 0,
};
const event = {
  session_id: id, seq: 0, occurred_at: "2026-09-12T10:00:00Z", type: "CODE_DELTA",
  actor: "CANDIDATE", scenario_version_id: "conveyor-rescan@1", payload: { text: "code" },
  evidence_hash: "hash", trace_id: "trace", client_seq: null,
};
const request = {
  sessionId: id, scenarioVersionId: "conveyor-rescan@1", type: "CODE_DELTA" as const,
  actor: "CANDIDATE" as const, payload: { text: "code" }, traceId: "trace", idempotencyKey: "key",
};

// These test adapter protocol, NOT PostgreSQL locking, permissions or durability.
describe("PostgreSQL event transaction protocol", () => {
  function setup(duplicate = false, failure?: Error) {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql.trim());
      if (sql.includes("FOR UPDATE")) return { rows: [row] };
      if (sql.includes("SELECT *")) return { rows: duplicate ? [event] : [] };
      if (sql.includes("INSERT INTO")) {
        if (failure) throw failure;
        return { rows: [event] };
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const rootQuery = vi.fn(() => { throw new Error("transaction escaped connection"); });
    const pool = { query: rootQuery, connect: async () => ({ query, release }) } as unknown as TransactionPool;
    return { log: new PgEventLog(pool), statements, release, rootQuery };
  }

  it("locks before dedupe/sequence assignment and commits before release", async () => {
    const h = setup();
    expect((await h.log.append(request)).duplicate).toBe(false);
    expect(h.statements[0]).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(h.statements[1]).toContain("FOR UPDATE");
    expect(h.statements[2]).toContain("idempotency_key");
    expect(h.statements[3]).toContain("INSERT INTO");
    expect(h.statements.at(-1)).toBe("COMMIT");
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.rootQuery).not.toHaveBeenCalled();
  });
  it("returns original evidence for a retry without an insert", async () => {
    const h = setup(true);
    const result = await h.log.append({ ...request, payload: { text: "changed retry" } });
    expect(result.duplicate).toBe(true);
    expect(result.event.payload).toEqual({ text: "code" });
    expect(h.statements.some((sql) => sql.includes("INSERT INTO"))).toBe(false);
    expect(h.statements.at(-1)).toBe("COMMIT");
  });
  it("rolls back and releases the connection on failed writes", async () => {
    const h = setup(false, new Error("write failed"));
    await expect(h.log.append(request)).rejects.toThrow("write failed");
    expect(h.statements.at(-1)).toBe("ROLLBACK");
    expect(h.statements).not.toContain("COMMIT");
    expect(h.release).toHaveBeenCalledOnce();
  });
  it("normalizes a durable client sequence collision", async () => {
    const conflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "session_events_client_seq",
    });
    const h = setup(false, conflict);
    await expect(h.log.append({ ...request, clientSeq: 0 })).rejects.toThrow("CLIENT_SEQUENCE_CONFLICT");
    expect(h.statements.at(-1)).toBe("ROLLBACK");
    expect(h.release).toHaveBeenCalledOnce();
  });
  it("rejects a different scenario pin before writing", async () => {
    const h = setup();
    await expect(h.log.append({ ...request, scenarioVersionId: "other@1" })).rejects.toThrow("SCENARIO_PIN_MISMATCH");
    expect(h.statements.at(-1)).toBe("ROLLBACK");
    expect(h.release).toHaveBeenCalledOnce();
  });
});

let scenario: LoadedScenario;
beforeAll(async () => { scenario = (await loadScenarioLibrary(CONTENT_ROOT)).get("conveyor-rescan@1")!; });
describe("PostgreSQL session repository protocol", () => {
  const createRequest = () => ({ userId: "owner", scenario, mode: "MOCK" as const, idempotencyKey: "retry" });
  it("returns existing retry before inspecting a now-retired question", async () => {
    const query = vi.fn(async () => ({ rows: [row] }));
    const store = new PgSessionStore({ query } as unknown as QueryClient);
    const result = await store.create({ ...createRequest(), scenario: { ...scenario, version: { ...scenario.version, status: "RETIRED" } } });
    expect(result.id).toBe(id);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("retrieves concurrent create winner in a fresh statement", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [row] });
    const store = new PgSessionStore({ query } as QueryClient);
    expect((await store.create(createRequest())).id).toBe(id);
    expect(query.mock.calls[0]![1]).toEqual(["owner", "retry"]);
    expect(query.mock.calls[1]![0]).toContain("ON CONFLICT (user_id, idempotency_key) DO NOTHING");
    expect(JSON.parse(query.mock.calls[1]![1][11])).toEqual(scenario);
    expect(query.mock.calls[2]![1]).toEqual(["owner", "retry"]);
  });
  it("uses atomic pause arithmetic and rejects invalid increments", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const store = new PgSessionStore({ query } as QueryClient);
    await store.addPause(id, 10);
    expect(query.mock.calls[0]![0]).toContain("paused_seconds=paused_seconds +");
    for (const value of [-1, NaN, Infinity, 0.5]) await expect(store.addPause(id, value)).rejects.toThrow("INVALID_PAUSE");
    expect(query).toHaveBeenCalledOnce();
  });
  it("does not turn missing updates into successful writes", async () => {
    const store = new PgSessionStore({ query: async () => ({ rows: [] }) });
    await expect(store.end(id)).rejects.toThrow("Session not found");
    await expect(store.transition(id, "IMPLEMENTATION")).rejects.toThrow("Session not found");
  });
  it("keeps the memory implementation terminal after completion", async () => {
    const store = new InMemorySessionStore();
    const created = await store.create(createRequest());
    const ended = await store.end(created.id);
    expect(await store.transition(created.id, "IMPLEMENTATION")).toEqual(ended);
    expect(await store.addPause(created.id, 10)).toEqual(ended);
  });
});
