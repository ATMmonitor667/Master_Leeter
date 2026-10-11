import { describe, expect, it } from "vitest";
import { InMemoryRateLimitStore } from "./index.js";

describe("request cost bounds", () => {
  it("allows the quota exactly, isolates accounts, and resets at the window boundary", async () => {
    const store = new InMemoryRateLimitStore();
    expect((await store.take("alice:create", 2, 60_000, 1000)).allowed).toBe(true);
    expect((await store.take("alice:create", 2, 60_000, 2000)).allowed).toBe(true);
    expect(await store.take("alice:create", 2, 60_000, 2500)).toEqual({ allowed: false, retryAfterSeconds: 59 });
    expect((await store.take("bob:create", 2, 60_000, 2500)).allowed).toBe(true);
    expect((await store.take("alice:run", 2, 60_000, 2500)).allowed).toBe(true);
    expect((await store.take("alice:create", 2, 60_000, 61_000)).allowed).toBe(true);
  });

  it("bounds a simultaneous burst without allowing more than the quota", async () => {
    const store = new InMemoryRateLimitStore();
    const decisions = await Promise.all(Array.from({ length: 20 }, () => store.take("alice", 3, 60_000, 1000)));
    expect(decisions.filter((value) => value.allowed)).toHaveLength(3);
  });

  it.each([[0, 1000], [1, 0], [1.5, 1000], [1, NaN]])("rejects invalid limit %s/window %s", async (limit, window) => {
    await expect(new InMemoryRateLimitStore().take("alice", limit, window)).rejects.toThrow("INVALID_RATE_LIMIT");
  });
});
