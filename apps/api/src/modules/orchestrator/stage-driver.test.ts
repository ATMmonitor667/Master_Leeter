import { describe, expect, it } from "vitest";
import { planStageTransitions } from "./stage-driver.js";

const base = {
  briefDelivered: true,
  solvedOptimally: false,
  followUpAvailable: true,
  remainingSeconds: 1_200,
} as const;

describe("automatic interview stage driver", () => {
  it("starts clarification only after the oral brief finishes", () => {
    expect(planStageTransitions({
      ...base,
      state: "ORAL_PROBLEM_DELIVERY",
      signal: { kind: "BRIEF_COMPLETED" },
    }).map(({ to }) => to)).toEqual(["CLARIFICATION"]);
  });

  it("moves the first substantive response through clarification into approach exploration", () => {
    expect(planStageTransitions({
      ...base,
      state: "ORAL_PROBLEM_DELIVERY",
      signal: { kind: "CANDIDATE_TURN", intent: "APPROACH_COMMITMENT", transcript: "I'll use a set" },
    }).map(({ to }) => to)).toEqual(["CLARIFICATION", "APPROACH_EXPLORATION"]);
  });

  it("keeps a first clarification in the clarification stage", () => {
    expect(planStageTransitions({
      ...base,
      state: "ORAL_PROBLEM_DELIVERY",
      signal: { kind: "CANDIDATE_TURN", intent: "CLARIFICATION_REQUEST", transcript: "Can it be empty?" },
    }).map(({ to }) => to)).toEqual(["CLARIFICATION"]);
  });

  it("lets an immediate code delta catch up through every legal stage", () => {
    expect(planStageTransitions({
      ...base,
      state: "ORAL_PROBLEM_DELIVERY",
      signal: { kind: "CODE_STARTED" },
    }).map(({ to }) => to)).toEqual(["CLARIFICATION", "APPROACH_EXPLORATION", "IMPLEMENTATION"]);
  });

  it("reaches test and debug from candidate events without a hand-set state", () => {
    expect(planStageTransitions({
      ...base,
      state: "ORAL_PROBLEM_DELIVERY",
      signal: { kind: "RUN_REQUESTED" },
    }).map(({ to }) => to)).toEqual([
      "CLARIFICATION",
      "APPROACH_EXPLORATION",
      "IMPLEMENTATION",
      "TEST_AND_DEBUG",
    ]);
  });

  it("branches to a follow-up only after an optimal solve with enough time", () => {
    expect(planStageTransitions({
      ...base,
      state: "TEST_AND_DEBUG",
      solvedOptimally: true,
      signal: { kind: "CANDIDATE_TURN", intent: "DONE_SIGNAL", transcript: "I'm done" },
    })).toMatchObject([{ from: "TEST_AND_DEBUG", to: "FOLLOW_UP" }]);
  });

  it("does not enter and leave follow-up on the same done signal", () => {
    const plans = planStageTransitions({
      ...base,
      state: "TEST_AND_DEBUG",
      solvedOptimally: true,
      signal: { kind: "CANDIDATE_TURN", intent: "DONE_SIGNAL", transcript: "I'm done" },
    });
    expect(plans).toHaveLength(1);
  });

  it("wraps up when time is low", () => {
    expect(planStageTransitions({
      ...base,
      state: "TEST_AND_DEBUG",
      remainingSeconds: 90,
      signal: { kind: "CANDIDATE_TURN", intent: "THINK_ALOUD", transcript: "one more check" },
    }).map(({ to }) => to)).toEqual(["WRAP_UP"]);
  });
});
