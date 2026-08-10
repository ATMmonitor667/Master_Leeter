import { beforeAll, describe, expect, it } from "vitest";
import { CONTENT_ROOT, buildServer } from "./index.js";
import { FakeRunner } from "./modules/runner/index.js";
import { loadScenarioLibrary, scenarioRef } from "./modules/scenario/loader.js";
import type { LoadedScenario } from "./modules/scenario/loader.js";

/**
 * HTTP surface smoke tests.
 *
 * Thin on purpose — the interesting behavior lives in the domain modules and is
 * tested there. What these verify is that the wiring holds and, more
 * importantly, that nothing the candidate must not see leaks through a route.
 */

let library: Map<string, LoadedScenario>;

beforeAll(async () => {
  library = await loadScenarioLibrary(CONTENT_ROOT);
});

const app = () => buildServer({ library });

describe("scenario library boots", () => {
  it("loads every scenario in content/", async () => {
    expect(library.size).toBeGreaterThan(0);
    expect(library.has("conveyor-rescan@1")).toBe(true);
  });

  it("reports health with the loaded count", async () => {
    const res = await app().inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });
});

describe("GET /v1/scenarios", () => {
  it("returns the catalogue", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/scenarios" });
    expect(res.statusCode).toBe(200);
    expect(res.json().scenarios[0]).toMatchObject({
      ref: scenarioRef("conveyor-rescan@1"),
      level: "MID",
    });
  });

  it("leaks nothing the candidate must not read", async () => {
    // Invariant 2. The catalogue is a picker, not a preview — if any of this
    // reaches the browser, the product is a reading exercise again.
    const body = (await app().inject({ method: "GET", url: "/v1/scenarios" })).body;
    // Including the scenario id itself: "conveyor-rescan" gives away the
    // framing of a problem the candidate is meant to hear for the first time.
    for (const forbidden of ["openingScript", "oralBrief", "facts", "hiddenTests", "hintLadder", "probes", "conveyor", "rescan"]) {
      expect(body).not.toContain(forbidden);
    }
  });
});

describe("POST /v1/interview-sessions", () => {
  const create = (server: ReturnType<typeof app>, key: string, body?: Record<string, unknown>) =>
    server.inject({
      method: "POST",
      url: "/v1/interview-sessions",
      headers: { "idempotency-key": key },
      payload: { scenarioRef: scenarioRef("conveyor-rescan@1"), ...body },
    });

  it("creates a session", async () => {
    const res = await create(app(), "k1");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ state: "ORAL_PROBLEM_DELIVERY", mode: "MOCK" });
  });

  it("requires an idempotency key", async () => {
    const res = await app().inject({
      method: "POST",
      url: "/v1/interview-sessions",
      payload: { scenarioRef: scenarioRef("conveyor-rescan@1") },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("MISSING_IDEMPOTENCY_KEY");
  });

  it("returns the same session for a retried request", async () => {
    const server = app();
    const a = await create(server, "same-key");
    const b = await create(server, "same-key");
    expect(b.json().sessionId).toBe(a.json().sessionId);
  });

  it("404s an unknown scenario", async () => {
    const res = await create(app(), "k2", { scenarioRef: "scn_deadbeefdeadbeef" });
    expect(res.statusCode).toBe(404);
  });

  it("never returns the problem statement", async () => {
    const res = await create(app(), "k3");
    for (const forbidden of ["conveyor", "scanner", "package", "oralBrief", "openingScript"]) {
      expect(res.body).not.toContain(forbidden);
    }
  });
});

describe("POST /v1/interview-sessions/:id/end", () => {
  it("ends idempotently", async () => {
    const server = app();
    const created = await server.inject({
      method: "POST",
      url: "/v1/interview-sessions",
      headers: { "idempotency-key": "end-1" },
      payload: { scenarioRef: scenarioRef("conveyor-rescan@1") },
    });
    const { sessionId } = created.json();

    const first = await server.inject({ method: "POST", url: `/v1/interview-sessions/${sessionId}/end` });
    const second = await server.inject({ method: "POST", url: `/v1/interview-sessions/${sessionId}/end` });

    expect(first.statusCode).toBe(200);
    expect(second.json().endedAt).toBe(first.json().endedAt);
  });

  it("404s an unknown session", async () => {
    const res = await app().inject({
      method: "POST",
      url: "/v1/interview-sessions/00000000-0000-4000-8000-0000000000ff/end",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("routes still blocked on external decisions", () => {
  it("realtime token is explicit about why", async () => {
    const res = await app().inject({
      method: "POST",
      url: "/v1/interview-sessions/x/realtime-token",
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().issue).toBe("M3-1");
  });

});

describe("POST /v1/interview-sessions/:id/runs", () => {
  async function session(server: ReturnType<typeof app>) {
    const created = await server.inject({
      method: "POST",
      url: "/v1/interview-sessions",
      headers: { "idempotency-key": `run-${Math.random()}` },
      payload: { scenarioRef: scenarioRef("conveyor-rescan@1") },
    });
    return created.json().sessionId as string;
  }

  it("accepts a run and returns 202 — execution is asynchronous by design", async () => {
    const runner = new FakeRunner();
    runner.queueResult({ status: "PASSED", stdout: "B2" });
    const server = buildServer({ library, runner });

    const id = await session(server);
    const res = await server.inject({
      method: "POST",
      url: `/v1/interview-sessions/${id}/runs`,
      payload: { source: "print('B2')", revision: 3, input: "" },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ revision: 3 });
  });

  it("tells the candidate plainly when no runner is configured", async () => {
    // Without Judge0 the interview still runs. Refusing to start, or returning
    // an opaque 500, would turn missing infrastructure into a ruined session.
    const server = app();
    const id = await session(server);
    const res = await server.inject({
      method: "POST",
      url: `/v1/interview-sessions/${id}/runs`,
      payload: { source: "x", revision: 1, input: "" },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("RUNNER_UNAVAILABLE");
  });

  it("refuses runs after the session has ended", async () => {
    const runner = new FakeRunner();
    const server = buildServer({ library, runner });
    const id = await session(server);
    await server.inject({ method: "POST", url: `/v1/interview-sessions/${id}/end` });

    const res = await server.inject({
      method: "POST",
      url: `/v1/interview-sessions/${id}/runs`,
      payload: { source: "x", revision: 1, input: "" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("404s an unknown session", async () => {
    const runner = new FakeRunner();
    const server = buildServer({ library, runner });
    const res = await server.inject({
      method: "POST",
      url: "/v1/interview-sessions/00000000-0000-4000-8000-0000000000ff/runs",
      payload: { source: "x", revision: 1, input: "" },
    });
    expect(res.statusCode).toBe(404);
  });
});
