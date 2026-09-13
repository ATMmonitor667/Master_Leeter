import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildServer, CONTENT_ROOT } from "./index.js";
import { loadScenarioLibrary, scenarioRef, type LoadedScenario } from "./modules/scenario/loader.js";
import { QuestionBankError, type QuestionBank } from "./modules/scenario/question-bank.js";

let question: LoadedScenario;
beforeAll(async () => { question = (await loadScenarioLibrary(CONTENT_ROOT)).get("conveyor-rescan@1")!; });
const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });
function fixture() {
  const bank = {
    kind: "supabase" as const,
    listActive: vi.fn<QuestionBank["listActive"]>().mockImplementation(async () => [structuredClone(question)]),
    get: vi.fn<QuestionBank["get"]>().mockImplementation(async () => structuredClone(question)),
  };
  const library = new Map<string, LoadedScenario>();
  const server = buildServer({ library, questionBank: bank });
  servers.push(server);
  const create = (key: string, payload: Record<string, unknown> = {}, userId = "alice") => server.inject({
    method: "POST", url: "/v1/interview-sessions", headers: { "idempotency-key": key, "x-user-id": userId }, payload,
  });
  return { bank, library, server, create };
}

describe("database bank through the actual HTTP session path", () => {
  it("catalogue uses the bank and exposes only public metadata", async () => {
    const { server, bank } = fixture();
    const response = await server.inject({ method: "GET", url: "/v1/scenarios" });
    expect(bank.listActive).toHaveBeenCalledOnce();
    expect(response.json().scenarios[0]).toMatchObject({ ref: scenarioRef(question.version.id), level: "MID" });
    for (const hidden of ["conveyor", "oralBrief", "hiddenTests", "content_hash", "facts", "hintLadder"]) expect(response.body).not.toContain(hidden);
  });

  it("pulls a question at interview creation and pins it for the existing voice/runtime path", async () => {
    const { create, bank, library } = fixture();
    const result = await create("selected", { scenarioRef: scenarioRef(question.version.id) });
    expect(result.statusCode).toBe(201);
    expect(bank.get).toHaveBeenCalledWith(scenarioRef(question.version.id));
    expect(library.get(question.version.id)?.contentHash).toBe(question.contentHash);
    expect(result.body).not.toContain("openingScript");
  });

  it("can choose an active problem server-side without a candidate-selected ref", async () => {
    const { create, bank } = fixture();
    expect((await create("random")).statusCode).toBe(201);
    expect(bank.listActive).toHaveBeenCalledOnce();
  });

  it("retries an existing session even if the bank has become unavailable", async () => {
    const { create, bank } = fixture();
    const first = await create("retry");
    bank.listActive.mockRejectedValue(new QuestionBankError("UNAVAILABLE"));
    const retry = await create("retry");
    expect(retry.statusCode).toBe(201);
    expect(retry.json().sessionId).toBe(first.json().sessionId);
    expect(bank.listActive).toHaveBeenCalledOnce();
  });

  it("scopes creation idempotency to the user", async () => {
    const { create } = fixture();
    const alice = await create("same", {}, "alice");
    const bob = await create("same", {}, "bob");
    expect(alice.statusCode).toBe(201);
    expect(bob.statusCode).toBe(201);
    expect(bob.json().sessionId).not.toBe(alice.json().sessionId);
  });

  it("deduplicates simultaneous starts", async () => {
    const { create } = fixture();
    const results = await Promise.all([create("race"), create("race")]);
    expect(results.every((response) => response.statusCode === 201)).toBe(true);
    expect(results[0]!.json().sessionId).toBe(results[1]!.json().sessionId);
  });

  it("fails safely when the bank is empty or unavailable; no fallback question is invented", async () => {
    const { create, bank, server } = fixture();
    bank.listActive.mockResolvedValue([]);
    expect((await create("empty")).json().error).toBe("QUESTION_BANK_EMPTY");
    bank.listActive.mockRejectedValue(new QuestionBankError("UNAVAILABLE"));
    expect((await create("offline")).statusCode).toBe(503);
    expect((await server.inject({ method: "GET", url: "/v1/scenarios" })).statusCode).toBe(503);
  });

  it("will not start a retired question or overwrite a pinned version", async () => {
    const { create, bank, library } = fixture();
    const payload = { scenarioRef: scenarioRef(question.version.id) };
    expect((await create("first", payload)).statusCode).toBe(201);
    bank.get.mockResolvedValue({ ...question, version: { ...question.version, status: "RETIRED" } });
    expect((await create("retired", payload)).statusCode).toBe(409);
    bank.get.mockResolvedValue({ ...question, contentHash: `sha256:${"0".repeat(64)}` });
    expect((await create("mutated", payload)).statusCode).toBe(503);
    expect(library.get(question.version.id)?.contentHash).toBe(question.contentHash);
  });
});
