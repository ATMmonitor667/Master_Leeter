import type { AddressInfo } from "node:net";
import type { SessionEvent } from "@master-leeter/contracts";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTENT_ROOT, buildServer } from "./index.js";
import type { IntentClassifier } from "./modules/orchestrator/index.js";
import { loadScenarioLibrary, scenarioRef } from "./modules/scenario/loader.js";
import type { LoadedScenario } from "./modules/scenario/loader.js";
import { InMemoryEventLog } from "./modules/session/event-log.js";
import { InMemorySessionStore } from "./modules/session/session-store.js";

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
  eventLog: InMemoryEventLog;
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
  const eventLog = new InMemoryEventLog();
  const app = buildServer({ library, eventLog, ...(classifier ? { classifier } : {}) });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  const handle: ServerHandle = { app, port, eventLog };
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

/** Sends one client event over the real socket and waits for its ACK. */
async function send(
  port: number,
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
  clientSeq = 0,
): Promise<void> {
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
      clientSeq,
      idempotencyKey: `ev-${Math.random()}`,
      type,
      occurredAt: new Date().toISOString(),
      payload,
    }),
  );

  await acked;
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 50));
  socket.close();
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

async function eventsOf(port: number, sessionId: string): Promise<SessionEvent[]> {
  // Inspect committed evidence directly: a candidate export must not expose
  // private system/interviewer payloads just to make a wiring test convenient.
  return servers.find((server) => server.port === port)!.eventLog.read(sessionId);
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

describe("the interview state machine has a driver", () => {
  it("rebuilds from the session's pinned scenario when the active catalogue no longer has it", async () => {
    const store = new InMemorySessionStore();
    const pinned = library.get("conveyor-rescan@1")!;
    const session = await store.create({ userId: "local-dev-user", scenario: pinned, mode: "MOCK", idempotencyKey: "retired-pin" });
    const eventLog = new InMemoryEventLog();
    await eventLog.append({
      sessionId: session.id, type: "SESSION_STARTED", actor: "SYSTEM",
      scenarioVersionId: session.scenarioVersionId, payload: {}, traceId: session.traceId,
      idempotencyKey: `session-started:${session.id}`,
    });
    const app = buildServer({ library: new Map(), sessionStore: store, eventLog });
    await app.ready();
    try {
      const response = await app.inject({ method: "POST", url: `/v1/interview-sessions/${session.id}/voice-ready` });
      expect(response.statusCode).toBe(200);
      expect((await eventLog.read(session.id)).some((event) => event.type === "BRIEF_DELIVERED")).toBe(true);
    } finally {
      await app.close();
    }
  });

  /**
   * The M1-2b wiring gap, tested the only way that would have caught it.
   *
   * `applyEvent` was correct and exhaustively unit-tested while NOTHING ever
   * produced a `STATE_TRANSITIONED` event, so a live session pinned to
   * ORAL_PROBLEM_DELIVERY — where the action set is
   * [STAY_SILENT, DELIVER_BRIEF, TRANSITION_STAGE] — and the interviewer was
   * structurally incapable of saying anything for the rest of the round.
   *
   * The simulator could not see it: every scripted step sets `state` by hand.
   * So this drives the real HTTP surface and a real socket, and nothing here
   * names a stage except in an assertion.
   */
  async function stageOf(port: number, sessionId: string): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/v1/interview-sessions/${sessionId}`);
    return ((await res.json()) as { state: string }).state;
  }

  async function openInterview(port: number, sessionId: string): Promise<void> {
    await fetch(`http://127.0.0.1:${port}/v1/interview-sessions/${sessionId}/voice-ready`, {
      method: "POST",
    });
  }

  it("leaves ORAL_PROBLEM_DELIVERY once the candidate has heard the problem", async () => {
    const { port } = await startServer();
    const sessionId = await createSession(port);

    expect(await stageOf(port, sessionId)).toBe("ORAL_PROBLEM_DELIVERY");

    await openInterview(port, sessionId);

    // The assertion that fails on every commit before this one.
    expect(
      await stageOf(port, sessionId),
      "session never left the opening stage; the state machine has no driver",
    ).toBe("CLARIFICATION");
  });

  it("starts the interview clock, which nothing used to start", async () => {
    // `startedAt` is set by `SessionStore.transition`, and that method had no
    // callers — so `remainingSeconds` returned the full budget for the entire
    // interview and the candidate's timer never moved.
    const { port } = await startServer();
    const sessionId = await createSession(port);
    await openInterview(port, sessionId);

    await new Promise((r) => setTimeout(r, 1100));

    const res = await fetch(`http://127.0.0.1:${port}/v1/interview-sessions/${sessionId}`);
    const { remainingSeconds } = (await res.json()) as { remainingSeconds: number };
    const budget = library.get("conveyor-rescan@1")!.version.target.expectedMinutes * 60;

    expect(remainingSeconds).toBeLessThan(budget);
  });

  it("reaches TEST_AND_DEBUG from candidate events alone", async () => {
    const { port } = await startServer();
    const sessionId = await createSession(port);
    await openInterview(port, sessionId);

    const source = ["def f():", "    return 1", ""].join("\n");
    await send(port, sessionId, "CODE_DELTA", { revision: 1, text: source });
    expect(await stageOf(port, sessionId)).toBe("IMPLEMENTATION");

    // No runner is configured, and the stage still moves: asking for a run is
    // the candidate's act of testing, so a runner outage cannot pin them in
    // IMPLEMENTATION for the rest of the interview.
    await send(port, sessionId, "RUN_REQUESTED", { revision: 1, input: "" });
    expect(await stageOf(port, sessionId)).toBe("TEST_AND_DEBUG");

    // Each step is in the append-only log, so a replay sees the same path.
    const stages = (await eventsOf(port, sessionId))
      .filter((e) => e.type === "STATE_TRANSITIONED")
      .map((e) => String(e.payload["to"]));
    expect(stages).toEqual([
      "CLARIFICATION",
      "APPROACH_EXPLORATION",
      "IMPLEMENTATION",
      "TEST_AND_DEBUG",
    ]);
  });
});
