import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryDeletionStore, type NewDeletion } from "./deletion-store.js";
import type { DeletionReceipt } from "./deletion.js";

afterEach(() => vi.useRealTimers());
const input: NewDeletion = { dedupeKey: "account:alice", scope: "ACCOUNT", reason: "USER_REQUEST",
  userId: "alice", sessionIds: ["session1"], requestedAt: "2026-10-11T12:00:00.000Z" };
const receipt: DeletionReceipt = { scope: "ACCOUNT", userId: "alice", sessionIds: ["session1"],
  eventsRedacted: 3, reportsDeleted: 1, audioDeleted: 0, completedAt: "2026-10-11T12:00:01.000Z", unreachable: [] };

describe("privacy deletion recovery", () => {
  it("deduplicates requests and attaches retries to the unfinished account deletion", async () => {
    const store = new InMemoryDeletionStore();
    const first = await store.enqueue(input);
    expect((await store.enqueue(input)).id).toBe(first.id);
    expect((await store.pendingForUser("alice"))?.id).toBe(first.id);
    expect(await store.pendingForUser("bob")).toBeNull();
    const claim = await store.claim(first.id, 1000);
    await store.complete(first.id, claim!.token, receipt);
    expect(await store.pendingForUser("alice")).toBeNull();
    expect(await store.claim(first.id, 1000)).toBeNull();
    expect((await store.enqueue(input)).receipt).toEqual(receipt);
  });

  it("recovers an expired worker lease and fences its stale result and release", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    const store = new InMemoryDeletionStore();
    const record = await store.enqueue(input);
    const old = await store.claim(record.id, 1000);
    expect(await store.claim(record.id, 1000)).toBeNull();
    vi.advanceTimersByTime(1000);
    const [replacement] = await store.recoverable(1, 1000);
    expect(replacement!.token).not.toBe(old!.token);
    await store.release(record.id, old!.token);
    await expect(store.complete(record.id, old!.token, receipt)).rejects.toThrow("DELETION_CLAIM_LOST");
    await store.complete(record.id, replacement!.token, receipt);
    expect(await store.recoverable(10, 1000)).toEqual([]);
  });

  it("bounds recovery batches and does not duplicate an active claim", async () => {
    const store = new InMemoryDeletionStore();
    for (let i = 0; i < 3; i++) await store.enqueue({ ...input, dedupeKey: `job${i}` });
    const first = await store.recoverable(2, 60_000);
    const second = await store.recoverable(2, 60_000);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second].map((claim) => claim.id)).size).toBe(3);
  });
});
