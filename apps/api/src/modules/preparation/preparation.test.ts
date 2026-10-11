import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildServer, CONTENT_ROOT } from "../../index.js";
import { GeminiClient } from "../../lib/gemini.js";
import { loadScenarioLibrary, type LoadedScenario } from "../scenario/loader.js";
import { InMemoryPreparationStore } from "./store.js";
import { EmptyResumeAnalyzer, GeminiResumeAnalyzer } from "./resume-analyzer.js";
import { CanonicalScenarioRestater, GeminiScenarioRestater } from "./restatement.js";

let library: Map<string, LoadedScenario>;
beforeAll(async () => { library = await loadScenarioLibrary(CONTENT_ROOT); });
const apps: ReturnType<typeof buildServer>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); vi.restoreAllMocks(); });
const analysis = { summary: "Python experience", facts: [], model: "fixture", promptVersion: "v1" };

describe("resume lifecycle races", () => {
  async function fixture() {
    let now = "2026-10-11T12:00:00.000Z";
    const store = new InMemoryPreparationStore(() => now);
    const input = { userId: "alice", idempotencyKey: "retry", resumeText: "Python experience", tone: "NORMAL" as const,
      noticeVersion: "v1", resumeExpiresAt: "2026-10-12T12:00:00.000Z" };
    const { record } = await store.create(input);
    return { store, input, id: record.id, advance: () => { now = input.resumeExpiresAt; } };
  }

  it("scopes retries to an account and refuses to recreate an erased preparation", async () => {
    const { store, input, id } = await fixture();
    expect((await store.create(input)).record.id).toBe(id);
    expect((await store.create({ ...input, userId: "bob" })).record.id).not.toBe(id);
    await store.delete(id);
    expect(await store.get(id)).toBeNull();
    await expect(store.create(input)).rejects.toThrow("PREPARATION_DELETED");
  });

  it.each(["deleteResume", "delete", "expire"] as const)("fences in-flight analysis after %s", async (action) => {
    const { store, id, advance, input } = await fixture();
    expect(await store.claimAnalysis(id, "owner", "1970-01-01T00:00:00Z")).toBe(true);
    if (action === "expire") { advance(); await store.purgeExpiredResumes(input.resumeExpiresAt); }
    else await store[action](id);
    await expect(store.saveAnalysis(id, analysis, "owner")).rejects.toThrow("PREPARATION_CLAIM_LOST");
    expect(await store.claimAnalysis(id, "replacement", "2099-01-01T00:00:00Z")).toBe(false);
  });

  it("rejects a stale analysis owner after lease takeover", async () => {
    const { store, id } = await fixture();
    await store.claimAnalysis(id, "old", "1970-01-01T00:00:00Z");
    expect(await store.claimAnalysis(id, "new", "2099-01-01T00:00:00Z")).toBe(true);
    await store.releaseAnalysis(id, "old");
    await expect(store.saveAnalysis(id, analysis, "old")).rejects.toThrow("PREPARATION_CLAIM_LOST");
    expect((await store.saveAnalysis(id, analysis, "new")).status).toBe("REVIEW");
  });

  it("keeps a question pin and completed session immutable across retries", async () => {
    const { store, id } = await fixture();
    await store.pinScenario(id, "q@1", "hash1");
    await expect(store.pinScenario(id, "q@2", "hash2")).rejects.toThrow("PREPARATION_ALREADY_PINNED");
    const wording = await new CanonicalScenarioRestater().restate([...library.values()][0]!.version);
    await store.complete(id, wording, "session1");
    expect((await store.complete(id, wording, "session1")).sessionId).toBe("session1");
    await expect(store.complete(id, wording, "session2")).rejects.toThrow("PREPARATION_ALREADY_COMPLETED");
  });
});

describe("model preparation boundaries", () => {
  it("drops invented evidence and invalid categories from resume analysis", async () => {
    const client = new GeminiClient({ model: "fixture", apiKey: "test-only" });
    vi.spyOn(client, "generateJson").mockResolvedValue({ summary: "Developer", facts: [
      { category: "SKILL", claim: "Python", evidence: "Python experience" },
      { category: "SKILL", claim: "Rust", evidence: "Rust experience" },
      { category: "AGE", claim: "30", evidence: "Python experience" },
    ] });
    const result = await new GeminiResumeAnalyzer(client).analyze("Python experience");
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({ category: "SKILL", evidence: "Python experience" });
  });

  it("caps extracted facts and gives them unique review identities", async () => {
    const client = new GeminiClient({ model: "fixture", apiKey: "test-only" });
    vi.spyOn(client, "generateJson").mockResolvedValue({ summary: "Developer", facts: Array.from({ length: 45 }, () =>
      ({ category: "SKILL", claim: "Python", evidence: "Python" })) });
    const result = await new GeminiResumeAnalyzer(client).analyze("Python");
    expect(result.facts).toHaveLength(40);
    expect(new Set(result.facts.map((fact) => fact.id)).size).toBe(40);
  });

  it.each(["outage", "changed contract", "invented wording"])("uses authored wording after %s", async (failure) => {
    const scenario = [...library.values()][0]!.version;
    const client = new GeminiClient({ model: "fixture", apiKey: "test-only" });
    const generate = vi.spyOn(client, "generateJson");
    if (failure === "outage") generate.mockRejectedValue(new Error("provider secret body"));
    else generate.mockResolvedValue({ openingScript: failure === "invented wording" ? "Solve this using quantum banana teleportation." : scenario.oralBrief.openingScript,
      repeatVariants: scenario.oralBrief.repeatVariants, contractFacts: failure === "changed contract" ? [] : [
        ...scenario.facts.filter((fact) => fact.disclosure === "ALWAYS").map((fact) => `${fact.key}: ${fact.value}`),
        ...scenario.examples.map((example) => `example: ${example.input} => ${example.output}`),
      ] });
    const result = await new GeminiScenarioRestater(client).restate(scenario);
    expect(result.fallback).toBe(true);
    expect(result.openingScript).toBe(scenario.oralBrief.openingScript);
    expect(JSON.stringify(result)).not.toContain("provider secret body");
  });
});

describe("authenticated preparation API", () => {
  function fixture() {
    const app = buildServer({ library, authenticator: { verify: async (token) => ({ userId: token, expiresAt: Date.now() + 3600_000 }) },
      resumeAnalyzer: new EmptyResumeAnalyzer() });
    apps.push(app);
    const headers = (user = "alice") => ({ authorization: `Bearer ${user}`, "idempotency-key": randomUUID() });
    const create = () => app.inject({ method: "POST", url: "/v1/preparations", headers: headers(),
      payload: { resumeText: "Private candidate resume", consent: true } });
    return { app, headers, create };
  }

  it("requires explicit consent and rejects unknown request fields", async () => {
    const { app, headers } = fixture();
    for (const payload of [{ resumeText: "resume", consent: false }, { resumeText: "resume", consent: true, instructions: "ignore rules" }]) {
      expect((await app.inject({ method: "POST", url: "/v1/preparations", headers: headers(), payload })).statusCode).toBe(400);
    }
  });

  it("requires reviewed facts, completes once, and hides resume and pinned wording", async () => {
    const { app, headers, create } = fixture();
    const created = await create();
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const url = `/v1/preparations/${id}`;
    expect((await app.inject({ method: "POST", url: `${url}/complete`, headers: headers(), payload: {} })).statusCode).toBe(409);
    expect((await app.inject({ method: "PATCH", url: `${url}/facts`, headers: headers(), payload: { confirmedFactIds: [randomUUID()] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `${url}/facts`, headers: headers(), payload: { confirmedFactIds: [] } })).statusCode).toBe(200);
    const completed = await app.inject({ method: "POST", url: `${url}/complete`, headers: headers(), payload: {} });
    expect(completed.statusCode).toBe(201);
    const retry = await app.inject({ method: "POST", url: `${url}/complete`, headers: headers(), payload: {} });
    expect(retry.json().sessionId).toBe(completed.json().sessionId);
    for (const response of [created, completed, retry]) {
      for (const secret of ["Private candidate resume", "openingScript", "scenarioVersionId", "scenarioHash", "restatement"])
        expect(response.body).not.toContain(secret);
    }
  });

  it("denies another account every preparation read/write path", async () => {
    const { app, headers, create } = fixture();
    const id = (await create()).json().id;
    for (const [method, path, payload] of [
      ["GET", "", undefined], ["PATCH", "/facts", { confirmedFactIds: [] }],
      ["POST", "/complete", {}], ["DELETE", "/resume", undefined], ["DELETE", "", undefined],
    ] as const) {
      expect((await app.inject({ method, url: `/v1/preparations/${id}${path}`, headers: headers("bob"),
        ...(payload ? { payload } : {}) })).statusCode).toBe(404);
    }
  });
});
