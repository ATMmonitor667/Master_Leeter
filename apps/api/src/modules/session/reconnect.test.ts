import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadScenarioFile } from "../scenario/loader.js";
import type { LoadedScenario } from "../scenario/loader.js";
import { InMemoryEventLog } from "./event-log.js";
import {
  ABANDON_SECONDS,
  GRACE_SECONDS,
  isAbandoned,
  isTimerRunning,
  newLease,
  onDisconnect,
  onReconnect,
  pendingCredit,
} from "./lease.js";
import { reconstruct } from "./resume.js";
import { InMemorySessionStore } from "./session-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, "../../../../../content/scenarios/conveyor-rescan/v1.yaml");

const T0 = 1_754_000_000_000;
const at = (seconds: number) => T0 + seconds * 1000;

let scenario: LoadedScenario;

beforeAll(async () => {
  scenario = await loadScenarioFile(SCENARIO_PATH);
});

describe("connection lease — a blip is not an outage", () => {
  it("does not credit time for a short drop", () => {
    // Networks hiccup constantly. A timer that stopped and restarted every few
    // seconds would be more unsettling than one that loses two seconds.
    const dropped = onDisconnect(newLease(), at(0));
    const { creditedSeconds } = onReconnect(dropped, at(4));
    expect(creditedSeconds).toBe(0);
  });

  it("keeps the clock running during the grace window", () => {
    const dropped = onDisconnect(newLease(), at(0));
    expect(isTimerRunning(dropped, at(5))).toBe(true);
    expect(isTimerRunning(dropped, at(GRACE_SECONDS + 1))).toBe(false);
  });

  it("credits only the time beyond the grace window", () => {
    // Crediting from the first millisecond would let a flaky connection quietly
    // extend the interview.
    const dropped = onDisconnect(newLease(), at(0));
    const { creditedSeconds } = onReconnect(dropped, at(70));
    expect(creditedSeconds).toBe(70 - GRACE_SECONDS);
  });

  it("accumulates credit across several drops", () => {
    let lease = newLease();
    let total = 0;

    for (const start of [0, 200, 400]) {
      lease = onDisconnect(lease, at(start));
      const result = onReconnect(lease, at(start + 40));
      lease = result.lease;
      total += result.creditedSeconds;
    }

    expect(lease.pausedSeconds).toBe(total);
    expect(lease.dropCount).toBe(3);
  });

  it("ignores a second close event without restarting the window", () => {
    // Two close events in quick succession must not lose the credit already
    // accruing from the first.
    const first = onDisconnect(newLease(), at(0));
    const second = onDisconnect(first, at(30));
    expect(second.disconnectedAt).toBe(at(0));
    expect(second.dropCount).toBe(1);
  });

  it("reports pending credit while still disconnected", () => {
    const dropped = onDisconnect(newLease(), at(0));
    expect(pendingCredit(dropped, at(5))).toBe(0);
    expect(pendingCredit(dropped, at(45))).toBe(45 - GRACE_SECONDS);
  });

  it("is a no-op to reconnect an already-connected session", () => {
    const lease = newLease();
    const { lease: after, creditedSeconds } = onReconnect(lease, at(100));
    expect(creditedSeconds).toBe(0);
    expect(after).toEqual(lease);
  });

  it("treats a long absence as abandoned", () => {
    // An interview left open forever produces no report, and the evaluator can
    // only run on a session that actually finished.
    const dropped = onDisconnect(newLease(), at(0));
    expect(isAbandoned(dropped, at(60))).toBe(false);
    expect(isAbandoned(dropped, at(ABANDON_SECONDS))).toBe(true);
  });

  it("never reports a connected session as abandoned", () => {
    expect(isAbandoned(newLease(), at(ABANDON_SECONDS * 10))).toBe(false);
  });
});

describe("resume — rebuilt from the event log, not a cache", () => {
  let log: InMemoryEventLog;
  let store: InMemorySessionStore;
  let sessionId: string;

  const append = (type: Parameters<InMemoryEventLog["append"]>[0]["type"], payload: Record<string, unknown>, key: string) =>
    log.append({
      sessionId,
      type,
      actor: "CANDIDATE",
      scenarioVersionId: "conveyor-rescan@1",
      payload,
      traceId: "t",
      idempotencyKey: key,
    });

  beforeEach(async () => {
    log = new InMemoryEventLog();
    store = new InMemorySessionStore();
    const session = await store.create({
      userId: "u",
      scenario,
      mode: "MOCK",
      idempotencyKey: `k${Math.random()}`,
    });
    sessionId = session.id;
    await append("SESSION_STARTED", {}, "start");
  });

  it("returns null for a session with no events", async () => {
    expect(await reconstruct(log, "00000000-0000-4000-8000-0000000000ff", "IMPLEMENTATION")).toBeNull();
  });

  it("restores the latest code and its revision", async () => {
    await append("CODE_DELTA", { revision: 1, text: "def f():" }, "d1");
    await append("CODE_DELTA", { revision: 2, text: "def f():\n    pass" }, "d2");

    const resumed = await reconstruct(log, sessionId, "IMPLEMENTATION");
    expect(resumed?.code).toBe("def f():\n    pass");
    expect(resumed?.codeRevision).toBe(2);
  });

  it("does not let a late older delta overwrite newer code", async () => {
    // Out-of-order replay is a real possibility after a reconnect. The
    // candidate must never watch their work vanish.
    await append("CODE_DELTA", { revision: 5, text: "newest" }, "d5");
    await append("CODE_DELTA", { revision: 2, text: "stale" }, "d2");

    const resumed = await reconstruct(log, sessionId, "IMPLEMENTATION");
    expect(resumed?.code).toBe("newest");
    expect(resumed?.codeRevision).toBe(5);
  });

  it("restores notes", async () => {
    await append("NOTE_DELTA", { text: "duplicates allowed" }, "n1");
    expect((await reconstruct(log, sessionId, "IMPLEMENTATION"))?.notes).toBe("duplicates allowed");
  });

  it("restores the interview stage rather than restarting it", async () => {
    // Reconnecting must never advance or reset the interview. The scenario
    // does not silently move on because a socket died.
    await append("STATE_TRANSITIONED", { to: "TEST_AND_DEBUG" }, "s1");
    expect((await reconstruct(log, sessionId, "IMPLEMENTATION"))?.state).toBe("TEST_AND_DEBUG");
  });

  it("restores milestones so the UI does not re-announce them", async () => {
    await append("MILESTONE", { kind: "FIRST_COMPILES" }, "m1");
    await append("MILESTONE", { kind: "BASE_TESTS_PASS" }, "m2");
    await append("MILESTONE", { kind: "FIRST_COMPILES" }, "m3");

    const resumed = await reconstruct(log, sessionId, "IMPLEMENTATION");
    expect(resumed?.milestones).toEqual(["FIRST_COMPILES", "BASE_TESTS_PASS"]);
  });

  it("counts completed runs", async () => {
    await append("RUN_COMPLETED", { status: "FAILED" }, "r1");
    await append("RUN_COMPLETED", { status: "PASSED" }, "r2");
    expect((await reconstruct(log, sessionId, "IMPLEMENTATION"))?.runsCompleted).toBe(2);
  });

  it("reports the last sequence, so the client knows where to continue", async () => {
    await append("CODE_DELTA", { revision: 1, text: "x" }, "d1");
    const resumed = await reconstruct(log, sessionId, "IMPLEMENTATION");
    expect(resumed?.lastSeq).toBe(await log.latestSeq(sessionId));
  });

  it("flags an ended session so the client goes to the report", async () => {
    await append("SESSION_ENDED", {}, "end");
    const resumed = await reconstruct(log, sessionId, "IMPLEMENTATION");
    expect(resumed?.ended).toBe(true);
    expect(resumed?.state).toBe("EVALUATION");
  });

  it("ignores malformed payloads rather than throwing mid-restore", async () => {
    // A single bad event must not make a session unrecoverable.
    await append("CODE_DELTA", { revision: "not a number", text: 42 }, "bad");
    await append("CODE_DELTA", { revision: 1, text: "good" }, "good");

    const resumed = await reconstruct(log, sessionId, "IMPLEMENTATION");
    expect(resumed?.code).toBe("good");
  });

  it("is deterministic — the same log rebuilds the same screen", async () => {
    await append("CODE_DELTA", { revision: 1, text: "a" }, "d1");
    await append("NOTE_DELTA", { text: "n" }, "n1");

    const a = await reconstruct(log, sessionId, "IMPLEMENTATION");
    const b = await reconstruct(log, sessionId, "IMPLEMENTATION");
    expect(a).toEqual(b);
  });
});
