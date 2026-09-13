import type { AddressInfo } from "node:net";
import { once } from "node:events";
import WebSocket from "ws";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildServer, CONTENT_ROOT } from "./index.js";
import { AuthError, type Authenticator } from "./modules/auth/index.js";
import { loadScenarioLibrary, type LoadedScenario } from "./modules/scenario/loader.js";

const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const origin = "http://localhost:3000";
let library: Map<string, LoadedScenario>;
beforeAll(async () => { library = await loadScenarioLibrary(CONTENT_ROOT); });
const apps: ReturnType<typeof buildServer>[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function fixture() {
  const authenticator: Authenticator = { verify: async (token) => {
    if (token === "outage") throw new AuthError("AUTH_UNAVAILABLE");
    if (token !== "alice" && token !== "bob") throw new AuthError("UNAUTHORIZED");
    return { userId: token === "alice" ? alice : bob, expiresAt: Date.now() + 3600_000 };
  } };
  const app = buildServer({ library, authenticator, webOrigin: origin });
  apps.push(app);
  const headers = (token = "alice") => ({ authorization: `Bearer ${token}`, "idempotency-key": "start" });
  const create = async (token = "alice") => {
    const response = await app.inject({ method: "POST", url: "/v1/interview-sessions", payload: {}, headers: headers(token) });
    expect(response.statusCode).toBe(201);
    return response.json().sessionId as string;
  };
  return { app, create, headers };
}

describe("protected interview API", () => {
  it("requires verified identity and ignores forged user headers", async () => {
    const { app, headers } = fixture();
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/v1/scenarios" })).statusCode).toBe(200);
    for (const token of [undefined, "fake", "outage"]) {
      const response = await app.inject({ method: "POST", url: "/v1/interview-sessions", payload: {}, headers: { "x-user-id": alice, ...(token ? headers(token) : {}) } });
      expect(response.statusCode).toBe(token === "outage" ? 503 : 401);
    }
    const response = await app.inject({ url: "/v1/me", headers: { ...headers(), "x-user-id": bob } });
    expect(response.json().userId).toBe(alice);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("protects every session route from a second account before side effects", async () => {
    const { app, create, headers } = fixture();
    const id = await create();
    const routes = [
      ["GET", `/v1/interview-sessions/${id}`], ["GET", `/v1/interview-sessions/${id}/resume`],
      ["GET", `/v1/interview-sessions/${id}/review`], ["GET", `/v1/interview-sessions/${id}/report`],
      ...["end", "runs", "realtime-token", "voice-tool", "voice-ready", "voice-utterance-complete", "disconnected", "socket-ticket", "report/regenerate"].map((path) => ["POST", `/v1/interview-sessions/${id}/${path}`]),
      ["DELETE", `/v1/privacy/sessions/${id}`], ["GET", `/v1/privacy/sessions/${id}/export`],
    ];
    for (const [method, url] of routes) {
      const response = await app.inject({ method: method as "GET" | "POST" | "DELETE", url: url!, headers: { ...headers("bob"), "x-user-id": alice } });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await app.inject({ url: `/v1/interview-sessions/${id}`, headers: headers() })).json().endedAt).toBeNull();
  });

  it("keeps idempotency and privacy consent scoped to verified accounts", async () => {
    const { app, create, headers } = fixture();
    expect(await create()).not.toBe(await create("bob"));
    await app.inject({ method: "POST", url: "/v1/privacy/consent", headers: headers(), payload: { scope: "TRANSCRIPT", granted: true } });
    expect((await app.inject({ url: "/v1/privacy/consent", headers: headers("bob") })).json().transcript).toBe(false);
  });

  it("denies untrusted origins and permits authorization in CORS preflight", async () => {
    const { app, headers } = fixture();
    expect((await app.inject({ url: "/v1/me", headers: { ...headers(), origin: "https://evil.example" } })).statusCode).toBe(403);
    const response = await app.inject({ method: "OPTIONS", url: "/v1/me", headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
    expect(response.headers["access-control-allow-headers"]).toContain("authorization");
  });

  it("disables operator report regeneration and prevents live deletion", async () => {
    const { app, create, headers } = fixture();
    const id = await create();
    expect((await app.inject({ method: "POST", url: `/v1/interview-sessions/${id}/report/regenerate`, headers: headers() })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/v1/privacy/sessions/${id}`, headers: headers() })).statusCode).toBe(409);
  });

  it("exports candidate data without leaking the interviewer's private content", async () => {
    const { app, create, headers } = fixture();
    const id = await create();
    await app.inject({ method: "POST", url: `/v1/interview-sessions/${id}/voice-ready`, headers: headers() });
    const exported = await app.inject({ url: `/v1/privacy/sessions/${id}/export`, headers: headers() });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().events.filter((event: { actor: string }) => event.actor !== "CANDIDATE").every((event: { payload: object }) => Object.keys(event.payload).length === 0)).toBe(true);
    expect(exported.body).not.toContain("openingScript");
  });

  it("uses one-use tickets on actual sockets and rejects cross-session frames", async () => {
    const { app, create, headers } = fixture();
    const id = await create();
    const otherId = await create("bob");
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const ticket = (await app.inject({ method: "POST", url: `/v1/interview-sessions/${id}/socket-ticket`, headers: headers() })).json().ticket as string;
    const url = `ws://127.0.0.1:${port}/v1/interview-sessions/${id}/events?ticket=${ticket}`;
    const socket = new WebSocket(url, { origin }); sockets.push(socket);
    await once(socket, "open");
    const message = once(socket, "message");
    socket.send(JSON.stringify({ sessionId: otherId, clientSeq: 0, idempotencyKey: "forged", type: "CODE_DELTA", occurredAt: new Date().toISOString(), payload: { revision: 1, text: "forged" } }));
    // The greeting can precede the error; inspect messages until the rejection.
    let received = JSON.parse(String((await message)[0]));
    if (received.kind === "STATE") received = JSON.parse(String((await once(socket, "message"))[0]));
    expect(received.code).toBe("SESSION_MISMATCH");
    const replay = new WebSocket(url, { origin }); sockets.push(replay);
    replay.on("error", () => {});
    const [, response] = await once(replay, "unexpected-response");
    expect(response.statusCode).toBe(401);
    replay.terminate();
    const exported = await app.inject({ url: `/v1/privacy/sessions/${otherId}/export`, headers: headers("bob") });
    expect(exported.body).not.toContain("forged");
  });
});
