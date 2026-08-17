import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  type InterviewContext,
  type InterviewScenarioVersion,
  emptyCandidateState,
} from "@master-leeter/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { loadScenarioFile } from "../scenario/loader.js";
import { type GateDependencies, decideAction } from "./gate.js";
import { assertActionPermitted } from "./index.js";
import { POLICIES } from "./policy.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, "../../../../../content/scenarios/conveyor-rescan/v1.yaml");
const NOW = "2026-08-09T00:00:00.000Z";

let scenario: InterviewScenarioVersion;

beforeAll(async () => {
  scenario = (await loadScenarioFile(SCENARIO_PATH)).version;
});

function deps(overrides: Partial<GateDependencies> = {}): GateDependencies {
  return {
    scenario,
    probeUseCounts: {},
    followUpsUsed: [],
    solvedOptimally: false,
    // Default to an interview already underway. The opening is its own case and
    // is tested explicitly below; leaving it at 0 here would put every other
    // test one state-change away from a brief delivery it never asked for.
    briefDeliveryCount: 1,
    ...overrides,
  };
}

function ctx(overrides: Partial<InterviewContext> = {}): InterviewContext {
  return {
    sessionId: "00000000-0000-4000-8000-000000000000",
    state: "IMPLEMENTATION",
    policy: POLICIES.MOCK,
    candidateState: emptyCandidateState(NOW),
    turn: null,
    interviewerCurrentlySpeaking: false,
    candidateSpeechStarted: false,
    secondsSinceInterviewerLastSpoke: 120,
    secondsSinceCodeActivity: 60,
    remainingSeconds: 1200,
    hintsUsedCount: 0,
    latestCodeRevision: 12,
    scenarioVersionId: "conveyor-rescan@1",
    traceId: "trace-1",
    ...overrides,
  };
}

const turn = (transcript: string, intent: InterviewContext["turn"] extends null ? never : NonNullable<InterviewContext["turn"]>["intent"], p = 0.95) => ({
  turnId: "t1",
  finalized: true,
  transcript,
  semanticEndProbability: p,
  intent,
  intentProbabilities: { [intent]: 0.9 },
  endedAt: NOW,
});

describe("gate — silence guards run first", () => {
  it("stays silent with no turn", () => {
    expect(decideAction(ctx(), deps()).action).toBe("STAY_SILENT");
  });

  it("stays silent on an unfinalized turn, however confident", () => {
    const d = decideAction(
      ctx({ turn: { ...turn("is the list sorted", "CLARIFICATION_REQUEST", 0.99), finalized: false } }),
      deps(),
    );
    expect(d.action).toBe("STAY_SILENT");
    expect(d.reason).toMatch(/not finalized/);
  });

  it("stays silent mid-thought even for a question-shaped utterance", () => {
    const d = decideAction(ctx({ turn: turn("is the list sorted", "CLARIFICATION_REQUEST", 0.4) }), deps());
    expect(d.action).toBe("STAY_SILENT");
    expect(d.reason).toMatch(/below threshold/);
  });

  it("yields the floor on barge-in", () => {
    const d = decideAction(
      ctx({
        interviewerCurrentlySpeaking: true,
        candidateSpeechStarted: true,
        turn: turn("wait, actually", "THINK_ALOUD", 0.99),
      }),
      deps(),
    );
    expect(d.reason).toMatch(/barge-in/);
  });

  it("applies the mode's threshold, not a global one", () => {
    const t = turn("okay I think that's it", "DONE_SIGNAL", 0.82);
    expect(decideAction(ctx({ policy: POLICIES.MOCK, turn: t }), deps()).reason).not.toMatch(
      /below threshold/,
    );
    // Strict waits longer before accepting a turn has ended.
    expect(decideAction(ctx({ policy: POLICIES.STRICT, turn: t }), deps()).reason).toMatch(
      /below threshold/,
    );
  });
});

describe("gate — clarifications", () => {
  it("answers from a canonical fact", () => {
    const d = decideAction(
      ctx({ state: "CLARIFICATION", turn: turn("is the list sorted", "CLARIFICATION_REQUEST") }),
      deps(),
    );
    expect(d.action).toBe("ANSWER_CLARIFICATION");
    expect(d.factKey).toBe("ordering");
  });

  it("acknowledges rather than inventing when no fact exists", () => {
    const d = decideAction(
      ctx({ state: "CLARIFICATION", turn: turn("what algorithm should I use", "EXPLICIT_QUESTION") }),
      deps(),
    );
    expect(d.action).toBe("ACKNOWLEDGE_BRIEFLY");
    expect(d.factKey).toBeUndefined();
  });
});

describe("gate — hints", () => {
  it("gives the next allowed level on request", () => {
    const d = decideAction(
      ctx({ state: "TEST_AND_DEBUG", turn: turn("can I get a hint", "HINT_REQUEST") }),
      deps(),
    );
    expect(d.action).toBe("GIVE_HINT_L1");
    expect(d.hintLevel).toBe(1);
  });

  it("goes silent rather than repeating a hint once the ceiling is hit", () => {
    const d = decideAction(
      ctx({
        state: "TEST_AND_DEBUG",
        candidateState: { ...emptyCandidateState(NOW), hintsUsed: [1, 2] },
        turn: turn("can I get a hint", "HINT_REQUEST"),
      }),
      deps(),
    );
    expect(d.action).toBe("STAY_SILENT");
    expect(d.reason).toMatch(/exhausted/);
  });

  it("withholds entirely in a mode with no budget left", () => {
    const d = decideAction(
      ctx({
        state: "TEST_AND_DEBUG",
        policy: POLICIES.STRICT,
        candidateState: { ...emptyCandidateState(NOW), hintsUsed: [1] },
        turn: turn("any hint", "HINT_REQUEST"),
      }),
      deps(),
    );
    expect(d.action).toBe("STAY_SILENT");
  });
});

describe("gate — small talk is policy, not instinct", () => {
  const t = turn("this is fun, how's your day", "SOCIAL_SMALL_TALK");

  it("is ignored in Mock", () => {
    expect(decideAction(ctx({ state: "CLARIFICATION", turn: t }), deps()).action).toBe("STAY_SILENT");
  });

  it("is acknowledged in Learning", () => {
    expect(
      decideAction(ctx({ state: "CLARIFICATION", policy: POLICIES.LEARNING, turn: t }), deps()).action,
    ).toBe("ACKNOWLEDGE_BRIEFLY");
  });
});

describe("gate — stale code", () => {
  it("refuses to probe while the observer is behind and code is still moving", () => {
    const d = decideAction(
      ctx({
        latestCodeRevision: 20,
        secondsSinceCodeActivity: 2,
        candidateState: {
          ...emptyCandidateState(NOW),
          derivedFromRevision: 12,
          codeObservedAt: NOW,
          claimedTime: "O(1)",
          detectedSolutionFamilyId: "sf-set-single-pass",
        },
        turn: turn("this is all constant time", "COMPLEXITY_CLAIM"),
      }),
      deps(),
    );
    expect(d.action).toBe("STAY_SILENT");
    expect(d.reason).toMatch(/observer behind/);
  });

  it("probes once the observer has caught up", () => {
    const d = decideAction(
      ctx({
        latestCodeRevision: 20,
        secondsSinceCodeActivity: 40,
        candidateState: {
          ...emptyCandidateState(NOW),
          derivedFromRevision: 20,
          codeObservedAt: NOW,
          claimedTime: "O(1)",
          detectedSolutionFamilyId: "sf-set-single-pass",
        },
        turn: turn("this is all constant time", "COMPLEXITY_CLAIM"),
      }),
      deps(),
    );
    expect(d.action).toBe("ASK_PROBE");
    expect(d.groundedInRevision).toBe(20);
  });
});

describe("gate — pacing", () => {
  it("suppresses an otherwise justified probe that comes too soon", () => {
    const d = decideAction(
      ctx({
        secondsSinceInterviewerLastSpoke: 5,
        candidateState: {
          ...emptyCandidateState(NOW),
          derivedFromRevision: 12,
          codeObservedAt: NOW,
          claimedTime: "O(1)",
          detectedSolutionFamilyId: "sf-set-single-pass",
        },
        turn: turn("constant time overall", "COMPLEXITY_CLAIM"),
      }),
      deps(),
    );
    expect(d.action).toBe("STAY_SILENT");
    expect(d.reason).toMatch(/since last utterance/);
  });
});

describe("gate — state limits override everything", () => {
  it("will not hint during oral delivery even when asked", () => {
    const d = decideAction(
      ctx({ state: "ORAL_PROBLEM_DELIVERY", turn: turn("give me a hint", "HINT_REQUEST") }),
      deps(),
    );
    expect(d.action).toBe("STAY_SILENT");
    expect(d.reason).toMatch(/not permitted/);
  });

  it("will not answer clarifications during oral delivery", () => {
    const d = decideAction(
      ctx({ state: "ORAL_PROBLEM_DELIVERY", turn: turn("is the list sorted", "CLARIFICATION_REQUEST") }),
      deps(),
    );
    expect(d.action).toBe("STAY_SILENT");
  });

  it("is silent in EVALUATION no matter what arrives", () => {
    for (const intent of ["EXPLICIT_QUESTION", "HINT_REQUEST", "CONFUSION"] as const) {
      const d = decideAction(ctx({ state: "EVALUATION", turn: turn("anything", intent) }), deps());
      expect(d.action).toBe("STAY_SILENT");
    }
  });
});

describe("orchestrator is the policy authority", () => {
  it("throws when an action bypasses the gate into a state that forbids it", () => {
    expect(() =>
      assertActionPermitted(ctx({ state: "ORAL_PROBLEM_DELIVERY" }), {
        action: "GIVE_HINT_L1",
        reason: "model asked for it",
        decidedByRule: false,
      }),
    ).toThrow(/not permitted/);
  });

  it("permits silence everywhere it is legal", () => {
    expect(() =>
      assertActionPermitted(ctx(), { action: "STAY_SILENT", reason: "…", decidedByRule: true }),
    ).not.toThrow();
  });
});

describe("the oral brief (M3-4)", () => {
  /**
   * The one utterance that is not a response.
   *
   * Every other rule in the gate answers something the candidate did. The brief
   * has no turn behind it — the candidate is waiting to hear the problem — so an
   * interview that only spoke in response would never start at all.
   */
  it("opens the interview before any turn exists", () => {
    const decision = decideAction(
      ctx({ state: "ORAL_PROBLEM_DELIVERY", turn: null }),
      deps({ briefDeliveryCount: 0 }),
    );

    expect(decision.action).toBe("DELIVER_BRIEF");
  });

  it("delivers it once, not on every event", () => {
    const decision = decideAction(
      ctx({ state: "ORAL_PROBLEM_DELIVERY", turn: null }),
      deps({ briefDeliveryCount: 1 }),
    );

    expect(decision.action).toBe("STAY_SILENT");
  });

  it("does not talk over itself while already delivering", () => {
    const decision = decideAction(
      ctx({ state: "ORAL_PROBLEM_DELIVERY", turn: null, interviewerCurrentlySpeaking: true }),
      deps({ briefDeliveryCount: 0 }),
    );

    expect(decision.action).toBe("STAY_SILENT");
  });

  it("repeats on request, from the reviewed variants", () => {
    const decision = decideAction(
      ctx({
        state: "CLARIFICATION",
        turn: turn("sorry, can you say that again", "EXPLICIT_QUESTION"),
      }),
      deps({ briefDeliveryCount: 1 }),
    );

    expect(decision.action).toBe("DELIVER_BRIEF");
  });

  it("does not re-read the problem over a working candidate", () => {
    // The matcher is narrow on purpose: re-delivering the brief because someone
    // said "again" mid-sentence is a worse interruption than most.
    const decision = decideAction(
      ctx({
        state: "IMPLEMENTATION",
        turn: turn("let me try that again with a set", "THINK_ALOUD"),
      }),
      deps({ briefDeliveryCount: 1 }),
    );

    expect(decision.action).not.toBe("DELIVER_BRIEF");
  });
});

describe("activity-aware policy (M4-3)", () => {
  const working = {
    ...emptyCandidateState(NOW),
    derivedFromRevision: 12,
    codeObservedAt: NOW,
    claimedTime: "O(1)",
    detectedSolutionFamilyId: "sf-set-single-pass",
    implementationProgress: 0.8,
  };

  /**
   * Finishing a sentence is not the same as being free.
   *
   * A probe that lands between two keystrokes is an interruption even when the
   * turn genuinely ended, and it is the kind a candidate remembers.
   */
  it("holds an otherwise justified probe while the candidate is typing", () => {
    const d = decideAction(
      ctx({
        candidateState: working,
        secondsSinceCodeActivity: 1,
        turn: turn("this is all constant time", "COMPLEXITY_CLAIM"),
      }),
      deps(),
    );

    expect(d.action).toBe("STAY_SILENT");
    expect(d.reason).toMatch(/code activity/);
  });

  it("asks it once the hands have stopped", () => {
    const d = decideAction(
      ctx({
        candidateState: working,
        secondsSinceCodeActivity: 30,
        turn: turn("this is all constant time", "COMPLEXITY_CLAIM"),
      }),
      deps(),
    );

    expect(d.action).toBe("ASK_PROBE");
  });

  /**
   * The suppression is for UNSOLICITED speech only. Someone who asks a question
   * mid-edit still asked one, and making them wait for an idle editor would read
   * as not having heard them — missed-response is tracked too.
   */
  it("still answers a question asked mid-keystroke", () => {
    const d = decideAction(
      ctx({
        state: "CLARIFICATION",
        secondsSinceCodeActivity: 0.2,
        turn: turn("is the list sorted", "CLARIFICATION_REQUEST"),
      }),
      deps(),
    );

    expect(d.action).toBe("ANSWER_CLARIFICATION");
  });

  it("still gives a requested hint mid-keystroke", () => {
    const d = decideAction(
      ctx({
        state: "TEST_AND_DEBUG",
        secondsSinceCodeActivity: 0.2,
        turn: turn("can I get a hint", "HINT_REQUEST"),
      }),
      deps(),
    );

    expect(d.action).toBe("GIVE_HINT_L1");
  });

  it("offers help unprompted once a working candidate has gone quiet long enough", () => {
    const d = decideAction(
      ctx({
        state: "TEST_AND_DEBUG",
        candidateState: { ...working, claimedTime: null, detectedSolutionFamilyId: null },
        // Well past MOCK's 90s stall point, so the ramp has run.
        secondsSinceCodeActivity: 200,
        turn: turn("hmm", "THINK_ALOUD"),
      }),
      deps(),
    );

    expect(d.action).toBe("GIVE_HINT_L1");
    expect(d.reason).toMatch(/stuck score/);
  });

  /**
   * The condition that stops this becoming an impatience rule.
   *
   * A quiet editor during approach exploration is the stage working as intended
   * — the candidate is thinking, and usually talking while they do it. Without
   * the progress requirement the long-thinker trajectory earns a hint for the
   * crime of thinking before typing.
   */
  it("does not read thinking-before-typing as a stall", () => {
    const d = decideAction(
      ctx({
        state: "APPROACH_EXPLORATION",
        candidateState: { ...emptyCandidateState(NOW), implementationProgress: 0 },
        secondsSinceCodeActivity: 600,
        turn: turn("so I could compare everything against everything", "THINK_ALOUD"),
      }),
      deps(),
    );

    expect(d.action).toBe("STAY_SILENT");
  });

  it("waits longer in Strict than in Learning before either", () => {
    // Patience is part of a mode's character, expressed as numbers.
    expect(POLICIES.STRICT.interruptQuietSeconds).toBeGreaterThan(
      POLICIES.LEARNING.interruptQuietSeconds,
    );
    expect(POLICIES.STRICT.stallSeconds).toBeGreaterThan(POLICIES.LEARNING.stallSeconds);
  });
});
