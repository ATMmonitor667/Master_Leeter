import { describe, expect, it, vi } from "vitest";
import { RuntimeOwnerHandles, type RuntimeOwnership } from "./runtime-ownership.js";
import { buildServer, CONTENT_ROOT } from "../../index.js";
import { loadScenarioLibrary } from "../scenario/loader.js";
import { InMemorySessionStore } from "./session-store.js";
import { InMemoryEventLog } from "./event-log.js";

function sharedStore() {
  let current: string | null = null;
  let sequence = 0;
  const store: RuntimeOwnership = {
    claim: vi.fn(async () => current ? null : (current = `token-${++sequence}`)),
    renew: vi.fn(async (_id, token) => current === token),
    release: vi.fn(async (_id, token) => { if (current === token) current = null; }),
  };
  return { store, expire: () => { current = null; } };
}

describe("runtime ownership handles", () => {
  it("coalesces concurrent claims and fences a former owner after takeover", async () => {
    const shared = sharedStore();
    const lost = vi.fn();
    const first = new RuntimeOwnerHandles(shared.store, lost);
    const second = new RuntimeOwnerHandles(shared.store, () => {});
    const claims = await Promise.all([first.ensure("s"), first.ensure("s")]);
    expect(claims).toEqual(["token-1", "token-1"]);
    expect(shared.store.claim).toHaveBeenCalledOnce();
    expect(await second.ensure("s")).toBeNull();
    shared.expire();
    expect(await second.ensure("s")).toBe("token-2");
    expect(await first.verify("s", "token-1")).toBe(false);
    expect(lost).toHaveBeenCalledWith("s");
    await first.close();
    expect(await second.verify("s", "token-2")).toBe(true);
    await second.close();
  });

  it("fails closed during a store outage and never resurrects an old handle", async () => {
    const shared = sharedStore();
    const lost = vi.fn();
    const owner = new RuntimeOwnerHandles(shared.store, lost);
    const token = await owner.ensure("s");
    shared.store.renew = async () => { throw new Error("offline"); };
    await owner.heartbeat();
    expect(lost).toHaveBeenCalledWith("s");
    expect(await owner.verify("s", token!)).toBe(false);
    await owner.close();
    expect(await owner.ensure("s")).toBeNull();
  });

  it("waits for a pending claim before releasing during shutdown", async () => {
    let finish!: (value: string) => void;
    const shared = sharedStore();
    shared.store.claim = () => new Promise((resolve) => { finish = resolve; });
    const owner = new RuntimeOwnerHandles(shared.store, () => {});
    const pending = owner.ensure("s");
    const closing = owner.close();
    finish("late-token");
    await pending;
    await closing;
    expect(shared.store.release).toHaveBeenCalledWith("s", "late-token");
    expect(await owner.verify("s", "late-token")).toBe(false);
  });

  it("rejects commands on another server and recovers after ownership expires", async () => {
    const library = await loadScenarioLibrary(CONTENT_ROOT);
    const sessions = new InMemorySessionStore();
    const events = new InMemoryEventLog();
    const scenario = library.get("conveyor-rescan@1")!;
    const session = await sessions.create({ userId: "test", scenario, mode: "MOCK", idempotencyKey: "owner-test" });
    await events.append({ sessionId: session.id, scenarioVersionId: session.scenarioVersionId,
      type: "SESSION_STARTED", actor: "SYSTEM", payload: {}, traceId: session.traceId, idempotencyKey: "start" });
    const shared = sharedStore();
    const options = { library, sessionStore: sessions, eventLog: events, runtimeOwnership: shared.store };
    const first = buildServer(options);
    const second = buildServer(options);
    await first.ready();
    await second.ready();
    const request = { method: "POST" as const, url: `/v1/interview-sessions/${session.id}/voice-ready` };
    try {
      expect((await first.inject(request)).statusCode).toBe(200);
      const denied = await second.inject(request);
      expect(denied.statusCode).toBe(409);
      expect(denied.json()).toEqual({ error: "RUNTIME_OWNED_ELSEWHERE" });
      const count = (await events.read(session.id)).filter((e) => e.type === "BRIEF_DELIVERED").length;
      shared.expire();
      expect((await second.inject(request)).statusCode).toBe(200);
      expect((await first.inject(request)).statusCode).toBe(409);
      expect((await events.read(session.id)).filter((e) => e.type === "BRIEF_DELIVERED")).toHaveLength(count);
    } finally { await first.close(); await second.close(); }
  });
});
