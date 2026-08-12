import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEvent } from "@master-leeter/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { loadScenarioFile } from "../scenario/loader.js";
import type { LoadedScenario } from "../scenario/loader.js";
import { InMemoryEventLog } from "../session/event-log.js";
import type { IntentClassifier } from "./classifier.js";
import { policyFor } from "./policy.js";
import { InterviewRuntime, type RuntimeResult } from "./runtime.js";
import { silenceRequiredFor } from "./turn-completion.js";

/**
 * The defect: the gate ran once per turn, at whatever moment the transcript
 * finalized.
 *
 * Browser transcription finalizes a few hundred milliseconds after the candidate
 * stops. MOCK needs ~2.4 s of quiet before a non-question turn can read as
 * finished. So every think-aloud turn was judged too early, held, and never
 * looked at again — the interviewer stayed silent until the candidate spoke
 * next, which is what "long gaps before it reacts" was.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const SCENARIO_PATH = join(here, "../../../../../content/scenarios/conveyor-rescan/v1.yaml");
const SESSION = "00000000-0000-4000-8000-0000000000aa";

let scenario: LoadedScenario;

beforeAll(async () => {
  scenario = await loadScenarioFile(SCENARIO_PATH);
});

/** Confident words, so only the clock is ever in question. */
const confident: IntentClassifier = {
  id: "confident-stub",
  classify: () => ({
    intent: "COMPLEXITY_CLAIM",
    intentProbabilities: { COMPLEXITY_CLAIM: 0.95 },
    semanticEndProbability: 0.95,
    classifierId: "confident-stub",
  }),
};

interface Harness {
  runtime: InterviewRuntime;
  log: InMemoryEventLog;
  timers: Array<{ fn: () => void; ms: number }>;
  authorized: RuntimeResult[];
  feed: (type: SessionEvent["type"], payload: Record<string, unknown>, atMs: number) => Promise<RuntimeResult>;
  decisions: () => Promise<Array<Record<string, unknown>>>;
}

function build(): Harness {
  const log = new InMemoryEventLog();
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const authorized: RuntimeResult[] = [];
  let seq = 0;

  const runtime = new InterviewRuntime({
    sessionId: SESSION,
    scenario: scenario.version,
    policy: policyFor("MOCK"),
    scenarioVersionId: scenario.version.id,
    traceId: "t",
    events: log,
    remainingSeconds: () => 1_500,
    classifier: confident,
    now: () => 0,
    schedule: (fn, ms) => {
      timers.push({ fn, ms });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    onAuthorized: (result) => {
      authorized.push(result);
    },
  });

  const feed = async (
    type: SessionEvent["type"],
    payload: Record<string, unknown>,
    atMs: number,
  ): Promise<RuntimeResult> => {
    const { event } = await log.append({
      sessionId: SESSION,
      type,
      actor: type.startsWith("SPEECH") ? "CANDIDATE" : "SYSTEM",
      scenarioVersionId: scenario.version.id,
      payload,
      traceId: "t",
      idempotencyKey: `${type}:${seq++}`,
      occurredAt: new Date(atMs).toISOString(),
    });
    return runtime.ingest(event);
  };

  return {
    runtime,
    log,
    timers,
    authorized,
    feed,
    decisions: async () =>
      (await log.read(SESSION)).filter((e) => e.type === "ACTION_DECIDED").map((e) => e.payload),
  };
}

/** Candidate stops, then the transcript lands `afterMs` later. */
async function stopThenFinalize(h: Harness, afterMs: number): Promise<void> {
  await h.feed("SPEECH_STOPPED", {}, 10_000);
  await h.feed("SPEECH_FINAL", { transcript: "so the whole thing is linear time", finalized: true }, 10_000 + afterMs);
}

describe("a turn held only by the clock is judged again", () => {
  it("holds when the transcript finalizes before the floor", async () => {
    const h = build();
    await stopThenFinalize(h, 400);

    const decided = await h.decisions();
    expect(decided).toHaveLength(1);
    expect(decided[0]?.["action"]).toBe("STAY_SILENT");
    expect(String(decided[0]?.["turnEndReason"])).toMatch(/^held:/);
  });

  it("schedules a second look rather than giving up on the turn", async () => {
    const h = build();
    await stopThenFinalize(h, 400);

    expect(h.timers, "no re-evaluation was scheduled — the turn is lost").toHaveLength(1);

    // Waits until the ramp actually permits the threshold, not until `settled`,
    // which would add dead air for no benefit.
    const required = silenceRequiredFor(policyFor("MOCK").endOfTurnThreshold, policyFor("MOCK"));
    expect(h.timers[0]?.ms).toBeCloseTo(required - 400 + 25, 0);
  });

  it("judges the turn again, and the clock no longer holds it", async () => {
    const h = build();
    await stopThenFinalize(h, 400);

    // The timer fires. `now` is pinned in this harness, so drive the logged
    // moment through the same path replay uses.
    await h.feed("SILENCE_ELAPSED", { turnId: "turn-1" }, 10_000 + 2_600);

    const decided = await h.decisions();
    expect(decided).toHaveLength(2);
    expect(decided[1]?.["reevaluated"]).toBe(true);

    // The point of the fix: the second look is not held by timing. What the gate
    // then decides is its own business — with no eligible probe it still stays
    // silent, and that is correct.
    const threshold = policyFor("MOCK").endOfTurnThreshold;
    expect(Number(decided[0]?.["semanticEndProbability"])).toBeLessThan(threshold);
    expect(Number(decided[1]?.["semanticEndProbability"])).toBeGreaterThanOrEqual(threshold);
  });

  it("does not re-judge a turn twice", async () => {
    const h = build();
    await stopThenFinalize(h, 400);

    await h.feed("SILENCE_ELAPSED", { turnId: "turn-1" }, 10_000 + 2_600);
    await h.feed("SILENCE_ELAPSED", { turnId: "turn-1" }, 10_000 + 3_600);

    // A second chance is a second chance to speak. One is the budget.
    expect(await h.decisions()).toHaveLength(2);
  });
});

describe("what must NOT be re-judged", () => {
  it("drops the held turn when the candidate resumes", async () => {
    const h = build();
    await stopThenFinalize(h, 400);
    expect(h.timers).toHaveLength(1);

    await h.feed("SPEECH_STARTED", {}, 10_500);
    await h.feed("SILENCE_ELAPSED", { turnId: "turn-1" }, 12_600);

    // Answering now would respond to a thought the candidate has continued.
    expect(await h.decisions()).toHaveLength(1);
  });

  it("drops the held turn on barge-in", async () => {
    const h = build();
    await stopThenFinalize(h, 400);

    await h.feed("BARGE_IN", {}, 10_500);
    await h.feed("SILENCE_ELAPSED", { turnId: "turn-1" }, 12_600);

    expect(await h.decisions()).toHaveLength(1);
  });

  it("supersedes a held turn when a new one arrives", async () => {
    const h = build();
    await stopThenFinalize(h, 400);
    await h.feed("SPEECH_FINAL", { transcript: "actually wait", finalized: true }, 11_000);

    await h.feed("SILENCE_ELAPSED", { turnId: "turn-1" }, 13_000);

    // The superseded turn is never revisited. The newer one may well be, and
    // that is the feature working rather than a leak.
    const decided = await h.decisions();
    const staleRejudged = decided.filter((d) => d["reevaluated"] === true && d["turnId"] === "turn-1");
    expect(staleRejudged).toHaveLength(0);
  });

  it("does not schedule when timing was never the reason", async () => {
    const h = build();
    // No SPEECH_STOPPED, so silence is unknown and the transcript decided alone.
    await h.feed("SPEECH_FINAL", { transcript: "so the whole thing is linear", finalized: true }, 10_000);

    expect(h.timers).toHaveLength(0);
  });
});

describe("replay determinism", () => {
  /**
   * The reason this is an event rather than a bare timer.
   *
   * Decisions must be a function of the log (MVP definition-of-done #8). A timer
   * would make them a function of how fast the process ran; the logged moment
   * makes replay reproduce the same answer.
   */
  it("reaches the same decision from the log, with no timer involved", async () => {
    const live = build();
    await stopThenFinalize(live, 400);
    await live.feed("SILENCE_ELAPSED", { turnId: "turn-1" }, 10_000 + 2_600);
    const original = await live.decisions();

    // Replay: feed the recorded stream into a fresh runtime whose scheduler
    // would throw if it were consulted.
    let replayTimersArmed = 0;
    const replayLog = new InMemoryEventLog();
    const replayed = new InterviewRuntime({
      sessionId: SESSION,
      scenario: scenario.version,
      policy: policyFor("MOCK"),
      scenarioVersionId: scenario.version.id,
      traceId: "t",
      events: replayLog,
      remainingSeconds: () => 1_500,
      classifier: confident,
      now: () => 0,
      /**
       * Records but never fires.
       *
       * Replay still *schedules* — that is the same code path the live session
       * runs — but nothing may fire, so every decision below has to come from
       * the logged SILENCE_ELAPSED. A replay harness should always inject this:
       * with the default `setTimeout`, replaying a log would arm real timers
       * that later append events into it.
       */
      schedule: () => {
        replayTimersArmed += 1;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    });

    for (const event of await live.log.read(SESSION)) {
      if (event.type === "ACTION_DECIDED") continue;
      await replayed.ingest(event);
    }

    const again = (await replayLog.read(SESSION))
      .filter((e) => e.type === "ACTION_DECIDED")
      .map((e) => e.payload);

    expect(again.map((d) => d["action"])).toEqual(original.map((d) => d["action"]));
    expect(again.map((d) => d["turnEndReason"])).toEqual(original.map((d) => d["turnEndReason"]));
    // Armed, never fired — so the reproduction came from the log alone.
    expect(replayTimersArmed).toBeGreaterThan(0);
  });
});
