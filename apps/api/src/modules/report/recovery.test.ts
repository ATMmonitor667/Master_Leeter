import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryEventLog } from "../session/event-log.js";
import { EvaluationQueue, InMemoryReportJobStore } from "./index.js";
import { startReportRecovery } from "./recovery-worker.js";

const now = "2026-09-14T00:00:00.000Z";
afterEach(() => vi.useRealTimers());

describe("report restart recovery", () => {
  it("recovers queued and expired work without a browser request and honors batch limits", async () => {
    const jobs = new InMemoryReportJobStore();
    const log = new InMemoryEventLog();
    for (const id of ["a", "b", "c"]) {
      await jobs.enqueue(id, "rubric-coding-v1", now);
      await log.append({ sessionId: id, scenarioVersionId: "conveyor-rescan@1",
        traceId: "test", type: "SESSION_ENDED", actor: "SYSTEM", payload: {}, idempotencyKey: "end" });
    }
    await jobs.claim("a", "2026-09-13T00:00:00.000Z", "2026-09-13T00:01:00.000Z");
    await jobs.claim("c", now, "2026-09-14T00:01:00.000Z");
    const queue = new EvaluationQueue(log, undefined, () => now, jobs);
    await queue.recover(1);
    expect((await jobs.get("a"))?.status).toBe("READY");
    expect((await jobs.get("a"))?.attempts).toBe(2);
    expect((await jobs.get("b"))?.status).toBe("QUEUED");
    await Promise.all([queue.recover(), new EvaluationQueue(log, undefined, () => now, jobs).recover()]);
    expect((await jobs.get("b"))?.attempts).toBe(1);
    expect((await jobs.get("b"))?.status).toBe("READY");
    expect((await jobs.get("c"))?.attempts).toBe(1);
    expect((await jobs.get("c"))?.status).toBe("RUNNING");
  });

  it("does not expose provider errors in the stored candidate-facing report", async () => {
    const jobs = new InMemoryReportJobStore();
    const log = new InMemoryEventLog();
    await jobs.enqueue("a", "rubric-coding-v1", now);
    await log.append({ sessionId: "a", scenarioVersionId: "conveyor-rescan@1", traceId: "test",
      type: "SESSION_ENDED", actor: "SYSTEM", payload: {}, idempotencyKey: "end" });
    const queue = new EvaluationQueue(log, { evaluate: async () => { throw new Error("private provider detail"); } }, () => now, jobs);
    await queue.recover();
    expect((await jobs.get("a"))?.error).toBe("EVALUATION_FAILED");
  });

  it("retries discovery failures and stops scheduling on shutdown", async () => {
    vi.useFakeTimers();
    const recover = vi.fn().mockRejectedValueOnce(new Error("DB unavailable")).mockResolvedValue(undefined);
    const error = vi.fn();
    const stop = startReportRecovery(recover, error, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledOnce();
    await stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it("drains an active recovery pass without starting overlapping passes", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const recover = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const stop = startReportRecovery(recover, () => {}, 10);
    await vi.advanceTimersByTimeAsync(100);
    expect(recover).toHaveBeenCalledOnce();
    let stopped = false;
    const closing = stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await closing;
    await vi.advanceTimersByTimeAsync(100);
    expect(recover).toHaveBeenCalledOnce();
  });
});
