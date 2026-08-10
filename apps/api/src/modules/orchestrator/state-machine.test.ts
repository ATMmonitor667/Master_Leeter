import { INTERVIEW_STATES, type InterviewState } from "@master-leeter/contracts";
import { describe, expect, it } from "vitest";
import {
  ForbiddenTransitionError,
  INITIAL_STATE,
  applyEvent,
  canSpeakIn,
  isTerminal,
} from "./state-machine.js";

describe("state machine", () => {
  it("starts in oral problem delivery", () => {
    expect(INITIAL_STATE).toBe("ORAL_PROBLEM_DELIVERY");
  });

  it("walks the full happy path", () => {
    const path: InterviewState[] = [
      "CLARIFICATION",
      "APPROACH_EXPLORATION",
      "IMPLEMENTATION",
      "TEST_AND_DEBUG",
      "FOLLOW_UP",
      "WRAP_UP",
      "EVALUATION",
    ];

    let state = INITIAL_STATE;
    for (const next of path) {
      const result = applyEvent({ state, eventType: "STATE_TRANSITIONED", requestedState: next });
      expect(result.changed).toBe(true);
      state = result.state;
    }
    expect(isTerminal(state)).toBe(true);
  });

  it("allows skipping the follow-up when time runs short", () => {
    const r = applyEvent({
      state: "TEST_AND_DEBUG",
      eventType: "STATE_TRANSITIONED",
      requestedState: "WRAP_UP",
    });
    expect(r.state).toBe("WRAP_UP");
  });

  it("refuses to move backwards", () => {
    expect(() =>
      applyEvent({
        state: "IMPLEMENTATION",
        eventType: "STATE_TRANSITIONED",
        requestedState: "CLARIFICATION",
      }),
    ).toThrow(ForbiddenTransitionError);
  });

  it("refuses to skip ahead past clarification", () => {
    expect(() =>
      applyEvent({
        state: "ORAL_PROBLEM_DELIVERY",
        eventType: "STATE_TRANSITIONED",
        requestedState: "IMPLEMENTATION",
      }),
    ).toThrow(ForbiddenTransitionError);
  });

  it("does not change stage on ordinary events", () => {
    for (const eventType of ["CODE_DELTA", "SPEECH_FINAL", "RUN_COMPLETED", "MILESTONE"] as const) {
      const r = applyEvent({ state: "IMPLEMENTATION", eventType });
      expect(r.changed).toBe(false);
      expect(r.state).toBe("IMPLEMENTATION");
    }
  });

  it("can end from any stage", () => {
    for (const state of INTERVIEW_STATES) {
      expect(applyEvent({ state, eventType: "SESSION_ENDED" }).state).toBe("EVALUATION");
    }
  });

  it("throws when a transition event omits its target", () => {
    expect(() => applyEvent({ state: "CLARIFICATION", eventType: "STATE_TRANSITIONED" })).toThrow(
      /missing requestedState/,
    );
  });

  it("reports that the evaluator cannot speak", () => {
    expect(canSpeakIn("EVALUATION")).toBe(false);
    expect(canSpeakIn("IMPLEMENTATION")).toBe(true);
  });

  it("returns the allowed action set alongside the state", () => {
    const r = applyEvent({
      state: "ORAL_PROBLEM_DELIVERY",
      eventType: "STATE_TRANSITIONED",
      requestedState: "CLARIFICATION",
    });
    expect(r.allowedActions).toContain("ANSWER_CLARIFICATION");
    expect(r.allowedActions).not.toContain("GIVE_HINT_L1");
  });
});
