/**
 * Interruption metrics (M4-4).
 *
 * Deliberately dependency-free and pure. Every function here is
 * `(data) => numbers` with no imports, no clock, and no I/O, so the scoring
 * logic can be verified independently of the gate, the scenario loader, and
 * vitest. If this file ever needs an import, the thing being added belongs in
 * `harness.ts` instead.
 *
 * ── On what these numbers can and cannot tell you ──────────────────────────
 *
 * The candidate bots are ADVERSARIALLY SAMPLED. Every step in a trajectory is a
 * moment chosen because a plausible implementation gets it wrong — twelve
 * consecutive one-second pauses, five clarifications in ninety seconds, four
 * injection attempts back to back. They are not a representative interview.
 *
 * That has a specific consequence for the headline metric in `CLAUDE.md`:
 *
 *   > Unwanted interruption rate: < 1 material unwanted interruption per 30-min mock
 *
 * Extrapolating a rate from a 35-second adversarial slice to 30 minutes produces
 * a number that is arithmetically correct and epistemically worthless — one
 * mistake in the long-thinker trajectory annualises to ~50 per 30 minutes.
 *
 * So this module reports three things and gates on the honest one:
 *
 *   1. `materialUnwanted` — absolute count. **This is what CI gates on, at 0.**
 *      The bots are curated so that every MUST_STAY_SILENT step is a moment a
 *      competent interviewer would definitely not speak. One is a bug.
 *   2. `unwantedPerHundredOpportunities` — stable, comparable across commits,
 *      the number to watch move when you tune a threshold.
 *   3. `extrapolatedPerThirtyMinutes` — reported for continuity with the metric
 *      table, labelled as an upper bound, and gated on nothing.
 *
 * The real per-30-minute rate can only come from sessions someone actually sat
 * through (M4-5b). This harness is how you avoid wasting those sessions on bugs
 * a fixture would have caught.
 */

/** Speaking when the annotation says silence was right. */
export type Expectation =
  /** A clear question, hint request, or direct address. Silence here is a miss. */
  | "MUST_SPEAK"
  /** Mid-thought, mid-typing, or otherwise not the interviewer's turn. */
  | "MUST_STAY_SILENT"
  /** Defensible either way. Excluded from both numerators, counted in coverage. */
  | "EITHER";

/**
 * Actions that are merely a bit annoying rather than genuinely damaging.
 *
 * An unsolicited "mm-hm" while someone is thinking is a blemish. An unsolicited
 * probe or hint derails the candidate's train of thought and, in the hint case,
 * silently spends a budget that scoring depends on. Both are unwanted; only the
 * second is material. The distinction is what the word "material" in the metric
 * table is doing, so it lives in code rather than in a comment.
 */
export const MINOR_ACTIONS: readonly string[] = ["ACKNOWLEDGE_BRIEFLY"];

export interface ScoredStep {
  botName: string;
  /** Seconds since session start. Used only for span, never for ordering. */
  at: number;
  label: string;
  action: string;
  reason: string;
  expectation: Expectation;
}

export interface Violation {
  botName: string;
  at: number;
  label: string;
  action: string;
  reason: string;
  kind: "UNWANTED_INTERRUPTION" | "MISSED_RESPONSE";
  material: boolean;
}

export interface BotMetrics {
  botName: string;
  steps: number;
  annotated: number;
  /** Steps where silence was required. The denominator for interruptions. */
  silenceOpportunities: number;
  /** Steps where a response was required. The denominator for misses. */
  speechOpportunities: number;
  unwanted: number;
  materialUnwanted: number;
  missed: number;
  /** Seconds between the first and last step. Zero for single-step bots. */
  spanSeconds: number;
  violations: Violation[];
}

export interface SuiteMetrics {
  bots: BotMetrics[];
  steps: number;
  annotated: number;
  /** Fraction of steps carrying a MUST_* annotation. Low coverage = weak signal. */
  annotationCoverage: number;
  silenceOpportunities: number;
  speechOpportunities: number;
  unwanted: number;
  materialUnwanted: number;
  missed: number;
  /** Unwanted interruptions per 100 chances to stay silent. The number to watch. */
  unwantedPerHundredOpportunities: number;
  /** Missed responses as a fraction of steps that required one. */
  missedResponseRate: number;
  /** Upper bound only — see the module comment. Gated on nothing. */
  extrapolatedPerThirtyMinutes: number;
  totalSpanSeconds: number;
  violations: Violation[];
}

const SILENT_ACTION = "STAY_SILENT";
const THIRTY_MINUTES = 30 * 60;

function isMaterial(action: string): boolean {
  return !MINOR_ACTIONS.includes(action);
}

/**
 * Classify one step against its annotation.
 *
 * Returns null when the step is consistent with what was expected, or when the
 * annotation declines to judge.
 */
export function violationFor(step: ScoredStep): Violation | null {
  const spoke = step.action !== SILENT_ACTION;

  if (step.expectation === "MUST_STAY_SILENT" && spoke) {
    return {
      botName: step.botName,
      at: step.at,
      label: step.label,
      action: step.action,
      reason: step.reason,
      kind: "UNWANTED_INTERRUPTION",
      material: isMaterial(step.action),
    };
  }

  if (step.expectation === "MUST_SPEAK" && !spoke) {
    return {
      botName: step.botName,
      at: step.at,
      label: step.label,
      action: step.action,
      reason: step.reason,
      kind: "MISSED_RESPONSE",
      // A missed answer to a direct question is always material. There is no
      // mild version of ignoring someone who asked you a question.
      material: true,
    };
  }

  return null;
}

export function scoreBot(botName: string, steps: readonly ScoredStep[]): BotMetrics {
  const violations: Violation[] = [];
  for (const step of steps) {
    const v = violationFor(step);
    if (v) violations.push(v);
  }

  const ats = steps.map((s) => s.at);
  const spanSeconds = ats.length > 1 ? Math.max(...ats) - Math.min(...ats) : 0;

  const unwanted = violations.filter((v) => v.kind === "UNWANTED_INTERRUPTION");

  return {
    botName,
    steps: steps.length,
    annotated: steps.filter((s) => s.expectation !== "EITHER").length,
    silenceOpportunities: steps.filter((s) => s.expectation === "MUST_STAY_SILENT").length,
    speechOpportunities: steps.filter((s) => s.expectation === "MUST_SPEAK").length,
    unwanted: unwanted.length,
    materialUnwanted: unwanted.filter((v) => v.material).length,
    missed: violations.filter((v) => v.kind === "MISSED_RESPONSE").length,
    spanSeconds,
    violations,
  };
}

export function scoreSuite(bots: readonly BotMetrics[]): SuiteMetrics {
  const sum = (pick: (b: BotMetrics) => number): number =>
    bots.reduce((acc, b) => acc + pick(b), 0);

  const steps = sum((b) => b.steps);
  const annotated = sum((b) => b.annotated);
  const silenceOpportunities = sum((b) => b.silenceOpportunities);
  const speechOpportunities = sum((b) => b.speechOpportunities);
  const unwanted = sum((b) => b.unwanted);
  const materialUnwanted = sum((b) => b.materialUnwanted);
  const missed = sum((b) => b.missed);
  const totalSpanSeconds = sum((b) => b.spanSeconds);

  // Guarded against zero denominators throughout: a suite with no silence
  // opportunities should report 0, not NaN. NaN in a CI gate passes every
  // comparison it is given, which is the worst possible failure mode for a
  // quality metric.
  return {
    bots: [...bots],
    steps,
    annotated,
    annotationCoverage: steps === 0 ? 0 : annotated / steps,
    silenceOpportunities,
    speechOpportunities,
    unwanted,
    materialUnwanted,
    missed,
    unwantedPerHundredOpportunities:
      silenceOpportunities === 0 ? 0 : (unwanted / silenceOpportunities) * 100,
    missedResponseRate: speechOpportunities === 0 ? 0 : missed / speechOpportunities,
    extrapolatedPerThirtyMinutes:
      totalSpanSeconds === 0 ? 0 : (materialUnwanted / totalSpanSeconds) * THIRTY_MINUTES,
    totalSpanSeconds,
    violations: bots.flatMap((b) => b.violations),
  };
}

export interface Thresholds {
  /** Absolute count across the suite. Zero, because the bots are curated. */
  maxMaterialUnwanted: number;
  /** Absolute count. A direct question going unanswered is never acceptable. */
  maxMissed: number;
  /** Includes minor actions, so this one has headroom for judgement calls. */
  maxUnwantedPerHundredOpportunities: number;
  /** Guards the harness itself: unannotated fixtures measure nothing. */
  minAnnotationCoverage: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  maxMaterialUnwanted: 0,
  maxMissed: 0,
  maxUnwantedPerHundredOpportunities: 5,
  minAnnotationCoverage: 0.8,
};

export interface ThresholdFailure {
  metric: string;
  actual: number;
  limit: number;
  detail: string;
}

/**
 * Compare a suite against thresholds.
 *
 * Returns failures rather than throwing, so the CLI can print the whole table
 * before exiting. A harness that dies on the first failure hides the other
 * three, and you fix them one commit at a time instead of all at once.
 */
export function checkThresholds(
  suite: SuiteMetrics,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): ThresholdFailure[] {
  const failures: ThresholdFailure[] = [];

  if (suite.materialUnwanted > thresholds.maxMaterialUnwanted) {
    failures.push({
      metric: "materialUnwanted",
      actual: suite.materialUnwanted,
      limit: thresholds.maxMaterialUnwanted,
      detail:
        "The interviewer spoke during a moment the fixtures mark as definitely-not-your-turn. " +
        "This is the metric the product lives or dies on (MVP.md, definition of done #2).",
    });
  }

  if (suite.missed > thresholds.maxMissed) {
    failures.push({
      metric: "missed",
      actual: suite.missed,
      limit: thresholds.maxMissed,
      detail:
        "A candidate asked a clear question and got silence. Silence-by-default must never " +
        "degrade into unresponsiveness — that is a different failure, not a safer one.",
    });
  }

  if (suite.unwantedPerHundredOpportunities > thresholds.maxUnwantedPerHundredOpportunities) {
    failures.push({
      metric: "unwantedPerHundredOpportunities",
      actual: Number(suite.unwantedPerHundredOpportunities.toFixed(2)),
      limit: thresholds.maxUnwantedPerHundredOpportunities,
      detail: "Includes minor actions such as unsolicited acknowledgement.",
    });
  }

  if (suite.annotationCoverage < thresholds.minAnnotationCoverage) {
    failures.push({
      metric: "annotationCoverage",
      actual: Number(suite.annotationCoverage.toFixed(3)),
      limit: thresholds.minAnnotationCoverage,
      detail:
        "Too many steps are marked EITHER. The harness is measuring less than it appears to — " +
        "a green run with low coverage is not evidence of anything.",
    });
  }

  return failures;
}
