import type { ServerMessage, SessionEvent } from "@master-leeter/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { InterviewRuntime } from "../orchestrator/runtime.js";
import { FakeRunner, RunQueue } from "../runner/index.js";
import { loadScenarioFile } from "../scenario/loader.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { InMemorySessionStore } from "./session-store.js";
import { handleRunRequestedEvent } from "./runs.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, "../../../../../content/scenarios/conveyor-rescan/v1.yaml");

describe("handleRunRequestedEvent", () => {
  let store: InMemorySessionStore;
  let sessionId: string;
  let pushed: ServerMessage[];
  let runner: FakeRunner;
  let queue: RunQueue;
  const runContext = new Map<string, { sessionId: string; scenarioVersionId: string; traceId: string }>();

  beforeEach(async () => {
    store = new InMemorySessionStore();
    pushed = [];
    runner = new FakeRunner();
    runner.queueResult({ status: "PASSED", stdout: "ok" });

    queue = new RunQueue({
      runner,
      onResult: async (result) => {
        pushed.push({ kind: "RUN_RESULT", result });
      },
      onUnavailable: async () => {
        pushed.push({
          kind: "ERROR",
          code: "RUNNER_UNAVAILABLE",
          message: "Execution is temporarily unavailable. Keep going.",
        });
      },
    });

    const scenario = await loadScenarioFile(SCENARIO_PATH);
    const session = await store.create({
      userId: "u1",
      scenario,
      mode: "MOCK",
      idempotencyKey: "k1",
    });
    sessionId = session.id;
  });

  async function runtimeFor(id: string): Promise<InterviewRuntime | null> {
    const session = await store.get(id);
    if (!session) return null;
    const scenario = await loadScenarioFile(SCENARIO_PATH);
    const runtime = new InterviewRuntime({
      sessionId: session.id,
      scenario: scenario.version,
      policy: session.policy,
      scenarioVersionId: session.scenarioVersionId,
      traceId: session.traceId,
      events: { append: async () => ({ event: {} as SessionEvent, duplicate: false }) },
      remainingSeconds: () => 1800,
    });
    await runtime.ingest({
      sessionId,
      seq: 1,
      occurredAt: "2026-08-09T00:00:00.000Z",
      type: "CODE_DELTA",
      actor: "CANDIDATE",
      scenarioVersionId: session.scenarioVersionId,
      payload: { revision: 1, text: "print('hi')" },
      evidenceHash: "h",
      traceId: session.traceId,
    });
    return runtime;
  }

  const deps = () => ({
    queue,
    store,
    runtimeFor,
    runContext,
    pushToSession: (_id: string, msg: ServerMessage) => {
      pushed.push(msg);
    },
  });

  it("enqueues a run when the revision matches server code", async () => {
    await handleRunRequestedEvent(
      {
        sessionId,
        seq: 2,
        occurredAt: "2026-08-09T00:00:01.000Z",
        type: "RUN_REQUESTED",
        actor: "CANDIDATE",
        scenarioVersionId: (await store.get(sessionId))!.scenarioVersionId,
        payload: { revision: 1, input: "A7 B2" },
        evidenceHash: "h2",
        traceId: (await store.get(sessionId))!.traceId,
      },
      deps(),
    );

    expect(runner.executed).toHaveLength(1);
    expect(runner.executed[0]?.source).toBe("print('hi')");
    expect(runner.executed[0]?.stdin).toBe("A7 B2");
    await new Promise((r) => setImmediate(r));
    expect(pushed.some((m) => m.kind === "RUN_RESULT")).toBe(true);
  });

  it("reports an unknown revision without enqueueing", async () => {
    await handleRunRequestedEvent(
      {
        sessionId,
        seq: 2,
        occurredAt: "2026-08-09T00:00:01.000Z",
        type: "RUN_REQUESTED",
        actor: "CANDIDATE",
        scenarioVersionId: (await store.get(sessionId))!.scenarioVersionId,
        payload: { revision: 99, input: "" },
        evidenceHash: "h2",
        traceId: (await store.get(sessionId))!.traceId,
      },
      deps(),
    );

    expect(runner.executed).toHaveLength(0);
    expect(pushed.at(-1)).toMatchObject({ kind: "ERROR", code: "UNKNOWN_REVISION" });
  });
});
