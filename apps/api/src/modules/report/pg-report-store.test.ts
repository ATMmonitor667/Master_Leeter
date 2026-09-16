import { describe, expect, it, vi } from "vitest";
import type { QueryClient } from "../session/pg-event-log.js";
import { PgReportJobStore } from "./pg-report-store.js";

const id = "11111111-1111-4111-8111-111111111111";
const row = {
  session_id: id,
  rubric_id: "rubric-coding-v1",
  status: "QUEUED" as const,
  body: null,
  error: null,
  attempts: 0,
  created_at: "2026-09-13T00:00:00.000Z",
  completed_at: null,
};

describe("PostgreSQL report job protocol", () => {
  it("enqueues idempotently in one statement", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [row] }));
    const store = new PgReportJobStore({ query } as QueryClient);
    expect(await store.enqueue(id, "rubric-coding-v1", row.created_at)).toMatchObject({ sessionId: id, status: "QUEUED" });
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT (session_id)");
    expect(query.mock.calls[0]?.[0]).toContain("status='FAILED'");
  });

  it("claims with a fencing token and an expiry condition", async () => {
    const running = { ...row, status: "RUNNING" as const, attempts: 1 };
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [running] }));
    const store = new PgReportJobStore({ query } as QueryClient);
    const claim = await store.claim(id, row.created_at, "2026-09-13T00:01:00.000Z");
    expect(claim?.job).toMatchObject({ status: "RUNNING", attempts: 1 });
    expect(claim?.token).toMatch(/^[a-f0-9-]{36}$/);
    expect(query.mock.calls[0]?.[0]).toContain("lease_expires_at <=");
    expect(query.mock.calls[0]?.[1]?.[1]).toBe(claim?.token);
  });

  it("finishes only while the same lease token owns the job", async () => {
    const ready = { ...row, status: "READY" as const, body: { sessionId: id }, completed_at: "2026-09-13T00:00:10.000Z" };
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [ready] }));
    const store = new PgReportJobStore({ query } as QueryClient);
    await store.complete(id, "22222222-2222-4222-8222-222222222222", ready.body as never, ready.completed_at);
    expect(query.mock.calls[0]?.[0]).toContain("lease_token=$2::uuid");
    expect(query.mock.calls[0]?.[0]).toContain("status='RUNNING'");
  });
});
