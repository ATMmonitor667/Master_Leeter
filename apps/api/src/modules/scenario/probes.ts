import type {
  FollowUp,
  Hint,
  InterviewPolicy,
  InterviewScenarioVersion,
  Probe,
} from "@master-leeter/contracts";
import { type TriggerContext, evaluateTrigger } from "./triggers.js";

/**
 * Probe eligibility and hint budget (M1-5).
 *
 * Everything here is deterministic. The reasoning reranker that picks among
 * several eligible probes lands in M5-4 — but eligibility itself must never be
 * a model decision, because "should the interviewer speak right now" is exactly
 * the judgment we refuse to delegate.
 */

export interface ProbeSelectionContext extends TriggerContext {
  policy: InterviewPolicy;
  /** How many times each probe has already been delivered this session. */
  probeUseCounts: Readonly<Record<string, number>>;
  secondsSinceInterviewerLastSpoke: number;
}

export function eligibleProbes(
  scenario: InterviewScenarioVersion,
  ctx: ProbeSelectionContext,
): Probe[] {
  return scenario.probes
    .filter((probe) => {
      const used = ctx.probeUseCounts[probe.id] ?? 0;
      if (used >= probe.maxUses) return false;
      return evaluateTrigger(probe.trigger, ctx);
    })
    .sort((a, b) => b.priority - a.priority);
}

export function highestPriorityEligibleProbe(
  scenario: InterviewScenarioVersion,
  ctx: ProbeSelectionContext,
): Probe | null {
  return eligibleProbes(scenario, ctx)[0] ?? null;
}

/**
 * Re-rank only the authored probes that deterministic eligibility admitted.
 *
 * This is deliberately a bounded relevance pass, not another gate. It cannot
 * invent wording, make an ineligible probe eligible, or override pacing and
 * silence rules. Scores are evidence strength plus the author's priority, with
 * source order as the replay-stable final tie-breaker.
 */
export function rerankEligibleProbes(
  scenario: InterviewScenarioVersion,
  ctx: ProbeSelectionContext,
): Probe[] {
  return eligibleProbes(scenario, ctx)
    .map((probe, index) => ({ probe, index, score: probeRelevance(probe, ctx) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ probe }) => probe);
}

export function selectRelevantProbe(
  scenario: InterviewScenarioVersion,
  ctx: ProbeSelectionContext,
): Probe | null {
  return rerankEligibleProbes(scenario, ctx)[0] ?? null;
}

function probeRelevance(probe: Probe, ctx: ProbeSelectionContext): number {
  const { candidateState: state } = ctx;
  let score = probe.priority * 10;

  if (probe.trigger.includes("COMPLEXITY_CLAIM_MISMATCH")) score += 50;
  if (
    probe.trigger.includes("claimedTime") &&
    state.claimedTime &&
    state.detectedSolutionFamilyId &&
    state.confidence.complexity >= 0.7
  ) {
    score += 45;
  }
  if (probe.trigger.includes("REPEATED_SAME_FAILURE")) score += 40;
  if (probe.trigger.includes("detectedFamily") && state.detectedSolutionFamilyId) score += 30;
  if (probe.trigger.includes("BASE_TESTS_PASS")) score += 25;
  if (probe.trigger.includes("currentApproach") && state.currentApproach) score += 20;
  if (probe.trigger.includes(`state == ${ctx.state}`)) score += 15;

  // Prefer evidence that has not already been discussed. maxUses still owns
  // hard eligibility; this only breaks ties before that ceiling is reached.
  score -= (ctx.probeUseCounts[probe.id] ?? 0) * 20;
  return score;
}

/**
 * Pacing guard.
 *
 * Eligibility says a probe is *justified*; this says whether now is an
 * acceptable moment. Two justified probes back to back is how an interviewer
 * stops feeling like an interviewer and starts feeling like an interrogation.
 */
export function canProbeNow(ctx: ProbeSelectionContext): boolean {
  return ctx.secondsSinceInterviewerLastSpoke >= ctx.policy.minSecondsBetweenProbes;
}

/**
 * Deterministic wording selection.
 *
 * Rotates through authored variants by use count so a candidate who triggers
 * the same probe twice does not hear the identical sentence — and so replay
 * stays deterministic, which a random pick would break (invariant: replay
 * determinism).
 */
export function selectProbeWording(probe: Probe, useCount: number): string {
  const variants = probe.authoredVariants;
  const index = useCount % variants.length;
  const wording = variants[index];
  if (!wording) throw new Error(`Probe "${probe.id}" has no authored variants`);
  return wording;
}

// ─── Hints ───────────────────────────────────────────────────────────────────

export interface HintContext {
  policy: InterviewPolicy;
  hintsUsed: readonly number[];
}

/**
 * The next hint level the policy permits, or null.
 *
 * Two independent limits, and both matter. `maxHintLevel` caps how *strong* a
 * hint can get — Strict mode never reaches L3 no matter how stuck the candidate
 * is. `hintBudget` caps how *many* are available at all. Exhausting either
 * returns null, and null means STAY_SILENT, never an unbudgeted hint.
 */
export function nextAllowedHintLevel(ctx: HintContext): number | null {
  if (ctx.policy.maxHintLevel === 0) return null;
  if (ctx.hintsUsed.length >= ctx.policy.hintBudget) return null;

  const highestUsed = ctx.hintsUsed.length > 0 ? Math.max(...ctx.hintsUsed) : 0;
  const next = highestUsed + 1;

  return next <= ctx.policy.maxHintLevel ? next : null;
}

export function getHint(scenario: InterviewScenarioVersion, level: number): Hint {
  const hint = scenario.hintLadder.find((h) => h.level === level);
  if (!hint) throw new Error(`Scenario ${scenario.id} has no hint at level ${level}`);
  return hint;
}

/** Cumulative score impact of the hints used. Recorded on the report, not applied live. */
export function accumulatedHintImpact(
  scenario: InterviewScenarioVersion,
  hintsUsed: readonly number[],
): number {
  return hintsUsed.reduce((sum, level) => {
    const hint = scenario.hintLadder.find((h) => h.level === level);
    return sum + (hint?.scoreImpact ?? 0);
  }, 0);
}

// ─── Follow-ups ──────────────────────────────────────────────────────────────

export function eligibleFollowUps(
  scenario: InterviewScenarioVersion,
  ctx: TriggerContext,
): FollowUp[] {
  return scenario.followUps.filter(
    (f) => !ctx.followUpsUsed.includes(f.id) && evaluateTrigger(f.trigger, ctx),
  );
}

export function selectFollowUp(
  scenario: InterviewScenarioVersion,
  ctx: TriggerContext,
): FollowUp | null {
  const performance = performanceStrength(ctx);
  return (
    eligibleFollowUps(scenario, ctx)
      .map((followUp, index) => ({
        followUp,
        index,
        // Strong sessions get the larger adaptation; struggling sessions get
        // the smaller one. Candidate-language overlap then prefers a branch
        // that genuinely extends the approach they discussed.
        distance: Math.abs(challengeWeight(followUp) - performance),
        relevance: followUpRelevance(followUp, ctx),
      }))
      .sort(
        (a, b) =>
          a.distance - b.distance || b.relevance - a.relevance || a.index - b.index,
      )[0]?.followUp ?? null
  );
}

function performanceStrength(ctx: TriggerContext): number {
  const state = ctx.candidateState;
  let score = state.implementationProgress * 2;
  if (ctx.solvedOptimally) score += 2;
  if (state.milestonesReached.includes("BASE_TESTS_PASS")) score += 1;
  score -= state.hintsUsed.length * 0.5;
  score -= state.stuckScore;
  return Math.max(0, Math.min(5, score));
}

function challengeWeight(followUp: FollowUp): number {
  const rubricWeight = Object.values(followUp.rubricDelta).reduce(
    (sum, value) => sum + Math.abs(value),
    0,
  );
  const lengthWeight = Math.min(2, followUp.expectedAdaptation.length / 180);
  return Math.min(5, rubricWeight + lengthWeight);
}

function followUpRelevance(followUp: FollowUp, ctx: TriggerContext): number {
  const candidateWords = tokens(
    [
      ctx.candidateState.currentApproach ?? "",
      ctx.candidateState.detectedSolutionFamilyId ?? "",
      ...ctx.candidateState.alternativesMentioned,
    ].join(" "),
  );
  const branchWords = tokens(`${followUp.oralDelta} ${followUp.expectedAdaptation}`);
  let overlap = 0;
  for (const word of candidateWords) if (branchWords.has(word)) overlap++;
  return overlap;
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4),
  );
}
