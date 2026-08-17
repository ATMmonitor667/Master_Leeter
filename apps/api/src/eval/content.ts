import type { InterviewScenarioVersion } from "@master-leeter/contracts";
import { loadScenarioLibrary } from "../modules/scenario/loader.js";
import { type FactualityViolation, checkScenarioFactuality } from "./factuality.js";
import { type LeakageViolation, checkScenarioLeakage } from "./leakage.js";
import type { ThresholdFailure } from "./metrics.js";

/**
 * Content eval (M4-4b) — glue between the checks in `factuality.ts` /
 * `leakage.ts` and the scenario library, mirroring how `harness.ts` glues the
 * bot suite to `metrics.ts` for M4-4.
 */

export interface ScenarioContentEval {
  scenarioId: string;
  status: InterviewScenarioVersion["status"];
  factualityViolations: FactualityViolation[];
  leakageViolations: LeakageViolation[];
}

export interface ContentEvalSuite {
  scenarios: ScenarioContentEval[];
  factualityViolations: FactualityViolation[];
  leakageViolations: LeakageViolation[];
}

/**
 * Runs both checks over every scenario VERSION under a content root — not only
 * ACTIVE ones. A session pinned to a retired version keeps running against it
 * (invariant 4: retire, don't edit), so a retired version's facts and hints
 * must stay honest for as long as any report might still reference it.
 */
export async function runContentEval(contentRoot: string): Promise<ContentEvalSuite> {
  const library = await loadScenarioLibrary(contentRoot);

  const scenarios: ScenarioContentEval[] = [...library.values()].map((loaded) => ({
    scenarioId: loaded.version.id,
    status: loaded.version.status,
    factualityViolations: checkScenarioFactuality(loaded.version),
    leakageViolations: checkScenarioLeakage(loaded.version),
  }));

  return {
    scenarios,
    factualityViolations: scenarios.flatMap((s) => s.factualityViolations),
    leakageViolations: scenarios.flatMap((s) => s.leakageViolations),
  };
}

/** Zero tolerance on both — this is the "fails the build on regression" half of M4-4b. */
export function checkContentThresholds(suite: ContentEvalSuite): ThresholdFailure[] {
  const failures: ThresholdFailure[] = [];

  if (suite.factualityViolations.length > 0) {
    failures.push({
      metric: "factualityViolations",
      actual: suite.factualityViolations.length,
      limit: 0,
      detail:
        "A clarification answer diverged from its canonical fact, arrived before its disclosure " +
        "level permits, or the matcher answered an off-topic question. CLAUDE.md invariant 3.",
    });
  }

  if (suite.leakageViolations.length > 0) {
    failures.push({
      metric: "leakageViolations",
      actual: suite.leakageViolations.length,
      limit: 0,
      detail:
        "A probe delivered wording outside its authored variants, or a hint exceeded a mode's " +
        "level ceiling or budget.",
    });
  }

  return failures;
}
