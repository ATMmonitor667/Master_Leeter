import {
  ALLOWED_ACTIONS,
  type EventType,
  type InterviewAction,
  type InterviewState,
  isTransitionAllowed,
} from "@master-leeter/contracts";

/**
 * Interview state machine (M1-2).
 *
 * A pure function over (state, event). No I/O, no model calls, no clock. The
 * orchestrator persists the result; this module only decides.
 *
 * Transitions are explicit and forward-only. An interview that could slide back
 * from IMPLEMENTATION to CLARIFICATION would let the interviewer re-open settled
 * ground and re-disclose facts, which breaks both pacing and the disclosure
 * policy.
 */

export class ForbiddenTransitionError extends Error {
  constructor(
    readonly from: InterviewState,
    readonly to: InterviewState,
  ) {
    super(`Forbidden interview transition: ${from} -> ${to}`);
    this.name = "ForbiddenTransitionError";
  }
}

export interface TransitionInput {
  state: InterviewState;
  eventType: EventType;
  /** Present on STATE_TRANSITIONED events. Ignored otherwise. */
  requestedState?: InterviewState;
}

export interface TransitionResult {
  state: InterviewState;
  allowedActions: readonly InterviewAction[];
  changed: boolean;
}

export function applyEvent(input: TransitionInput): TransitionResult {
  const { state, eventType, requestedState } = input;

  if (eventType === "SESSION_ENDED") {
    // Ending is always legal from anywhere — a candidate can quit, a connection
    // can die permanently. The post-session pipeline takes it from here.
    return settle("EVALUATION");
  }

  if (eventType !== "STATE_TRANSITIONED") {
    // Every other event updates candidate state and the log, not the stage.
    // Stage changes are deliberate and explicit, never a side effect.
    return { state, allowedActions: ALLOWED_ACTIONS[state], changed: false };
  }

  if (!requestedState) {
    throw new Error("STATE_TRANSITIONED event is missing requestedState");
  }

  if (!isTransitionAllowed(state, requestedState)) {
    throw new ForbiddenTransitionError(state, requestedState);
  }

  return settle(requestedState);
}

function settle(state: InterviewState): TransitionResult {
  return { state, allowedActions: ALLOWED_ACTIONS[state], changed: true };
}

export const INITIAL_STATE: InterviewState = "ORAL_PROBLEM_DELIVERY";

export function isTerminal(state: InterviewState): boolean {
  return state === "EVALUATION";
}

/**
 * Whether the interviewer is permitted to speak at all in this state.
 *
 * Distinct from "will speak" — that is the gate's decision. This is the
 * structural question of whether speech is even on the table.
 */
export function canSpeakIn(state: InterviewState): boolean {
  return ALLOWED_ACTIONS[state].some((a) => a !== "STAY_SILENT");
}
