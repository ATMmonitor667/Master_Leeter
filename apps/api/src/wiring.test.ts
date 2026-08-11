import type { AddressInfo } from "node:net";
import type { SessionEvent } from "@master-leeter/contracts";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTENT_ROOT, buildServer } from "./index.js";
import type { IntentClassifier } from "./modules/orchestrator/index.js";
import { loadScenarioLibrary, scenarioRef } from "./modules/scenario/loader.js";
import type { LoadedScenario } from "./modules/scenario/loader.js";

/**
 * Wiring tests.
 *
 * These exist because of a failure this project has now made twice: a component
 * is built, unit-tested, marked complete — and never connected. The integration
 * pass found `decideAction` with exactly one caller (the simulator). M4-2 found
 * `classifierFromEnv` with no caller at all, so every real session ran on the
 * rule stub while `CLASSIFIER_MODEL` was read by nothing.
 *
 * Both were invisible: typecheck clean, every unit test green, the server
 * booting and serving requests. Unit tests answer "does this work?" — nothing
 * was asking "is this reachable?"
 *
 * So these listen on a real port and speak over a real socket. Injecting into
 * the HTTP surface would not do: the path being verified only exists over
 * WebSocket, and a test that mocked the transport would have passed on the
 * broken code too. Deliberately end-to-end, deliberately shallow.
 */

let library: Map<string, LoadedScenario>;

/** Declared, not inferred — inferring it from `startServer` is circular. */
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

/** Records that it was called, so "was it reached?" is answerable. */
function spyClassifier(): IntentClassifier & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: "spy-classifier-v1",
    calls,
    classify(input) {
      calls.push(input.transcript);
      return {
        intent: "CLARIFICATION_REQUEST" as const,
        intentProbabilities: { CLARIFICATION_REQUEST: 0.95 },
        // High enough to clear every mode's end-of-turn threshold, so a silent
        // result means the wiring is broken rather than the gate being cautious.
        semanticEndProbability: 0.97,
        classifierId: "spy-classifier-v1",
      };
    },
  };
}

async function startServer(classifier?: IntentClassifier): Promise<ServerHandle> {
  const app = buildServer({ library, ...(classifier ? { classifier } : {}) });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  const handle: ServerHandle = { app, port };
  servers.push(handle);
  return handle;
}

async function createSession(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/interview-sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": `w-${Math.random()}` },
    body: JSON.stringify({ scenarioRef: scenarioRef("conveyor-rescan@1") }),
  });
  const body = (await res.json()) as { sessionId: string };
  return body.sessionId;
}

/** Speaks one finalized turn over the real socket and waits for its ACK. */
async function speak(port: number, sessionId: string, transcript: string): Promise<void> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/interview-sessions/${sessionId}/events`);

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  const acked = new Promise<void>((resolve) => {
    socket.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.kind === "ACK") resolve();
    });
  });

  socket.send(
    JSON.stringify({
      sessionId,
      clientSeq: 0,
      idempotencyKey: `sp-${Math.random()}`,
      type: "SPEECH_FINAL",
      occurredAt: new Date().toISOString(),
      payload: { transcript, finalized: true, turnId: "t0" },
    }),
  );

  await acked;
  // Dispatch to the runtime is fire-and-forget after the ACK, so the decision
  // may not be recorded yet. Yield rather than sleep on a fixed number.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 50));
  socket.close();
}

async function eventsOf(port: number, sessionId: string) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/privacy/sessions/${sessionId}/export`);
  const body = (await res.json()) as {
    events?: Array<Pick<SessionEvent, "type" | "payload">>;
  };
  return body.events ?? [];
}

describe("the classifier reaches the runtime", () => {
  it("is called for a finalized turn arriving over the socket", async () => {
    const classifier = spyClassifier();
    const { port } = await startServer(classifier);
    const sessionId = await createSession(port);

    await speak(port, sessionId, "is the list sorted");

    // The assertion that would have caught the M4-1 wiring gap. Without the
    // thread-through this is empty and every other test still passes.
    expect(classifier.calls, "classifier was never reached from a live session").toContain(
      "is the list sorted",
    );
  });

  it("records which classifier decided, so a session can be audited later", async () => {
    const classifier = spyClassifier();
    const { port } = await startServer(classifier);
    const sessionId = await createSession(port);

    await speak(port, sessionId, "can duplicates appear");

    const decided = (await eventsOf(port, sessionId)).filter((e) => e.type === "ACTION_DECIDED");
    expect(decided.length, "no decision was recorded for a finalized turn").toBeGreaterThan(0);
    expect(decided.at(-1)?.payload["classifierId"]).toBe("spy-classifier-v1");
  });

  it("falls back to the rule stub when none is supplied, rather than failing", async () => {
    // Booting unconfigured is a supported state. It must degrade, not break.
    const { port } = await startServer();
    const sessionId = await createSession(port);

    await speak(port, sessionId, "is the list sorted");

    const decided = (await eventsOf(port, sessionId)).filter((e) => e.type === "ACTION_DECIDED");
    expect(decided.length).toBeGreaterThan(0);
    expect(String(decided.at(-1)?.payload["classifierId"])).toMatch(/^stub-/);
  });
});
