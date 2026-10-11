import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildServer, CONTENT_ROOT, type ServerOptions } from "./index.js";
import { loadScenarioLibrary, type LoadedScenario } from "./modules/scenario/loader.js";
import { InMemorySessionStore } from "./modules/session/session-store.js";
import { InMemorySupportIncidentStore } from "./modules/support/store.js";
import { InMemoryEventLog } from "./modules/session/event-log.js";
import { InMemoryPreparationStore } from "./modules/preparation/store.js";

let library: Map<string, LoadedScenario>;
beforeAll(async () => { library = await loadScenarioLibrary(CONTENT_ROOT); });
const apps: ReturnType<typeof buildServer>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
function fixture(overrides: Partial<ServerOptions> = {}) {
  const app = buildServer({ library,
    authenticator: { verify: async (token) => ({ userId: token, expiresAt: Date.now() + 3600_000 }) }, ...overrides });
  apps.push(app);
  return { app, headers: (user = "alice") => ({ authorization: `Bearer ${user}` }) };
}

describe("history API", () => {
  it("paginates tied timestamps without duplicates, hides erased sessions, and isolates accounts", async () => {
    const store = new InMemorySessionStore(() => "2026-10-11T12:00:00.000Z");
    const scenario = [...library.values()][0]!;
    const sessions = [];
    for (let i = 0; i < 5; i++) sessions.push(await store.create({ userId: "alice", scenario, mode: "MOCK", idempotencyKey: `a${i}` }));
    const bob = await store.create({ userId: "bob", scenario, mode: "MOCK", idempotencyKey: "bob" });
    await store.tombstone(sessions[0]!.id);
    const { app, headers } = fixture({ sessionStore: store });
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const response = await app.inject({ url: `/v1/interview-sessions?limit=2${cursor ? `&cursor=${cursor}` : ""}`, headers: headers() });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toMatch(/openingScript|scenarioHash|resumeText|hiddenTests/);
      const data: { sessions: Array<{ sessionId: string }>; nextCursor: string | null } = response.json();
      ids.push(...data.sessions.map((session: { sessionId: string }) => session.sessionId));
      cursor = data.nextCursor;
      if (!cursor) break;
    }
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(ids).not.toContain(sessions[0]!.id);
    expect(ids).not.toContain(bob.id);
  });

  it.each(["limit=0", "limit=10000", "cursor=not-a-cursor"])("rejects malformed history query %s", async (query) => {
    const { app, headers } = fixture();
    expect((await app.inject({ url: `/v1/interview-sessions?${query}`, headers: headers() })).statusCode).toBe(400);
  });
});

describe("account erasure ordering", () => {
  it("removes practice data before deleting the Auth identity", async () => {
    const events = new InMemoryEventLog(); const sessions = new InMemorySessionStore();
    const support = new InMemorySupportIncidentStore();
    const session = await sessions.create({ userId: "alice", scenario: [...library.values()][0]!, mode: "MOCK", idempotencyKey: "one" });
    await sessions.end(session.id);
    await events.append({ sessionId: session.id, scenarioVersionId: session.scenarioVersionId, traceId: "test",
      type: "SPEECH_FINAL", actor: "CANDIDATE", payload: { transcript: "private candidate words" }, idempotencyKey: "speech" });
    const removeSupport = vi.spyOn(support, "deleteForSession");
    const deleteUser = vi.fn(async () => {
      expect(await sessions.get(session.id)).toBeNull();
      expect(JSON.stringify(await events.read(session.id))).not.toContain("private candidate words");
      expect(removeSupport).toHaveBeenCalledWith(session.id);
    });
    const { app, headers } = fixture({ sessionStore: sessions, eventLog: events, supportStore: support, identityAdmin: { deleteUser } });
    const response = await app.inject({ method: "DELETE", url: "/v1/privacy/account/identity", headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json().identityDeleted).toBe(true);
    expect(deleteUser).toHaveBeenCalledWith("alice");
  });

  it("retains the Auth identity when practice-data deletion is unfinished, then retries safely", async () => {
    const preparationStore = new InMemoryPreparationStore();
    const remove = vi.spyOn(preparationStore, "deleteForUser").mockRejectedValueOnce(new Error("private database error"));
    const deleteUser = vi.fn().mockResolvedValue(undefined);
    const { app, headers } = fixture({ preparationStore, identityAdmin: { deleteUser } });
    const first = await app.inject({ method: "DELETE", url: "/v1/privacy/account/identity", headers: headers() });
    expect(first.statusCode).toBe(503);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(first.body).not.toContain("private database error");
    const retry = await app.inject({ method: "DELETE", url: "/v1/privacy/account/identity", headers: headers() });
    expect(retry.statusCode).toBe(200);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(deleteUser).toHaveBeenCalledTimes(1);
  });
});

describe("launch admission HTTP boundary", () => {
  it.each(["/v1/interview-sessions", "/v1/preparations", "/v1/preparations/00000000-0000-4000-8000-000000000001/complete"])(
    "refuses new admission while draining at %s", async (url) => {
      const { app, headers } = fixture({ writesPermitted: () => false });
      const response = await app.inject({ method: "POST", url, headers: headers(), payload: {} });
      expect(response.statusCode).toBe(503);
    });

  it("fails closed when the rate-limit store is unavailable", async () => {
    const { app, headers } = fixture({ rateLimiter: { take: async () => { throw new Error("private database error"); } } });
    const response = await app.inject({ method: "POST", url: "/v1/interview-sessions", headers: headers(), payload: {} });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("private database error");
  });
});
