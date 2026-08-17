import {
  type GateDecision,
  type InterviewContext,
  type InterviewScenarioVersion,
  SILENT,
  isActionAllowed,
} from "@master-leeter/contracts";
import { getClarificationFact } from "../scenario/clarification.js";
import {
  canProbeNow,
  nextAllowedHintLevel,
  selectRelevantProbe,
  selectFollowUp,
} from "../scenario/probes.js";
import type { ProbeSelectionContext } from "../scenario/probes.js";
import { canHintNow, canInterruptNow, stallPressure } from "./policy.js";

/**
 * The Response Gate (M1-3).
 *
 * This is the product. Everything else is scaffolding around the question
 * "should the interviewer speak right now?", and the answer is almost always no.
 *
 * Structure matters as much as the rules:
 *
 *   - Deterministic rules run before any model reasoning (invariant 9). The
 *     classifier hands us probabilities; the consequences are decided here, in
 *     code you can read, test, and replay.
 *   - Every exit path returns a reason, including silence. "Why didn't it
 *     speak?" is the question you will ask a hundred times while tuning this.
 *   - The default at the bottom is STAY_SILENT. New behavior gets added as an
 *     explicit authorization above it, never by changing the default.
 */

export interface GateDependencies {
  scenario: InterviewScenarioVersion;
  probeUseCounts: Readonly<Record<string, number>>;
  followUpsUsed: readonly string[];
  /** True when base tests pass and the detected family is the optimal one. */
  solvedOptimally: boolean;
  /**
   * How many times the brief has been spoken. 0 means the interview has not
   * started, which is the one situation where the interviewer speaks first.
   */
  briefDeliveryCount: number;
}

/**
 * A candidate asking to hear the problem again.
 *
 * Deliberately narrow. Broad matching here would re-deliver the brief whenever
 * someone said "sorry" or "again" mid-sentence, and re-reading the problem over
 * a working candidate is a far worse interruption than most.
 */
const REPEAT_REQUEST =
  /\b(say that again|repeat (that|the (question|problem))|hear that again|didn'?t (quite )?catch|missed that)\b/i;

export function decideAction(ctx: InterviewContext, deps: GateDependencies): GateDecision {
  const decision = decide(ctx, deps);

  // A decision the current stage forbids is a bug upstream, but the gate is the
  // last thing between a decision and a human hearing it, so it degrades to
  // silence rather than trusting the caller. The orchestrator's
  // assertActionPermitted then catches the same class of error loudly for
  // anything that bypasses the gate.
  if (!isActionAllowed(ctx.state, decision.action)) {
    return SILENT(`${decision.action} not permitted in ${ctx.state} (wanted: ${decision.reason})`);
  }

  return decision;
}

function decide(ctx: InterviewContext, deps: GateDependencies): GateDecision {
  // ── 0. The brief ───────────────────────────────────────────────────────────
  // Before everything, including the turn checks, because this is the one
  // utterance that is not a response. The candidate is waiting on it and there
  // is no turn to finalize — an interview that opened in silence and waited for
  // the candidate to speak first would simply never begin.
  if (
    ctx.state === "ORAL_PROBLEM_DELIVERY" &&
    deps.briefDeliveryCount === 0 &&
    !ctx.interviewerCurrentlySpeaking
  ) {
    return {
      action: "DELIVER_BRIEF",
      reason: "opening brief not yet delivered",
      decidedByRule: true,
    };
  }

  // ── 1. Barge-in ────────────────────────────────────────────────────────────
  // The candidate talking over the interviewer is never a cue to talk more.
  // Output audio is cancelled client-side; here we simply yield the floor.
  if (ctx.interviewerCurrentlySpeaking && ctx.candidateSpeechStarted) {
    return SILENT("barge-in: candidate started speaking while interviewer was speaking");
  }

  // ── 2. Unfinalized turn ────────────────────────────────────────────────────
  // Acting on a partial transcript means answering a question the candidate
  // hasn't finished asking. Waiting costs a beat; guessing costs the illusion.
  if (!ctx.turn || !ctx.turn.finalized) {
    return SILENT("turn not finalized");
  }

  // ── 3. Mid-thought ─────────────────────────────────────────────────────────
  // A pause is not a turn end. This single threshold is responsible for most of
  // the unwanted-interruption metric.
  if (ctx.turn.semanticEndProbability < ctx.policy.endOfTurnThreshold) {
    return SILENT(
      `semantic end probability ${ctx.turn.semanticEndProbability.toFixed(2)} below threshold ${ctx.policy.endOfTurnThreshold}`,
    );
  }

  const { turn } = ctx;

  // ── 3b. "Sorry, can you say that again?" ───────────────────────────────────
  // Answered from the reviewed repeat variants rather than by paraphrase, so a
  // second telling cannot disclose more than the first (invariant 2).
  if (REPEAT_REQUEST.test(turn.transcript) && deps.briefDeliveryCount > 0) {
    return {
      action: "DELIVER_BRIEF",
      reason: "candidate asked to hear the problem again",
      decidedByRule: true,
    };
  }

  // ── 4. The candidate asked something ───────────────────────────────────────
  // Direct questions are the one case where silence is the wrong answer.
  // Missed-response rate is a tracked metric precisely because a gate tuned for
  // quiet will fail here first.
  if (turn.intent === "EXPLICIT_QUESTION" || turn.intent === "CLARIFICATION_REQUEST") {
    const fact = getClarificationFact({
      scenario: deps.scenario,
      utterance: turn.transcript,
      state: ctx.state,
      probeHistory: ctx.candidateState.probeHistory,
    });

    if (fact.answerable) {
      return {
        action: "ANSWER_CLARIFICATION",
        reason: `canonical fact "${fact.factKey}"`,
        decidedByRule: true,
        factKey: fact.factKey,
      };
    }

    // No canonical answer exists. The interviewer acknowledges and hands the
    // decision back — it does not invent a constraint (invariant 3).
    return {
      action: "ACKNOWLEDGE_BRIEFLY",
      reason: `no canonical answer (${fact.reason})`,
      decidedByRule: true,
    };
  }

  // ── 5. The candidate asked for help ────────────────────────────────────────
  if (turn.intent === "HINT_REQUEST") {
    const level = nextAllowedHintLevel({
      policy: ctx.policy,
      hintsUsed: ctx.candidateState.hintsUsed,
    });

    if (level === null) {
      // Budget or ceiling exhausted. Silence, not a smaller hint — a mode that
      // withholds help has to actually withhold it.
      return SILENT("hint requested but budget or level ceiling exhausted");
    }

    return {
      action: level === 1 ? "GIVE_HINT_L1" : "GIVE_HINT_L2",
      reason: `hint requested, level ${level} permitted`,
      decidedByRule: true,
      hintLevel: level,
    };
  }

  // ── 6. Small talk ──────────────────────────────────────────────────────────
  if (turn.intent === "SOCIAL_SMALL_TALK") {
    return ctx.policy.acknowledgeSmallTalk
      ? { action: "ACKNOWLEDGE_BRIEFLY", reason: "small talk, policy acknowledges", decidedByRule: true }
      : SILENT("small talk, policy does not acknowledge");
  }

  // ── 7. Follow-up ───────────────────────────────────────────────────────────
  if (ctx.state === "FOLLOW_UP") {
    const followUp = selectFollowUp(deps.scenario, triggerCtx(ctx, deps));
    if (followUp) {
      return {
        action: "PRESENT_FOLLOW_UP",
        reason: `follow-up "${followUp.id}" eligible`,
        decidedByRule: true,
        followUpId: followUp.id,
      };
    }
  }

  // ── 9. An authored probe is justified ──────────────────────────────────────
  const observerBehind = ctx.latestCodeRevision - ctx.candidateState.derivedFromRevision;
  if (observerBehind > 0 && ctx.secondsSinceCodeActivity < ctx.policy.maxCodeStalenessSeconds) {
    return SILENT(`observer behind by ${observerBehind} revision(s) and code is still moving`);
  }

  const probeCtx = triggerCtx(ctx, deps);
  const probe = selectRelevantProbe(deps.scenario, probeCtx);
  if (probe) {
    const needsCode = probeNeedsCodeGrounding(probe.trigger);
    // M4-3. Eligible, paced, and grounded is still not enough if the candidate
    // is mid-keystroke. Finishing a sentence is not the same as being free.
    if (!canInterruptNow(ctx.policy, ctx.secondsSinceCodeActivity)) {
      return SILENT(
        `probe "${probe.id}" eligible but code activity ${ctx.secondsSinceCodeActivity.toFixed(1)}s ago (needs ${ctx.policy.interruptQuietSeconds}s quiet)`,
      );
    }
    if (!canProbeNow(probeCtx)) {
      return SILENT(
        `probe "${probe.id}" eligible but only ${ctx.secondsSinceInterviewerLastSpoke}s since last utterance (min ${ctx.policy.minSecondsBetweenProbes})`,
      );
    }
    const stale = needsCode ? codeFreshnessReason(ctx) : null;
    if (stale) return SILENT(stale);
    return {
      action: "ASK_PROBE",
      reason: `probe "${probe.id}": ${probe.questionIntent}`,
      decidedByRule: true,
      probeId: probe.id,
      ...(needsCode ? { groundedInRevision: ctx.candidateState.derivedFromRevision } : {}),
    };
  }

  // ── 10. The candidate is stuck ─────────────────────────────────────────────
  // Unsolicited help is the biggest intervention the interviewer makes, so it
  // sits last and requires a measurably stuck candidate, not merely a quiet one.
  //
  // M4-3 adds the second half of "measurably": a quiet editor now contributes,
  // but only for a candidate who was WORKING and stopped. `stallPressure`
  // returns 0 before any code exists, so thinking before typing — which is what
  // APPROACH_EXPLORATION is made of — never earns an unsolicited hint.
  const stuck = Math.max(
    ctx.candidateState.stuckScore,
    stallPressure(
      ctx.policy,
      ctx.secondsSinceCodeActivity,
      ctx.candidateState.implementationProgress,
    ),
  );

  if (
    canInterruptNow(ctx.policy, ctx.secondsSinceCodeActivity) &&
    canHintNow(ctx.policy, stuck, ctx.candidateState.hintsUsed.length)
  ) {
    const level = nextAllowedHintLevel({
      policy: ctx.policy,
      hintsUsed: ctx.candidateState.hintsUsed,
    });
    if (level !== null && level <= 2) {
      const stale = codeFreshnessReason(ctx);
      if (stale) return SILENT(stale);
      return {
        action: level === 1 ? "GIVE_HINT_L1" : "GIVE_HINT_L2",
        reason: `stuck score ${stuck.toFixed(2)} over threshold ${ctx.policy.stallThreshold}`,
        decidedByRule: true,
        hintLevel: level,
        groundedInRevision: ctx.candidateState.derivedFromRevision,
      };
    }
  }

  // ── Default ────────────────────────────────────────────────────────────────
  return SILENT("no rule authorized speech");
}

function probeNeedsCodeGrounding(trigger: string): boolean {
  return /detectedFamily|claimedTime|claimedSpace|milestone\((?:FIRST_COMPILES|BASE_TESTS_PASS|REPEATED_SAME_FAILURE|LARGE_REWRITE|COMPLEXITY_CLAIM_MISMATCH)\)/.test(
    trigger,
  );
}

function codeFreshnessReason(ctx: InterviewContext): string | null {
  const observerBehind = ctx.latestCodeRevision - ctx.candidateState.derivedFromRevision;
  if (observerBehind > 0) {
    return `observer behind by ${observerBehind} revision(s); refresh required before code-grounded speech`;
  }
  if (ctx.latestCodeRevision === 0) return null;

  const observedAt = ctx.candidateState.codeObservedAt
    ? Date.parse(ctx.candidateState.codeObservedAt)
    : Number.NaN;
  const turnAt = ctx.turn ? Date.parse(ctx.turn.endedAt) : Number.NaN;
  const ageSeconds =
    Number.isFinite(observedAt) && Number.isFinite(turnAt)
      ? Math.max(0, (turnAt - observedAt) / 1000)
      : Number.POSITIVE_INFINITY;
  if (ageSeconds <= ctx.policy.maxCodeStalenessSeconds) return null;
  return Number.isFinite(ageSeconds)
    ? `code observation ${ageSeconds.toFixed(1)}s old; max is ${ctx.policy.maxCodeStalenessSeconds}s`
    : "code observation age unknown; refresh required before code-grounded speech";
}

function triggerCtx(ctx: InterviewContext, deps: GateDependencies): ProbeSelectionContext {
  return {
    scenario: deps.scenario,
    candidateState: ctx.candidateState,
    state: ctx.state,
    remainingMinutes: Math.floor(ctx.remainingSeconds / 60),
    followUpsUsed: deps.followUpsUsed,
    solvedOptimally: deps.solvedOptimally,
    policy: ctx.policy,
    probeUseCounts: deps.probeUseCounts,
    secondsSinceInterviewerLastSpoke: ctx.secondsSinceInterviewerLastSpoke,
  };
}
