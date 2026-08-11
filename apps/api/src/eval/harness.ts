import type { InterviewScenarioVersion } from "@master-leeter/contracts";
import { type CandidateBot, runBot } from "../sim/harness.js";
import { ALL_TRAJECTORIES } from "../sim/trajectories.js";
import { EXPECTATIONS, expectationFor } from "./expectations.js";
import { type ScoredStep, type SuiteMetrics, scoreBot, scoreSuite } from "./metrics.js";

/**
 * Glue between the candidate-bot simulator and the interruption metrics (M4-4).
 *
 * The simulator produces decisions; `expectations.ts` says what should have
 * happened; `metrics.ts` turns the disagreements into numbers. This file joins
 * the three and owns exactly one piece of real logic: making a lost annotation
 * loud (see `assertAnnotationsResolve`).
 */

export function scoreTrajectory(
  bot: CandidateBot,
  scenario: InterviewScenarioVersion,
): ReturnType<typeof scoreBot> {
  const run = runBot(bot, scenario);

  const steps: ScoredStep[] = run.results.map((r) => ({
    botName: bot.name,
    at: r.step.at,
    label: r.step.label,
    action: r.decision.action,
    reason: r.decision.reason,
    expectation: expectationFor(bot.name, r.step.label),
  }));

  return scoreBot(bot.name, steps);
}

export function runEvalSuite(
  scenario: InterviewScenarioVersion,
  bots: readonly CandidateBot[] = ALL_TRAJECTORIES,
): SuiteMetrics {
  return scoreSuite(bots.map((bot) => scoreTrajectory(bot, scenario)));
}

/**
 * Catch annotations that no longer match any step.
 *
 * Expectations are keyed by step label, which is a readable key and a fragile
 * one: renaming a label in `trajectories.ts` silently downgrades that step to
 * EITHER, and the suite goes *greener* as it measures less. That is the exact
 * failure mode where an eval harness becomes theatre, so it is checked rather
 * than commented about.
 *
 * Coverage thresholds catch the aggregate drift; this catches the specific typo
 * and tells you which key to fix.
 */
export function assertAnnotationsResolve(bots: readonly CandidateBot[] = ALL_TRAJECTORIES): void {
  const problems: string[] = [];

  for (const bot of bots) {
    const annotations = EXPECTATIONS[bot.name];
    if (!annotations) {
      problems.push(`no expectations defined for bot "${bot.name}"`);
      continue;
    }

    const labels = new Set(bot.steps.map((s) => s.label));
    for (const key of Object.keys(annotations)) {
      if (!labels.has(key)) {
        problems.push(`"${bot.name}" has an expectation for "${key}", which is not a step label`);
      }
    }
  }

  for (const botName of Object.keys(EXPECTATIONS)) {
    if (!bots.some((b) => b.name === botName)) {
      problems.push(`expectations exist for unknown bot "${botName}"`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`eval annotations are stale:\n  - ${problems.join("\n  - ")}`);
  }
}
