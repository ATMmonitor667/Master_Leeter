import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InterviewScenarioVersion } from "@master-leeter/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { loadScenarioFile } from "../modules/scenario/loader.js";
import { ALL_TRAJECTORIES } from "../sim/trajectories.js";
import { assertAnnotationsResolve, runEvalSuite, scoreTrajectory } from "./harness.js";
import { DEFAULT_THRESHOLDS, checkThresholds } from "./metrics.js";
import { formatSuite, formatViolations } from "./report.js";

/**
 * The M4-4 gate: fails the build when interruption quality regresses.
 *
 * `sim.test.ts` asserts individual behaviours; this asserts the aggregate and
 * gives it a number. The annotations in `expectations.ts` were derived from what
 * sim.test.ts already asserts, so a failure here means one of two things:
 *
 *   1. the gate regressed — the normal case, and the point of the file
 *   2. a step label was renamed, which `assertAnnotationsResolve` catches first
 *
 * It should never mean "the annotation was a matter of opinion." Anything
 * genuinely arguable is annotated EITHER on purpose.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, "../../../../content/scenarios/conveyor-rescan/v1.yaml");

let scenario: InterviewScenarioVersion;

beforeAll(async () => {
  scenario = (await loadScenarioFile(SCENARIO_PATH)).version;
});

describe("annotation integrity", () => {
  it("every expectation maps to a real step label", () => {
    // Renaming a label silently downgrades its step to EITHER, which makes the
    // suite look better while measuring less.
    expect(() => assertAnnotationsResolve()).not.toThrow();
  });

  it("covers every trajectory in the suite", () => {
    const suite = runEvalSuite(scenario);
    expect(suite.bots).toHaveLength(ALL_TRAJECTORIES.length);
  });
});

describe("interruption metrics", () => {
  it("produces zero material unwanted interruptions", () => {
    const suite = runEvalSuite(scenario);
    expect(
      suite.materialUnwanted,
      formatSuite(suite) + formatViolations(suite),
    ).toBe(0);
  });

  it("answers every direct question — silence must not become unresponsiveness", () => {
    const suite = runEvalSuite(scenario);
    expect(suite.missed, formatSuite(suite) + formatViolations(suite)).toBe(0);
  });

  it("meets every threshold", () => {
    const suite = runEvalSuite(scenario);
    const failures = checkThresholds(suite, DEFAULT_THRESHOLDS);
    expect(failures, formatSuite(suite) + formatViolations(suite)).toEqual([]);
  });

  it("measures enough of the suite to mean something", () => {
    const suite = runEvalSuite(scenario);
    expect(suite.annotationCoverage).toBeGreaterThanOrEqual(
      DEFAULT_THRESHOLDS.minAnnotationCoverage,
    );
    // Both denominators must be non-trivial. A suite that only ever checks
    // silence would pass by never speaking, which is the degenerate solution.
    expect(suite.silenceOpportunities).toBeGreaterThanOrEqual(10);
    expect(suite.speechOpportunities).toBeGreaterThanOrEqual(8);
  });
});

describe("the long-thinker trajectory specifically", () => {
  it("never speaks — this is the metric the product lives or dies on", () => {
    const bot = ALL_TRAJECTORIES.find((b) => b.name === "long-thinker");
    expect(bot).toBeDefined();
    const m = scoreTrajectory(bot!, scenario);
    expect(m.unwanted, JSON.stringify(m.violations, null, 2)).toBe(0);
    expect(m.silenceOpportunities).toBe(bot!.steps.length);
  });
});

describe("determinism", () => {
  it("scores identically across runs", () => {
    // Replay determinism (CLAUDE.md) applies to the eval harness too: a metric
    // that drifts between runs cannot detect a regression.
    const a = runEvalSuite(scenario);
    const b = runEvalSuite(scenario);
    expect(a.materialUnwanted).toBe(b.materialUnwanted);
    expect(a.missed).toBe(b.missed);
    expect(a.unwantedPerHundredOpportunities).toBe(b.unwantedPerHundredOpportunities);
    expect(a.annotationCoverage).toBe(b.annotationCoverage);
  });
});
