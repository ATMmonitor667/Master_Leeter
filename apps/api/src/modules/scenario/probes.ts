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
  return scenario.followUps.filter((f) => evaluateTrigger(f.trigger, ctx));
}

export function selectFollowUp(
  scenario: InterviewScenarioVersion,
  ctx: TriggerContext,
): FollowUp | null {
  return eligibleFollowUps(scenario, ctx)[0] ?? null;
}
