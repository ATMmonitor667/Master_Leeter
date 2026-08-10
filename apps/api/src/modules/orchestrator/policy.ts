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
