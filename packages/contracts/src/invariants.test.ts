import { describe, expect, it } from "vitest";
import {
  ALLOWED_ACTIONS,
  ALLOWED_TRANSITIONS,
  ClarificationResultSchema,
  GateDecisionSchema,
  INTERVIEW_ACTIONS,
  INTERVIEW_STATES,
  InterviewScenarioVersionSchema,
  SILENT,
  SessionEventSchema,
  emptyCandidateState,
  isActionAllowed,
  isTransitionAllowed,
} from "./index.js";

/**
 * These are not schema tests. They are the product's invariants, executable.
 * If one of these fails, something load-bearing has drifted.
 */

describe("invariant 1 — silence is a first-class action", () => {
  it("every non-terminal state permits STAY_SILENT", () => {
    for (const state of INTERVIEW_STATES) {
      if (state === "EVALUATION") continue;
      expect(ALLOWED_ACTIONS[state]).toContain("STAY_SILENT");
    }
  });

  it("the silent helper always produces a rule-decided decision with a reason", () => {
    const d = SILENT("turn not finalized");
    expect(GateDecisionSchema.parse(d)).toMatchObject({
      action: "STAY_SILENT",
      decidedByRule: true,
    });
  });

  it("a decision without a reason is rejected — including silence", () => {
    expect(() =>
      GateDecisionSchema.parse({ action: "STAY_SILENT", reason: "", decidedByRule: true }),
    ).toThrow();
  });
});

describe("invariant 5 — the live interviewer never grades", () => {
  it("EVALUATION cannot speak into the live round", () => {
    expect(ALLOWED_ACTIONS.EVALUATION).toEqual([]);
    for (const action of INTERVIEW_ACTIONS) {
      expect(isActionAllowed("EVALUATION", action)).toBe(false);
    }
  });

  it("EVALUATION is terminal", () => {
    expect(ALLOWED_TRANSITIONS.EVALUATION).toEqual([]);
  });
});

describe("per-state action limits", () => {
  it("ORAL_PROBLEM_DELIVERY cannot hint, probe, or present follow-ups", () => {
    for (const forbidden of [
      "GIVE_HINT_L1",
      "GIVE_HINT_L2",
      "ASK_PROBE",
      "PRESENT_FOLLOW_UP",
    ] as const) {
      expect(isActionAllowed("ORAL_PROBLEM_DELIVERY", forbidden)).toBe(false);
    }
  });

  it("CLARIFICATION cannot hint — answering a question is not teaching", () => {
    expect(isActionAllowed("CLARIFICATION", "GIVE_HINT_L1")).toBe(false);
    expect(isActionAllowed("CLARIFICATION", "GIVE_HINT_L2")).toBe(false);
  });

  it("IMPLEMENTATION does not permit L2 hints", () => {
    expect(isActionAllowed("IMPLEMENTATION", "GIVE_HINT_L2")).toBe(false);
  });

  it("only WRAP_UP can end the interview", () => {
    for (const state of INTERVIEW_STATES) {
      expect(isActionAllowed(state, "END_INTERVIEW")).toBe(state === "WRAP_UP");
    }
  });

  it("no state permits an action outside the known enum", () => {
    for (const state of INTERVIEW_STATES) {
      for (const action of ALLOWED_ACTIONS[state]) {
        expect(INTERVIEW_ACTIONS).toContain(action);
      }
    }
  });
});

describe("state machine — interviews move forward", () => {
  it("no state transitions to itself", () => {
    for (const state of INTERVIEW_STATES) {
      expect(isTransitionAllowed(state, state)).toBe(false);
    }
  });

  it("rejects representative illegal transitions", () => {
    expect(isTransitionAllowed("ORAL_PROBLEM_DELIVERY", "IMPLEMENTATION")).toBe(false);
    expect(isTransitionAllowed("IMPLEMENTATION", "CLARIFICATION")).toBe(false);
    expect(isTransitionAllowed("WRAP_UP", "FOLLOW_UP")).toBe(false);
  });

  it("every state except EVALUATION can reach a successor", () => {
    for (const state of INTERVIEW_STATES) {
      if (state === "EVALUATION") continue;
      expect(ALLOWED_TRANSITIONS[state].length).toBeGreaterThan(0);
    }
  });
});

describe("invariant 3 — clarifications come from canonical facts", () => {
  it("an unanswerable clarification has no free-text escape hatch", () => {
    const parsed = ClarificationResultSchema.parse({
      answerable: false,
      reason: "NOT_YET_DISCLOSABLE",
    });
    expect(parsed).not.toHaveProperty("value");
  });

  it("rejects an invented answer with no fact key", () => {
    expect(() =>
      ClarificationResultSchema.parse({ answerable: true, value: "sure, duplicates are fine" }),
    ).toThrow();
  });
});

describe("invariant 8 — append-only event log", () => {
  const base = {
    sessionId: "00000000-0000-4000-8000-000000000000",
    seq: 0,
    occurredAt: "2026-08-08T00:00:00.000Z",
    type: "SESSION_STARTED" as const,
    actor: "SYSTEM" as const,
    scenarioVersionId: "scn-1@1",
    payload: {},
    evidenceHash: "sha256:abc",
    traceId: "trace-1",
  };

  it("accepts a well-formed event", () => {
    expect(() => SessionEventSchema.parse(base)).not.toThrow();
  });

  it("rejects a negative sequence number", () => {
    expect(() => SessionEventSchema.parse({ ...base, seq: -1 })).toThrow();
  });

  it("requires a pinned scenario version on every event", () => {
    const { scenarioVersionId: _omitted, ...withoutVersion } = base;
    expect(() => SessionEventSchema.parse(withoutVersion)).toThrow();
  });

  it("requires an evidence hash and trace ID", () => {
    const { evidenceHash: _e, ...noHash } = base;
    const { traceId: _t, ...noTrace } = base;
    expect(() => SessionEventSchema.parse(noHash)).toThrow();
    expect(() => SessionEventSchema.parse(noTrace)).toThrow();
  });
});

describe("scenario content rules", () => {
  it("provenance is mandatory — hiding the text is not legal clearance", () => {
    expect(() =>
      InterviewScenarioVersionSchema.parse({
        id: "scn-1@1",
        scenarioId: "scn-1",
        version: 1,
        status: "DRAFT",
        target: { level: "MID", topics: ["hashing"], expectedMinutes: 40 },
        oralBrief: { openingScript: "…", repeatVariants: ["…"] },
        facts: [],
        examples: [],
        visibleStarterTests: [],
        hiddenTests: [],
        solutionFamilies: [
          {
            id: "sf-1",
            name: "hash map single pass",
            timeComplexity: "O(n)",
            spaceComplexity: "O(n)",
            recognitionSignals: [],
            invariants: [],
            failureModes: [],
          },
        ],
        probes: [],
        hintLadder: [1, 2, 3, 4].map((level) => ({ level, text: "…", scoreImpact: 0.1 })),
        followUps: [],
        rubricId: "rubric-coding-v1",
      }),
    ).toThrow(/provenance/i);
  });

  it("requires exactly four hint levels", () => {
    const ladder = [1, 2, 3].map((level) => ({ level, text: "…", scoreImpact: 0.1 }));
    const result = InterviewScenarioVersionSchema.shape.hintLadder.safeParse(ladder);
    expect(result.success).toBe(false);
  });

  it("requires at least one reviewed repeat variant so 'say that again' cannot leak", () => {
    const result = InterviewScenarioVersionSchema.shape.oralBrief.safeParse({
      openingScript: "…",
      repeatVariants: [],
    });
    expect(result.success).toBe(false);
  });

  it("a probe must carry authored wording — the model does not invent probes", () => {
    const result = InterviewScenarioVersionSchema.shape.probes.safeParse([
      { id: "p1", trigger: "claimed O(1)", questionIntent: "test complexity", authoredVariants: [] },
    ]);
    expect(result.success).toBe(false);
  });
});

describe("candidate state", () => {
  it("starts empty, unstuck, and with no hints used", () => {
    const s = emptyCandidateState("2026-08-08T00:00:00.000Z");
    expect(s.stuckScore).toBe(0);
    expect(s.hintsUsed).toEqual([]);
    expect(s.currentApproach).toBeNull();
    expect(s.derivedFromRevision).toBe(0);
  });
});
