import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  type ScoredStep,
  checkThresholds,
  scoreBot,
  scoreSuite,
  violationFor,
} from "./metrics.js";

/**
 * Unit tests for the metric math (M4-4).
 *
 * Separate from `interruption.test.ts`, which runs the real gate. This file only
 * tests arithmetic, because a scoring bug here would silently make the real
 * suite look green — and a quality metric that fails open is worse than no
 * metric, since it also removes the motivation to look.
 */

const step = (over: Partial<ScoredStep> = {}): ScoredStep => ({
  botName: "fixture",
  at: 100,
  label: "a step",
  action: "STAY_SILENT",
  reason: "because",
  expectation: "EITHER",
  ...over,
});

describe("violationFor", () => {
  it("flags speech when silence was required", () => {
    const v = violationFor(step({ expectation: "MUST_STAY_SILENT", action: "ASK_PROBE" }));
    expect(v?.kind).toBe("UNWANTED_INTERRUPTION");
    expect(v?.material).toBe(true);
  });

  it("treats an unsolicited acknowledgement as unwanted but not material", () => {
    const v = violationFor(step({ expectation: "MUST_STAY_SILENT", action: "ACKNOWLEDGE_BRIEFLY" }));
    expect(v?.kind).toBe("UNWANTED_INTERRUPTION");
    expect(v?.material).toBe(false);
  });

  it("flags silence when a response was required, always as material", () => {
    const v = violationFor(step({ expectation: "MUST_SPEAK", action: "STAY_SILENT" }));
    expect(v?.kind).toBe("MISSED_RESPONSE");
    // There is no mild version of ignoring a direct question.
    expect(v?.material).toBe(true);
  });

  it("passes a correct silence", () => {
    expect(violationFor(step({ expectation: "MUST_STAY_SILENT" }))).toBeNull();
  });

  it("passes a correct response", () => {
    expect(violationFor(step({ expectation: "MUST_SPEAK", action: "ANSWER_CLARIFICATION" }))).toBeNull();
  });

  it("judges nothing when the annotation declines to", () => {
    expect(violationFor(step({ expectation: "EITHER", action: "ASK_PROBE" }))).toBeNull();
    expect(violationFor(step({ expectation: "EITHER", action: "STAY_SILENT" }))).toBeNull();
  });
});

describe("scoreBot", () => {
  it("counts opportunities by annotation, not by outcome", () => {
    const m = scoreBot("b", [
      step({ expectation: "MUST_STAY_SILENT" }),
      step({ expectation: "MUST_STAY_SILENT", action: "ASK_PROBE" }),
      step({ expectation: "MUST_SPEAK", action: "ASK_PROBE" }),
      step({ expectation: "EITHER" }),
    ]);

    expect(m.silenceOpportunities).toBe(2);
    expect(m.speechOpportunities).toBe(1);
    expect(m.annotated).toBe(3);
    expect(m.unwanted).toBe(1);
    expect(m.missed).toBe(0);
  });

  it("reports a zero span for a single-step bot rather than NaN", () => {
    expect(scoreBot("b", [step()]).spanSeconds).toBe(0);
  });

  it("measures span as first-to-last, not max", () => {
    const m = scoreBot("b", [step({ at: 70 }), step({ at: 105 })]);
    expect(m.spanSeconds).toBe(35);
  });
});

describe("scoreSuite", () => {
  it("returns zeroes, never NaN, for an empty suite", () => {
    const s = scoreSuite([]);
    // NaN passes every numeric comparison a threshold check makes, so a NaN here
    // would turn the CI gate into decoration.
    expect(s.unwantedPerHundredOpportunities).toBe(0);
    expect(s.missedResponseRate).toBe(0);
    expect(s.extrapolatedPerThirtyMinutes).toBe(0);
    expect(s.annotationCoverage).toBe(0);
    expect(Number.isNaN(s.unwantedPerHundredOpportunities)).toBe(false);
  });

  it("returns zero rates when a suite has no opportunities of that kind", () => {
    const s = scoreSuite([scoreBot("b", [step({ expectation: "EITHER" })])]);
    expect(s.unwantedPerHundredOpportunities).toBe(0);
    expect(s.missedResponseRate).toBe(0);
  });

  it("computes coverage across bots", () => {
    const s = scoreSuite([
      scoreBot("a", [step({ expectation: "MUST_STAY_SILENT" }), step({ expectation: "EITHER" })]),
      scoreBot("b", [step({ expectation: "MUST_SPEAK", action: "ASK_PROBE" })]),
    ]);
    expect(s.steps).toBe(3);
    expect(s.annotated).toBe(2);
    expect(s.annotationCoverage).toBeCloseTo(2 / 3);
  });

  it("extrapolates from material unwanted only", () => {
    // 1 material unwanted over a 60s span → 30 per 30 minutes.
    const s = scoreSuite([
      scoreBot("a", [
        step({ at: 0, expectation: "MUST_STAY_SILENT" }),
        step({ at: 60, expectation: "MUST_STAY_SILENT", action: "ASK_PROBE" }),
      ]),
    ]);
    expect(s.materialUnwanted).toBe(1);
    expect(s.extrapolatedPerThirtyMinutes).toBeCloseTo(30);
  });
});

describe("checkThresholds", () => {
  const clean = scoreSuite([
    scoreBot("a", [
      step({ at: 0, expectation: "MUST_STAY_SILENT" }),
      step({ at: 10, expectation: "MUST_SPEAK", action: "ASK_PROBE" }),
    ]),
  ]);

  it("passes a clean suite", () => {
    expect(checkThresholds(clean)).toEqual([]);
  });

  it("fails on a single material interruption", () => {
    const dirty = scoreSuite([
      scoreBot("a", [
        step({ at: 0, expectation: "MUST_STAY_SILENT", action: "GIVE_HINT_L1" }),
        step({ at: 10, expectation: "MUST_SPEAK", action: "ASK_PROBE" }),
      ]),
    ]);
    const failures = checkThresholds(dirty);
    expect(failures.map((f) => f.metric)).toContain("materialUnwanted");
  });

  it("fails on a missed response", () => {
    const dirty = scoreSuite([scoreBot("a", [step({ expectation: "MUST_SPEAK" })])]);
    expect(checkThresholds(dirty).map((f) => f.metric)).toContain("missed");
  });

  it("fails when annotation coverage collapses", () => {
    const thin = scoreSuite([
      scoreBot("a", [
        step({ expectation: "EITHER" }),
        step({ expectation: "EITHER" }),
        step({ expectation: "MUST_STAY_SILENT" }),
      ]),
    ]);
    expect(checkThresholds(thin).map((f) => f.metric)).toContain("annotationCoverage");
  });

  it("reports every failure, not just the first", () => {
    const bad = scoreSuite([
      scoreBot("a", [
        step({ at: 0, expectation: "MUST_STAY_SILENT", action: "GIVE_HINT_L1" }),
        step({ at: 5, expectation: "MUST_SPEAK" }),
        step({ at: 9, expectation: "EITHER" }),
        step({ at: 10, expectation: "EITHER" }),
      ]),
    ]);
    const metrics = checkThresholds(bad).map((f) => f.metric);
    expect(metrics).toContain("materialUnwanted");
    expect(metrics).toContain("missed");
    expect(metrics.length).toBeGreaterThanOrEqual(3);
  });

  it("respects custom thresholds", () => {
    const dirty = scoreSuite([
      scoreBot("a", [step({ at: 0, expectation: "MUST_STAY_SILENT", action: "ASK_PROBE" })]),
    ]);
    expect(checkThresholds(dirty, { ...DEFAULT_THRESHOLDS, maxMaterialUnwanted: 1 })
      .map((f) => f.metric)).not.toContain("materialUnwanted");
  });
});
