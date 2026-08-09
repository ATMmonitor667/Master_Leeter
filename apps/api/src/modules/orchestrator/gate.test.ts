import {
  type InterviewContext,
  type InterviewPolicy,
  emptyCandidateState,
} from "@master-leeter/contracts";
import { describe, expect, it } from "vitest";
import { assertActionPermitted, decideAction } from "./index.js";

const NOW = "2026-08-08T00:00:00.000Z";

const policy: InterviewPolicy = {
  mode: "MOCK",
  maxHintLevel: 2,
  hintBudget: 3,
  stallThreshold: 0.7,
  minSecondsBetweenProbes: 45,
  endOfTurnThreshold: 0.8,
  maxCodeStalenessSeconds: 20,
  expectedMinutes: 40,
};

function ctx(overrides: Partial<InterviewContext> = {}): InterviewContext {
  return {
    sessionId: "00000000-0000-4000-8000-000000000000",
    state: "IMPLEMENTATION",
    policy,
    candidateState: emptyCandidateState(NOW),
    turn: null,
    interviewerCurrentlySpeaking: false,
    candidateSpeechStarted: false,
    secondsSinceInterviewerLastSpoke: 120,
    secondsSinceCodeActivity: 2,
    remainingSeconds: 1200,
    hintsUsedCount: 0,
    latestCodeRevision: 12,
    scenarioVersionId: "scn-1@1",
    traceId: "trace-1",
    ...overrides,
  };
}

const finalizedTurn = (semanticEndProbability: number) => ({
  turnId: "t1",
  finalized: true,
  transcript: "so I think I'll use a map here",
  semanticEndProbability,
  intent: "THINK_ALOUD" as const,
  intentProbabilities: { THINK_ALOUD: 0.9 },
  endedAt: NOW,
});

describe("Response Gate — silence is the default", () => {
  it("stays silent when there is no turn at all", () => {
    expect(decideAction(ctx()).action).toBe("STAY_SILENT");
  });

  it("stays silent on a non-finalized turn", () => {
    const d = decideAction(ctx({ turn: { ...finalizedTurn(0.99), finalized: false } }));
    expect(d.action).toBe("STAY_SILENT");
    expect(d.reason).toMatch(/not finalized/);
  });

  it("stays silent when the candidate is mid-thought (below end threshold)", () => {
    const d = decideAction(ctx({ turn: finalizedTurn(0.4) }));
    expect(d.action).toBe("STAY_SILENT");
    expect(d.reason).toMatch(/below threshold/);
  });

  it("stays silent on barge-in rather than talking over the candidate", () => {
    const d = decideAction(
      ctx({
        interviewerCurrentlySpeaking: true,
        candidateSpeechStarted: true,
        turn: finalizedTurn(0.99),
      }),
    );
    expect(d.action).toBe("STAY_SILENT");
    expect(d.reason).toMatch(/barge-in/);
  });

  it("decides by rule, without a model call, in every current path", () => {
    for (const c of [ctx(), ctx({ turn: finalizedTurn(0.4) }), ctx({ turn: finalizedTurn(0.99) })]) {
      expect(decideAction(c).decidedByRule).toBe(true);
    }
  });

  it("always explains itself, including when silent", () => {
    expect(decideAction(ctx()).reason.length).toBeGreaterThan(0);
  });
});

describe("orchestrator is the policy authority", () => {
  it("throws when an action is not permitted in the current state", () => {
    expect(() =>
      assertActionPermitted(ctx({ state: "ORAL_PROBLEM_DELIVERY" }), {
        action: "GIVE_HINT_L1",
        reason: "model asked for it",
        decidedByRule: false,
      }),
    ).toThrow(/not permitted/);
  });

  it("throws when the evaluator tries to speak into the live round", () => {
    expect(() =>
      assertActionPermitted(ctx({ state: "EVALUATION" }), {
        action: "ACKNOWLEDGE_BRIEFLY",
        reason: "…",
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
