import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildServer, CONTENT_ROOT } from "../../index.js";
import { loadScenarioLibrary, type LoadedScenario } from "../scenario/loader.js";
import { InMemorySupportIncidentStore } from "./store.js";

let library: Map<string, LoadedScenario>;
beforeAll(async () => { library = await loadScenarioLibrary(CONTENT_ROOT); });
const apps: ReturnType<typeof buildServer>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
const diagnostics = { connected: true, online: true, visibility: "visible" as const,
  pendingSaves: 0, stage: "ORAL_PROBLEM_DELIVERY" as const, voiceStatus: "LISTENING" as const };

describe("support diagnostics privacy and lifecycle", () => {
  async function fixture() {
    const store = new InMemorySupportIncidentStore();
    const create = vi.spyOn(store, "create");
    const app = buildServer({ library, supportStore: store,
      authenticator: { verify: async (token) => ({ userId: token, expiresAt: Date.now() + 3600_000 }) } });
    apps.push(app);
    const headers = (user = "alice") => ({ authorization: `Bearer ${user}`, "idempotency-key": randomUUID() });
    const session = await app.inject({ method: "POST", url: "/v1/interview-sessions", headers: headers(), payload: {} });
    expect(session.statusCode).toBe(201);
    const url = `/v1/interview-sessions/${session.json().sessionId}/support-incidents`;
    return { app, store, create, headers, url, body: { reportId: randomUUID(), category: "VOICE", consentDiagnostics: true, diagnostics } };
  }

  it("stores a consented report once across retries and returns only safe receipt fields", async () => {
    const { app, headers, url, body, store } = await fixture();
    const first = await app.inject({ method: "POST", url, headers: headers(), payload: body });
    const retry = await app.inject({ method: "POST", url, headers: headers(), payload: body });
    expect(first.statusCode).toBe(201);
    expect(retry.json().incidentId).toBe(first.json().incidentId);
    expect(first.json().retentionDays).toBe(30);
    expect(first.json()).not.toHaveProperty("diagnostics");
    expect(await store.purgeExpired(new Date(Date.parse(first.json().createdAt) + 30 * 86_400_000 - 1).toISOString())).toBe(0);
    expect(await store.purgeExpired(new Date(Date.parse(first.json().createdAt) + 30 * 86_400_000).toISOString())).toBe(1);
  });

  it.each(["code", "transcript", "deviceName", "audio", "notes"])("rejects %s rather than collecting private content", async (field) => {
    const { app, headers, url, body, create } = await fixture();
    const response = await app.inject({ method: "POST", url, headers: headers(),
      payload: { ...body, diagnostics: { ...diagnostics, [field]: "private content" } } });
    expect(response.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects absent consent and cross-account reports before storage", async () => {
    const { app, headers, url, body, create } = await fixture();
    expect((await app.inject({ method: "POST", url, headers: headers(), payload: { ...body, consentDiagnostics: false } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: headers("bob"), payload: body })).statusCode).toBe(404);
    expect(create).not.toHaveBeenCalled();
  });

  it("returns a safe retryable error when storage fails", async () => {
    const { app, headers, url, body, create } = await fixture();
    create.mockRejectedValueOnce(new Error("database password and private payload"));
    const response = await app.inject({ method: "POST", url, headers: headers(), payload: body });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("SUPPORT_REPORT_UNAVAILABLE");
    expect(response.body).not.toContain("password");
  });
});
