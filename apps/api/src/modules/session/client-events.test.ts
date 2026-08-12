import type { AddressInfo } from "node:net";
import { CLIENT_EVENT_TYPES, type SessionEvent } from "@master-leeter/contracts";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTENT_ROOT, buildServer } from "../../index.js";
import { loadScenarioLibrary, scenarioRef } from "../scenario/loader.js";
import type { LoadedScenario } from "../scenario/loader.js";
import { CLIENT_EVENT_DISPOSITIONS } from "./client-events.js";

/**
 * The seam between what a client may claim and what the server concludes.
 *
 * Driven over a real socket rather than through the channel directly. The
 * channel is where the schema check happens, so testing it there would prove the
 * check exists without proving it is reachable — which is the exact shape of
 * every wiring defect this project has hit.
 */

let library: Map<string, LoadedScenario>;

interface ServerHandle {
  app: ReturnType<typeof buildServer>;
  port: number;
}

const servers: ServerHandle[] = [];

beforeAll(async () => {
  library = await loadScenarioLibrary(CONTENT_ROOT);
});

afterAll(async () => {
  await Promise.all(servers.map((s) => s.app.close()));
});

async function startServer(): Promise<ServerHandle> {
  const app = buildServer({ library });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  const handle: ServerHandle = { app, port };
  servers.push(handle);
  return handle;
}

async function createSession(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/interview-sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": `ce-${Math.random()}` },
    body: JSON.stringify({ scenarioRef: scenarioRef("conveyor-rescan@1") }),
  });
  return ((await res.json()) as { sessionId: string }).sessionId;
}

/** Sends one frame and returns every server message that came back. */
async function send(
  port: number,
  sessionId: string,
  frame: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/interview-sessions/${sessionId}/events`);
  const received: Array<Record<string, unknown>> = [];

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  const settled = new Promise<void>((resolve) => {
    socket.on("message", (raw) => {
      received.push(JSON.parse(String(raw)) as Record<string, unknown>);
      resolve();
    });
    setTimeout(resolve, 400);
  });

  socket.send(JSON.stringify(frame));
  await settled;
  await new Promise((r) => setTimeout(r, 60));
  socket.close();

  return received;
}

async function eventsOf(port: number, sessionId: string): Promise<SessionEvent[]> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/privacy/sessions/${sessionId}/export`);
  const body = (await res.json()) as { events?: SessionEvent[] };
  return body.events ?? [];
}

describe("a client cannot write conclusions into the evidence log", () => {
  /**
   * The one that mattered most. A forged passing run does not merely inflate a
   * score: InterviewRuntime folds RUN_COMPLETED into the observer, which fires
   * BASE_TESTS_PASS, clears stuckScore, and flips solvedOptimally — so it moves
   * the live interviewer as well as the report.
   */
  it("refuses a forged RUN_COMPLETED and keeps it out of the log", async () => {
    const { port } = await startServer();
    const sessionId = await createSession(port);

    const replies = await send(port, sessionId, {
      sessionId,
      clientSeq: 0,
      idempotencyKey: "forge-run",
      type: "RUN_COMPLETED",
      occurredAt: new Date().toISOString(),
      payload: {
        runId: "forged",
        status: "PASSED",
        visibleTestsPassed: 5,
        visibleTestsTotal: 5,
      },
    });

    expect(replies.some((m) => m["kind"] === "ERROR")).toBe(true);
    expect(replies.some((m) => m["kind"] === "ACK")).toBe(false);

    const types = (await eventsOf(port, sessionId)).map((e) => e.type);
    expect(types, "a forged run reached the append-only log").not.toContain("RUN_COMPLETED");
  });

  it("refuses a forged MILESTONE", async () => {
    const { port } = await startServer();
    const sessionId = await createSession(port);

    await send(port, sessionId, {
      sessionId,
      clientSeq: 0,
      idempotencyKey: "forge-milestone",
      type: "MILESTONE",
      occurredAt: new Date().toISOString(),
      payload: { kind: "BASE_TESTS_PASS" },
    });

    const types = (await eventsOf(port, sessionId)).map((e) => e.type);
    expect(types).not.toContain("MILESTONE");
  });

  it("refuses a forged HINT_GIVEN, which would otherwise spend a budget scoring depends on", async () => {
    const { port } = await startServer();
    const sessionId = await createSession(port);

    await send(port, sessionId, {
      sessionId,
      clientSeq: 0,
      idempotencyKey: "forge-hint",
      type: "HINT_GIVEN",
      occurredAt: new Date().toISOString(),
      payload: { level: 1, scoreImpact: 0 },
    });

    const types = (await eventsOf(port, sessionId)).map((e) => e.type);
    expect(types).not.toContain("HINT_GIVEN");
  });

  it("still accepts the events a candidate legitimately produces", async () => {
    // The narrowing must not have cost the client anything real — a rule that
    // breaks the product is not a safer rule.
    const { port } = await startServer();
    const sessionId = await createSession(port);

    const replies = await send(port, sessionId, {
      sessionId,
      clientSeq: 0,
      idempotencyKey: "legit-code",
      type: "CODE_DELTA",
      occurredAt: new Date().toISOString(),
      payload: { revision: 1, text: "def f():\n    return 1\n" },
    });

    expect(replies.some((m) => m["kind"] === "ACK")).toBe(true);

    const types = (await eventsOf(port, sessionId)).map((e) => e.type);
    expect(types).toContain("CODE_DELTA");
  });
});

describe("every client-emittable event has a declared disposition", () => {
  /**
   * The generalizable form of the RUN_REQUESTED defect.
   *
   * Exhaustiveness is enforced by the Record's type, so this suite is the
   * runtime half: it catches a declaration that exists but says nothing, and it
   * states the rule in a place a reader will find it.
   */
  it("covers exactly the client event types, no more and no fewer", () => {
    expect(Object.keys(CLIENT_EVENT_DISPOSITIONS).sort()).toEqual([...CLIENT_EVENT_TYPES].sort());
  });

  it("says something specific about each one", () => {
    for (const [type, disposition] of Object.entries(CLIENT_EVENT_DISPOSITIONS)) {
      const detail =
        disposition.kind === "CONSUMED" ? disposition.by : disposition.why;
      expect(detail.length, `${type} has an empty disposition`).toBeGreaterThan(20);
    }
  });

  it("names a consumer for everything that drives a decision", () => {
    // NOTE_DELTA is the sole evidence-only type, and that is a design decision
    // (M2-5), not an omission. If a second one appears, it should be argued for
    // here rather than added quietly.
    const evidenceOnly = Object.entries(CLIENT_EVENT_DISPOSITIONS)
      .filter(([, d]) => d.kind === "EVIDENCE_ONLY")
      .map(([t]) => t);

    expect(evidenceOnly).toEqual(["NOTE_DELTA"]);
  });
});
