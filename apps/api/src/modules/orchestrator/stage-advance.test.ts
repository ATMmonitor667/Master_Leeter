import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  InterviewScenarioVersion,
  InterviewState,
  MilestoneKind,
  SessionEvent,
} from "@master-leeter/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InMemoryEventLog } from "../session/event-log.js";
import { loadScenarioFile } from "../scenario/loader.js";
import { POLICIES } from "./policy.js";
import { InterviewRuntime } from "./runtime.js";
import { type StageSignals, nextStage } from "./stage-advance.js";

/**
 * Stage advancement (M1-2b).
 *
 * The acceptance criterion for this ticket is at the bottom of the file, and it
 * is deliberately hostile to the way the bug hid: a session driven ONLY by
 * candidate events, with no test setting `state` by hand. Every trajectory in
 * `src/sim` sets it on every step, which is exactly why 32 green bots coexisted
 * with a state machine production could not move.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, "../../../../../content/scenarios/conveyor-rescan/v1.yaml");
const SESSION_ID = "00000000-0000-4000-8000-000000000000";

let scenario: InterviewScenarioVersion;

beforeAll(async () => {
  scenario = (await loadScenarioFile(SCENARIO_PATH)).version;
});

// ── The pure driver ──────────────────────────────────────────────────────────

function signals(overrides: Partial<StageSignals> = {}): StageSignals {
  return {
    state: "ORAL_PROBLEM_DELIVERY",
    policy: POLICIES.MOCK,
    briefDeliveryCount: 0,
    reasoningTurnsInStage: 0,
    latestCodeRevision: 0,
    approachCommitted: false,
    runsStarted: 0,
    milestones: [],
    remainingSeconds: 1800,
    followUpsPresented: 0,
    followUpsAvailable: 2,
    ...overrides,
  };
}

describe("nextStage moves the interview forward on evidence", () => {
  it("opens clarification once the brief is delivered, and not before", () => {
    expect(nextStage(signals())).toBeNull();
    expect(nextStage(signals({ briefDeliveryCount: 1 }))).toMatchObject({
      to: "CLARIFICATION",
    });
  });

  it("leaves clarification when the candidate commits to an approach", () => {
    const s = signals({ state: "CLARIFICATION", briefDeliveryCount: 1 });
    expect(nextStage(s)).toBeNull();
    expect(nextStage({ ...s, approachCommitted: true })).toMatchObject({
      to: "APPROACH_EXPLORATION",
    });
  });

  it("keeps the candidate in clarification through a single think-aloud", () => {
    // One turn is not evidence of having moved on, and leaving costs them the
    // right to ask for the problem again — DELIVER_BRIEF is not permitted past
    // this stage.
    const s = signals({ state: "CLARIFICATION", briefDeliveryCount: 1 });
    expect(nextStage({ ...s, reasoningTurnsInStage: 1 })).toBeNull();
    expect(nextStage({ ...s, reasoningTurnsInStage: 2 })).toMatchObject({
      to: "APPROACH_EXPLORATION",
    });
  });

  it("treats the editor as the vote for implementation", () => {
    expect(
      nextStage(
        signals({ state: "APPROACH_EXPLORATION", briefDeliveryCount: 1, latestCodeRevision: 3 }),
      ),
    ).toMatchObject({ to: "IMPLEMENTATION" });
  });

  it("enters test-and-debug when the candidate runs their code", () => {
    const s = signals({ state: "IMPLEMENTATION", briefDeliveryCount: 1, latestCodeRevision: 4 });
    expect(nextStage(s)).toBeNull();
    expect(nextStage({ ...s, runsStarted: 1 })).toMatchObject({ to: "TEST_AND_DEBUG" });
  });

  it("opens a follow-up only with a working solution and room to answer it", () => {
    const passing: MilestoneKind[] = ["BASE_TESTS_PASS"];
    const s = signals({
      state: "TEST_AND_DEBUG",
      briefDeliveryCount: 1,
      latestCodeRevision: 6,
      runsStarted: 2,
      milestones: passing,
    });

    expect(nextStage(s)).toMatchObject({ to: "FOLLOW_UP" });

    // Enough time to close, not enough to open something new.
    expect(nextStage({ ...s, remainingSeconds: 200 })).toBeNull();
    // Nothing left to ask.
    expect(nextStage({ ...s, followUpsPresented: 2 })).toBeNull();
    // Tests never passed.
    expect(nextStage({ ...s, milestones: [] })).toBeNull();
  });

  it("closes the follow-up stage once every authored branch is spent", () => {
    const s = signals({
      state: "FOLLOW_UP",
      briefDeliveryCount: 1,
      followUpsAvailable: 2,
      followUpsPresented: 1,
    });
    expect(nextStage(s)).toBeNull();
    expect(nextStage({ ...s, followUpsPresented: 2 })).toMatchObject({ to: "WRAP_UP" });
  });
});

describe("the clock closes a round the candidate never finishes", () => {
  it("walks toward wrap-up from wherever the session is", () => {
    const low = { briefDeliveryCount: 1, remainingSeconds: 60 };
    expect(nextStage(signals({ ...low, state: "IMPLEMENTATION" }))).toMatchObject({
      to: "TEST_AND_DEBUG",
    });
    expect(nextStage(signals({ ...low, state: "TEST_AND_DEBUG" }))).toMatchObject({
      to: "WRAP_UP",
    });
    expect(nextStage(signals({ ...low, state: "FOLLOW_UP" }))).toMatchObject({ to: "WRAP_UP" });
  });

  it("does not start the clock before the candidate has heard the problem", () => {
    // remainingSeconds is the full budget until the first transition sets
    // startedAt, so this can only fire on a session that actually opened.
    expect(nextStage(signals({ briefDeliveryCount: 0, remainingSeconds: 0 }))).toBeNull();
  });

  it("never advances out of a stage whose action set forbids it", () => {
    // WRAP_UP does not list TRANSITION_STAGE: a round leaves it by ending, not
    // by running down the clock further.
    expect(nextStage(signals({ state: "WRAP_UP", briefDeliveryCount: 1, remainingSeconds: 0 }))).toBeNull();
    expect(nextStage(signals({ state: "EVALUATION", briefDeliveryCount: 1 }))).toBeNull();
  });

  it("only ever returns a legal transition", () => {
    const states: InterviewState[] = [
      "ORAL_PROBLEM_DELIVERY",
      "CLARIFICATION",
      "APPROACH_EXPLORATION",
      "IMPLEMENTATION",
      "TEST_AND_DEBUG",
      "FOLLOW_UP",
      "WRAP_UP",
      "EVALUATION",
    ];

    // Every combination of the evidence flags, against every stage. The driver
    // must never propose a transition `applyEvent` would throw on.
    for (const state of states) {
      for (const brief of [0, 1]) {
        for (const code of [0, 5]) {
          for (const runs of [0, 1]) {
            for (const seconds of [0, 1800]) {
              for (const passed of [[], ["BASE_TESTS_PASS"] as MilestoneKind[]]) {
                const advance = nextStage(
                  signals({
                    state,
                    briefDeliveryCount: brief,
                    latestCodeRevision: code,
                    runsStarted: runs,
                    remainingSeconds: seconds,
                    milestones: passed,
                    approachCommitted: true,
                    reasoningTurnsInStage: 4,
                  }),
                );
                if (!advance) continue;
                expect(
                  ALLOWED[state],
                  `${state} -> ${advance.to} is not a legal transition`,
                ).toContain(advance.to);
                expect(advance.reason).toBeTruthy();
              }
            }
          }
        }
      }
    }
  });
});

const ALLOWED: Record<InterviewState, readonly InterviewState[]> = {
  ORAL_PROBLEM_DELIVERY: ["CLARIFICATION"],
  CLARIFICATION: ["APPROACH_EXPLORATION"],
  APPROACH_EXPLORATION: ["IMPLEMENTATION"],
  IMPLEMENTATION: ["TEST_AND_DEBUG"],
  TEST_AND_DEBUG: ["FOLLOW_UP", "WRAP_UP"],
  FOLLOW_UP: ["WRAP_UP"],
  WRAP_UP: ["EVALUATION"],
  EVALUATION: [],
};

// ── The acceptance criterion ─────────────────────────────────────────────────

describe("a session driven only by candidate events", () => {
  let log: InMemoryEventLog;
  let clock: number;
  let remaining: number;
  let transitions: Array<{ to: InterviewState; reason: string }>;

  beforeEach(() => {
    log = new InMemoryEventLog();
    clock = Date.parse("2026-08-09T00:00:00.000Z");
    remaining = 1800;
    transitions = [];
  });

  function build(): InterviewRuntime {
    return new InterviewRuntime({
      sessionId: SESSION_ID,
      scenario,
      policy: POLICIES.MOCK,
      scenarioVersionId: scenario.id,
      traceId: "trace-stage",
      events: log,
      remainingSeconds: () => remaining,
      now: () => clock,
      onTransition: (to, reason) => {
        transitions.push({ to, reason });
      },
    });
  }

  /** Append then ingest — the full path a client event takes. */
  async function feed(
    runtime: InterviewRuntime,
    type: SessionEvent["type"],
    payload: Record<string, unknown>,
    key: string,
  ): Promise<void> {
    const { event } = await log.append({
      sessionId: SESSION_ID,
      type,
      actor: type === "SESSION_STARTED" ? "SYSTEM" : "CANDIDATE",
      scenarioVersionId: scenario.id,
      payload,
      traceId: "trace-stage",
      idempotencyKey: key,
      occurredAt: new Date(clock).toISOString(),
    });
    await runtime.ingest(event);
  }

  const stagesIn = async (): Promise<string[]> =>
    (await log.read(SESSION_ID))
      .filter((e) => e.type === "STATE_TRANSITIONED")
      .map((e) => String(e.payload["to"]));

  it("reaches TEST_AND_DEBUG with nothing setting the stage by hand", async () => {
    const runtime = build();

    // 1. The interview opens. The gate authorizes the brief; delivering it is
    //    what makes clarification legal.
    await feed(runtime, "SESSION_STARTED", { mode: "MOCK" }, "start");
    await runtime.markSpeechFinished();
    expect(runtime.snapshotState().state).toBe("CLARIFICATION");

    // 2. The candidate asks something. Questions do not advance anything —
    //    clarification is a stage you leave by moving on, not by using it.
    await feed(runtime, "SPEECH_FINAL", { transcript: "is the list sorted?" }, "t1");
    expect(runtime.snapshotState().state).toBe("CLARIFICATION");

    // 3. They start reasoning aloud instead of asking.
    await feed(runtime, "SPEECH_FINAL", { transcript: "so I think a set would work here" }, "t2");
    await feed(runtime, "SPEECH_FINAL", { transcript: "and then one pass over the list" }, "t3");
    expect(runtime.snapshotState().state).toBe("APPROACH_EXPLORATION");

    // 4. They start typing. The editor is the vote.
    await feed(runtime, "CODE_DELTA", { revision: 1, text: "def first_rescan(r):\n    pass\n" }, "c1");
    expect(runtime.snapshotState().state).toBe("IMPLEMENTATION");

    // 5. They run it.
    await feed(runtime, "RUN_REQUESTED", { runId: "r1", revision: 1, inputHash: "h" }, "r1");
    expect(runtime.snapshotState().state).toBe("TEST_AND_DEBUG");

    await runtime.settled();

    // Every step is in the log, in order, each one legal.
    expect(await stagesIn()).toEqual([
      "CLARIFICATION",
      "APPROACH_EXPLORATION",
      "IMPLEMENTATION",
      "TEST_AND_DEBUG",
    ]);

    // And the session store was told, which is what starts the clock and what
    // the resume path reads.
    expect(transitions.map((t) => t.to)).toEqual([
      "CLARIFICATION",
      "APPROACH_EXPLORATION",
      "IMPLEMENTATION",
      "TEST_AND_DEBUG",
    ]);
    for (const t of transitions) expect(t.reason).toBeTruthy();
  });

  it("cascades legally when one event clears more than one stage", async () => {
    const runtime = build();
    await feed(runtime, "SESSION_STARTED", { mode: "MOCK" }, "start");
    await runtime.markSpeechFinished();

    // A candidate who says nothing and starts typing has passed through
    // approach exploration whether or not they spoke in it. Both transitions
    // are recorded; neither is skipped.
    await feed(runtime, "CODE_DELTA", { revision: 1, text: "def f():\n    return 1\n" }, "c1");

    expect(runtime.snapshotState().state).toBe("IMPLEMENTATION");
    expect(await stagesIn()).toEqual(["CLARIFICATION", "APPROACH_EXPLORATION", "IMPLEMENTATION"]);
    await runtime.settled();
  });

  it("closes the round when the clock runs out mid-implementation", async () => {
    const runtime = build();
    await feed(runtime, "SESSION_STARTED", { mode: "MOCK" }, "start");
    await runtime.markSpeechFinished();
    await feed(runtime, "CODE_DELTA", { revision: 1, text: "def f():\n    return 1\n" }, "c1");
    expect(runtime.snapshotState().state).toBe("IMPLEMENTATION");

    remaining = 45;
    await feed(runtime, "CODE_DELTA", { revision: 2, text: "def f():\n    return 2\n" }, "c2");

    expect(runtime.snapshotState().state).toBe("WRAP_UP");
    expect(await stagesIn()).toEqual([
      "CLARIFICATION",
      "APPROACH_EXPLORATION",
      "IMPLEMENTATION",
      "TEST_AND_DEBUG",
      "WRAP_UP",
    ]);
    await runtime.settled();
  });

  it("makes the interviewer able to answer a question it previously could not", async () => {
    // The point of the whole ticket. In ORAL_PROBLEM_DELIVERY the action set is
    // [STAY_SILENT, DELIVER_BRIEF, TRANSITION_STAGE], so a clarification was
    // structurally impossible no matter how clearly it was asked.
    const runtime = build();
    await feed(runtime, "SESSION_STARTED", { mode: "MOCK" }, "start");
    await runtime.markSpeechFinished();

    const { event } = await log.append({
      sessionId: SESSION_ID,
      type: "SPEECH_FINAL",
      actor: "CANDIDATE",
      scenarioVersionId: scenario.id,
      payload: { transcript: "is the list sorted?" },
      traceId: "trace-stage",
      idempotencyKey: "ask",
      occurredAt: new Date(clock).toISOString(),
    });
    const { decision } = await runtime.ingest(event);

    expect(decision?.action).toBe("ANSWER_CLARIFICATION");
    await runtime.settled();
  });

  it("does not re-enter a stage it has already left", async () => {
    const runtime = build();
    await feed(runtime, "SESSION_STARTED", { mode: "MOCK" }, "start");
    await runtime.markSpeechFinished();
    await feed(runtime, "CODE_DELTA", { revision: 1, text: "def f():\n    return 1\n" }, "c1");

    const before = (await stagesIn()).length;
    // More of the same evidence must not produce more transitions.
    await feed(runtime, "CODE_DELTA", { revision: 2, text: "def f():\n    return 2\n" }, "c2");
    expect((await stagesIn()).length).toBe(before);
    await runtime.settled();
  });
});
