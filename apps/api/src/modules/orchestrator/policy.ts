import type { InterviewMode, InterviewPolicy } from "@master-leeter/contracts";

/**
 * Interview policy (M1-7).
 *
 * Modes are DATA over one gate, not three code paths. If a mode ever needs its
 * own branch in `decideAction`, the policy shape is wrong — add a parameter
 * instead.
 *
 * The numbers below are starting points, not findings. M4-5 tunes them against
 * human review of real sessions; until then treat every one as a guess with a
 * plausible rationale attached.
 */

export const POLICIES: Record<InterviewMode, InterviewPolicy> = {
  /**
   * Learning — supportive. Full hint ladder, shorter patience before offering
   * help, more frequent acknowledgement so the candidate isn't practising into
   * a void.
   */
  LEARNING: {
    mode: "LEARNING",
    maxHintLevel: 4,
    hintBudget: 6,
    stallThreshold: 0.5,
    minSecondsBetweenProbes: 30,
    acknowledgeSmallTalk: true,
    endOfTurnThreshold: 0.75,
    // Shortest patience of the three. A learner practising into a void gives up;
    // still well above the length of an ordinary breath.
    minTurnEndSilenceMs: 1_200,
    settledTurnEndSilenceMs: 2_400,
    // Quickest to step in of the three, and still long enough that it never
    // lands mid-keystroke.
    interruptQuietSeconds: 3,
    stallSeconds: 60,
    maxCodeStalenessSeconds: 20,
    expectedMinutes: 45,
  },

  /**
   * Mock — the default, and the mode the quality metrics are measured against.
   * Realistic probing, minimal acknowledgement, hints only when genuinely stuck.
   */
  MOCK: {
    mode: "MOCK",
    maxHintLevel: 2,
    hintBudget: 3,
    stallThreshold: 0.7,
    minSecondsBetweenProbes: 45,
    acknowledgeSmallTalk: false,
    endOfTurnThreshold: 0.8,
    // The number the acceptance criterion names. At exactly 1.5s the ceiling is
    // still 0.35, far below this mode's 0.8 threshold, so a mid-explanation
    // pause of that length cannot read as a turn end no matter how finished the
    // words look. In practice a non-question turn needs ~2.4s of quiet here.
    minTurnEndSilenceMs: 1_500,
    settledTurnEndSilenceMs: 2_800,
    interruptQuietSeconds: 4,
    stallSeconds: 90,
    maxCodeStalenessSeconds: 20,
    expectedMinutes: 40,
  },

  /**
   * Strict — pressure training. Terse, longer silences, L1 hints only and few of
   * them. The higher end-of-turn threshold means it waits longer before
   * accepting that a candidate has finished speaking, which reads as a patient,
   * slightly intimidating interviewer.
   */
  STRICT: {
    mode: "STRICT",
    maxHintLevel: 1,
    hintBudget: 1,
    stallThreshold: 0.85,
    minSecondsBetweenProbes: 90,
    acknowledgeSmallTalk: false,
    endOfTurnThreshold: 0.88,
    // Long enough that the candidate hears the silence. This is the mode's whole
    // character expressed in milliseconds — it waits until you are certain you
    // have finished, then waits a little longer.
    minTurnEndSilenceMs: 2_200,
    settledTurnEndSilenceMs: 4_000,
    // Strict lets you sit in it. Longer before it interrupts, and far longer
    // before it decides you are stuck rather than working.
    interruptQuietSeconds: 6,
    stallSeconds: 150,
    maxCodeStalenessSeconds: 15,
    expectedMinutes: 40,
  },
};

export function policyFor(mode: InterviewMode): InterviewPolicy {
  return POLICIES[mode];
}

/**
 * Whether an unsolicited hint is permitted right now.
 *
 * Note the asymmetry with `canProbeNow`: an unsolicited hint is a bigger
 * intervention than a probe, so it also requires the candidate to be measurably
 * stuck. A probe engages with what the candidate is doing; a hint changes it.
 */
export function canHintNow(policy: InterviewPolicy, stuckScore: number, hintsUsed: number): boolean {
  if (policy.maxHintLevel === 0) return false;
  if (hintsUsed >= policy.hintBudget) return false;
  return stuckScore > policy.stallThreshold;
}

/**
 * How much a quiet editor should count toward being stuck (M4-3).
 *
 * Ramps from `stallSeconds` to twice it, so the interviewer's patience degrades
 * gradually rather than flipping at one second. A hard step would make two
 * near-identical silences produce opposite behaviour, which reads as the thing
 * not paying attention.
 *
 * ── The condition that keeps this from becoming an impatience rule ─────────
 *
 * It returns 0 until the candidate has actually written something. A quiet
 * editor during APPROACH_EXPLORATION is not a stall — it is the stage working as
 * intended, and the candidate is usually talking through it. Without this the
 * long-thinker trajectory earns an unsolicited hint for the crime of thinking
 * before typing, which is precisely the failure the product exists to avoid.
 *
 * So: "was working and stopped" counts. "Has not started" does not.
 */
export function stallPressure(
  policy: InterviewPolicy,
  secondsSinceCodeActivity: number,
  implementationProgress: number,
): number {
  if (implementationProgress <= 0) return 0;
  if (secondsSinceCodeActivity <= policy.stallSeconds) return 0;

  const span = policy.stallSeconds;
  const over = secondsSinceCodeActivity - policy.stallSeconds;
  return Math.min(1, over / span);
}

/**
 * Whether the interviewer may START something right now (M4-3).
 *
 * Distinct from every other guard here: it is about what the candidate's HANDS
 * are doing, not their voice. A probe that lands between two keystrokes is an
 * interruption even when the turn genuinely ended, because finishing a sentence
 * is not the same as being free.
 *
 * Applies only to unsolicited actions. Someone who asks a question mid-edit
 * still asked one, and making them wait for an idle editor would read as not
 * having heard them.
 */
export function canInterruptNow(policy: InterviewPolicy, secondsSinceCodeActivity: number): boolean {
  return secondsSinceCodeActivity >= policy.interruptQuietSeconds;
}
