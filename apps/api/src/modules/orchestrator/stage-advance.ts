import {
  type InterviewPolicy,
  type InterviewState,
  type MilestoneKind,
  type TurnIntent,
  isActionAllowed,
  isTransitionAllowed,
} from "@master-leeter/contracts";

/**
 * Stage advancement — the driver the state machine never had (M1-2b).
 *
 * `applyEvent` has always been correct and well tested, and nothing ever handed
 * it a real transition: no code appended a `STATE_TRANSITIONED` event, the gate
 * never returned `TRANSITION_STAGE`, and `SessionStore.transition` had no
 * callers. A live session therefore pinned to `ORAL_PROBLEM_DELIVERY` forever,
 * where `ALLOWED_ACTIONS` permits exactly one utterance — the brief — after
 * which the interviewer was structurally incapable of saying anything at all.
 * No clarifications, no probes, no hints, no follow-ups, for the whole round.
 *
 * Nothing caught it because the simulator sets `state` by hand on every
 * scripted step, so 32 green bot trajectories were exercising a machine that
 * production could not move.
 *
 * ── Why this is not a gate action ──────────────────────────────────────────
 *
 * `TRANSITION_STAGE` is in the action table, so the obvious reading is that
 * `decideAction` should return it. It should not. The gate answers exactly one
 * question per turn — *should the interviewer speak right now* — and spending
 * that answer on a stage change would mean a candidate who asks a question at
 * the moment the stage moves gets silence instead of an answer. Worse, every
 * consumer of `ACTION_DECIDED` treats a non-`STAY_SILENT` action as an
 * interviewer utterance (see `review.ts` and the interruption metric), so
 * routing transitions through it would inflate the one number the product is
 * measured on.
 *
 * So advancement is a separate deterministic pass that runs on committed
 * evidence, before the gate rules on the same event. It still respects the
 * action table: `isActionAllowed(state, "TRANSITION_STAGE")` gates every move,
 * which is why nothing advances out of `WRAP_UP` or `EVALUATION`.
 *
 * ── Determinism ───────────────────────────────────────────────────────────
 *
 * Pure function of signals that are themselves derived from the log. No clock
 * read, no model call, no I/O. The caller persists the result, and a replay
 * reads the persisted `STATE_TRANSITIONED` events rather than re-deriving them.
 */

/**
 * Consecutive non-question turns after which the candidate has stopped
 * clarifying and started reasoning.
 *
 * One turn is too eager: "okay" is a think-aloud, and leaving `CLARIFICATION`
 * costs the candidate the right to ask for the problem again, since
 * `DELIVER_BRIEF` is not permitted past that stage. Two is the smallest number
 * that means "they are talking about the approach now", which is precisely when
 * the interviewer needs `ASK_PROBE` to become legal.
 */
export const REASONING_TURNS_TO_LEAVE_CLARIFICATION = 2;

/** Intents that count as reasoning rather than asking. */
const REASONING_INTENTS: readonly TurnIntent[] = [
  "THINK_ALOUD",
  "APPROACH_COMMITMENT",
  "COMPLEXITY_CLAIM",
  "TEST_PLAN",
  "DONE_SIGNAL",
];

export function isReasoningIntent(intent: TurnIntent): boolean {
  return REASONING_INTENTS.includes(intent);
}

/**
 * The next stage on the path to `WRAP_UP`.
 *
 * Transitions are single-step and forward-only, so a session under time
 * pressure walks the path rather than jumping. That is deliberate: it keeps
 * every recorded transition legal under `ALLOWED_TRANSITIONS`, and the log
 * shows honestly that the round passed through a stage it never used.
 */
const TOWARD_WRAP_UP: Record<InterviewState, InterviewState | null> = {
  ORAL_PROBLEM_DELIVERY: "CLARIFICATION",
  CLARIFICATION: "APPROACH_EXPLORATION",
  APPROACH_EXPLORATION: "IMPLEMENTATION",
  IMPLEMENTATION: "TEST_AND_DEBUG",
  TEST_AND_DEBUG: "WRAP_UP",
  FOLLOW_UP: "WRAP_UP",
  WRAP_UP: null,
  EVALUATION: null,
};

export interface StageSignals {
  state: InterviewState;
  policy: InterviewPolicy;
  /** Times the oral brief has been committed to the log. 0 = not yet opened. */
  briefDeliveryCount: number;
  /** Reasoning (non-question) turns finalized since entering the current stage. */
  reasoningTurnsInStage: number;
  /** Highest code revision the server has seen. 0 means the editor is untouched. */
  latestCodeRevision: number;
  /** The candidate has named an approach, by intent or via the observer. */
  approachCommitted: boolean;
  /** Runs the candidate has asked for. */
  runsStarted: number;
  milestones: readonly MilestoneKind[];
  remainingSeconds: number;
  followUpsPresented: number;
  followUpsAvailable: number;
}

export interface StageAdvance {
  to: InterviewState;
  /** Persisted on the event. "Why is this session in WRAP_UP?" must be answerable. */
  reason: string;
}

/**
 * One legal step forward, or null to stay put.
 *
 * Returns a single step even when several are due; the caller loops. Keeping it
 * to one keeps each decision individually justifiable in the log instead of
 * collapsing three stages into one unexplained jump.
 */
export function nextStage(signals: StageSignals): StageAdvance | null {
  const { state } = signals;

  // The action table is the authority on whether the stage may move at all.
  // WRAP_UP does not list TRANSITION_STAGE, so a round only leaves it through
  // SESSION_ENDED — ending is the candidate's or the interviewer's act, not a
  // consequence of the clock.
  if (!isActionAllowed(state, "TRANSITION_STAGE")) return null;

  const advance = timePressure(signals) ?? byProgress(signals);
  if (!advance) return null;

  // Defence in depth. `applyEvent` throws on a forbidden transition, and by the
  // time it throws the caller has already decided to move; catching it here
  // means a bad rule below degrades to staying put rather than to an exception
  // on the live path.
  if (!isTransitionAllowed(state, advance.to)) return null;

  return advance;
}

/**
 * Close the round when the clock says so, whatever the candidate is doing.
 *
 * Applies only after the brief has been delivered, because the interview clock
 * does not start until then — before that `remainingSeconds` is the full budget
 * and this rule is trivially false anyway.
 */
function timePressure(signals: StageSignals): StageAdvance | null {
  if (signals.briefDeliveryCount === 0) return null;
  if (signals.remainingSeconds > signals.policy.wrapUpSeconds) return null;

  const to = TOWARD_WRAP_UP[signals.state];
  if (!to) return null;

  return {
    to,
    reason: `${signals.remainingSeconds}s remaining, at or below the ${signals.policy.wrapUpSeconds}s wrap-up floor`,
  };
}

/** What the candidate has actually done. The normal path. */
function byProgress(signals: StageSignals): StageAdvance | null {
  switch (signals.state) {
    case "ORAL_PROBLEM_DELIVERY":
      // The candidate has heard the problem, so they can now ask about it.
      // Gated on the brief being COMMITTED rather than on its audio finishing:
      // audio completion is reported by the browser, and a client that crashes
      // mid-brief would otherwise strand the session in this stage forever —
      // which is the exact bug this module exists to fix.
      return signals.briefDeliveryCount > 0
        ? { to: "CLARIFICATION", reason: "oral brief delivered" }
        : null;

    case "CLARIFICATION":
      // Hands first: someone typing has stopped clarifying, whatever they say.
      if (signals.latestCodeRevision > 0) {
        return { to: "APPROACH_EXPLORATION", reason: "candidate started writing code" };
      }
      if (signals.approachCommitted) {
        return { to: "APPROACH_EXPLORATION", reason: "candidate committed to an approach" };
      }
      if (signals.reasoningTurnsInStage >= REASONING_TURNS_TO_LEAVE_CLARIFICATION) {
        return {
          to: "APPROACH_EXPLORATION",
          reason: `${signals.reasoningTurnsInStage} reasoning turns without a question`,
        };
      }
      return null;

    case "APPROACH_EXPLORATION":
      // The editor is the vote. Talking about an approach is this stage; writing
      // one is the next.
      return signals.latestCodeRevision > 0
        ? { to: "IMPLEMENTATION", reason: `first code revision (${signals.latestCodeRevision})` }
        : null;

    case "IMPLEMENTATION":
      return signals.runsStarted > 0
        ? { to: "TEST_AND_DEBUG", reason: "candidate ran their code" }
        : null;

    case "TEST_AND_DEBUG": {
      // A follow-up needs a working solution AND room to answer it. Without
      // either condition the round stays here until the wrap-up floor.
      if (!signals.milestones.includes("BASE_TESTS_PASS")) return null;
      if (signals.followUpsPresented >= signals.followUpsAvailable) return null;
      if (signals.remainingSeconds < signals.policy.followUpMinSeconds) return null;
      return {
        to: "FOLLOW_UP",
        reason: `base tests pass with ${signals.remainingSeconds}s left (needs ${signals.policy.followUpMinSeconds}s)`,
      };
    }

    case "FOLLOW_UP":
      return signals.followUpsPresented >= signals.followUpsAvailable
        ? { to: "WRAP_UP", reason: "every authored follow-up has been presented" }
        : null;

    default:
      return null;
  }
}
