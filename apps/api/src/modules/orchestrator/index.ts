import { type GateDecision, type InterviewContext, isActionAllowed } from "@master-leeter/contracts";

/**
 * Interview Orchestrator — the authoritative state machine.
 *
 * NOT an HTTP module. The session module calls into this domain layer. It pins
 * the scenario version and policy, applies events in sequence, maintains
 * candidate state, consults the scenario engine for legal clarifications and
 * probes, asks the Response Gate for an action, and appends every decision to
 * the event log.
 */

export { decideAction, type GateDependencies } from "./gate.js";
export {
  ForbiddenTransitionError,
  INITIAL_STATE,
  applyEvent,
  canSpeakIn,
  isTerminal,
  type TransitionInput,
  type TransitionResult,
} from "./state-machine.js";
export { POLICIES, canHintNow, policyFor } from "./policy.js";

/**
 * Last line of defense before any action reaches the voice agent.
 *
 * A model may request anything; the orchestrator is the policy authority. An
 * action the current state forbids is a programming error, not something to
 * degrade gracefully around — the gate already degrades, so reaching here means
 * something bypassed it.
 */
export function assertActionPermitted(ctx: InterviewContext, decision: GateDecision): void {
  if (!isActionAllowed(ctx.state, decision.action)) {
    throw new Error(
      `Action ${decision.action} is not permitted in state ${ctx.state} (session ${ctx.sessionId})`,
    );
  }
}
