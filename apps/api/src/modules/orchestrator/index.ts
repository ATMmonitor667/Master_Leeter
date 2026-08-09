import {
  type GateDecision,
  type InterviewContext,
  SILENT,
  isActionAllowed,
} from "@master-leeter/contracts";

/**
 * Interview Orchestrator — the authoritative state machine.
 *
 * NOT an HTTP module. The session module calls into this domain layer. It pins
 * the scenario version and policy, applies events in sequence, maintains
 * candidate state, consults the scenario engine for legal clarifications and
 * probes, asks the Response Gate for an action, and appends every decision to
 * the event log.
 *
 * Issues: M1-2 state machine · M1-3 gate · M1-5 probes/hints · M1-6 simulator
 */

/**
 * Response Gate — the product-defining control.
 *
 * Deterministic rules run before any model reasoning (CLAUDE.md invariant 9).
 * Silence must be predictable and cheap. The full rule set lands in M1-3; the
 * two guards below are the ones that must exist before anything else does,
 * because they are what make turn detection ≠ permission to speak.
 */
export function decideAction(ctx: InterviewContext): GateDecision {
  // Barge-in: the candidate talking over the interviewer is never a cue to talk more.
  // The client cancels output audio separately.
  if (ctx.interviewerCurrentlySpeaking && ctx.candidateSpeechStarted) {
    return SILENT("barge-in: candidate started speaking while interviewer was speaking");
  }

  // Never act on a turn that has not finalized. Guessing at a half-finished
  // thought is the single most common way this product feels inhuman.
  if (!ctx.turn || !ctx.turn.finalized) {
    return SILENT("turn not finalized");
  }

  // A pause is not a turn end. Below threshold, the candidate is still thinking.
  if (ctx.turn.semanticEndProbability < ctx.policy.endOfTurnThreshold) {
    return SILENT(
      `semantic end probability ${ctx.turn.semanticEndProbability} below threshold ${ctx.policy.endOfTurnThreshold}`,
    );
  }

  // M1-3: explicit question → answer/acknowledge; hint request → next allowed
  // level; eligible probe + policy allows → probe; stall over threshold → L1.
  // Until those land, the default is the correct behavior.
  return SILENT("no rule authorized speech (default)");
}

/**
 * Last line of defense before any action reaches the voice agent.
 *
 * A model may request anything; the orchestrator is the policy authority. An
 * action the current state forbids is a programming error, not something to
 * degrade gracefully around.
 */
export function assertActionPermitted(ctx: InterviewContext, decision: GateDecision): void {
  if (!isActionAllowed(ctx.state, decision.action)) {
    throw new Error(
      `Action ${decision.action} is not permitted in state ${ctx.state} (session ${ctx.sessionId})`,
    );
  }
}
