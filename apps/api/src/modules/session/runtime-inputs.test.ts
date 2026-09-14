import { describe, expect, it, vi } from "vitest";
import { PgEventLog, type TransactionPool } from "./pg-event-log.js";
import { PgRuntimeInputs } from "./runtime-inputs.js";

const request = { sessionId: "session", scenarioVersionId: "pin", type: "NOTE_DELTA" as const,
  actor: "CANDIDATE" as const, payload: { text: "note" }, traceId: "trace", idempotencyKey: "input", clientSeq: 0 };

function setup(failAt?: string) {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(sql.trim());
    if (failAt && sql.includes(failAt)) throw new Error("write failed");
    if (sql.includes("FOR UPDATE")) return { rows: [{ id: "session", scenario_version_id: "pin", deleted_at: null }] };
    if (sql.includes("SELECT 1 FROM public.session_runtime_owners")) return { rows: [{}] };
    if (sql.includes("INSERT INTO public.session_events")) return { rows: [{
      session_id: "session", seq: 3, occurred_at: "2026-09-14T00:00:00Z",
      type: "NOTE_DELTA", actor: "CANDIDATE", scenario_version_id: "pin",
      payload: {}, evidence_hash: "hash", trace_id: "trace", client_seq: 0,
    }] };
    return { rows: [] };
  });
  const release = vi.fn();
  const pool = { query, connect: async () => ({ query, release }) } as unknown as TransactionPool;
  return { log: new PgEventLog(pool), statements, release };
}

describe("durable runtime input transaction", () => {
  it("records the processing obligation before committing the acknowledged event", async () => {
    const h = setup();
    await h.log.append(request);
    const inserted = h.statements.findIndex((sql) => sql.includes("INSERT INTO public.runtime_inputs"));
    expect(inserted).toBeGreaterThan(h.statements.findIndex((sql) => sql.includes("INSERT INTO public.session_events")));
    expect(inserted).toBeLessThan(h.statements.indexOf("COMMIT"));
  });

  it("rolls the event back if its processing obligation cannot be persisted", async () => {
    const h = setup("INSERT INTO public.runtime_inputs");
    await expect(h.log.append(request)).rejects.toThrow("write failed");
    expect(h.statements).not.toContain("COMMIT");
    expect(h.statements.at(-1)).toBe("ROLLBACK");
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("rolls the checkpoint back if marking its input complete fails", async () => {
    const h = setup("UPDATE public.runtime_inputs");
    const { clientSeq: _clientSeq, ...base } = request;
    await expect(h.log.append({ ...base, type: "RUNTIME_CHECKPOINT", actor: "SYSTEM",
      runtimeToken: "owner", completedInputSeq: 3, idempotencyKey: "runtime-checkpoint:event:3",
    })).rejects.toThrow("write failed");
    expect(h.statements).not.toContain("COMMIT");
    expect(h.statements.at(-1)).toBe("ROLLBACK");
  });

  it("rejects completion metadata on an ordinary candidate event", async () => {
    const h = setup();
    await expect(h.log.append({ ...request, completedInputSeq: 3 })).rejects.toThrow("INVALID_INPUT_COMPLETION");
    expect(h.statements.some((sql) => sql.includes("INSERT INTO"))).toBe(false);
  });

  it("bounds discovery and maps event references without fetching payloads", async () => {
    const query = vi.fn(async () => ({ rows: [{ session_id: "s", input_seq: 4 }] }));
    const inputs = new PgRuntimeInputs({ query } as unknown as TransactionPool);
    expect(await inputs.pending(10)).toEqual([{ sessionId: "s", inputSeq: 4 }]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("s.deleted_at IS NULL"), [10]);
    await expect(inputs.pending(1001)).rejects.toThrow("INVALID_INPUT_LIMIT");
  });
});
