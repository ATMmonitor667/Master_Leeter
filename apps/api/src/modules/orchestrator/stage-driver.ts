import {
  ALLOWED_TRANSITIONS,
  type InterviewState,
  type TurnIntent,
  isTransitionAllowed,
} from "@master-leeter/contracts";

/** Evidence that can move the interview forward. Never moves it backwards. */
export type StageSignal =
  | { kind: "BRIEF_COMPLETED" }
  | { kind: "CANDIDATE_TURN"; intent: TurnIntent; transcript: string }
  | { kind: "CODE_STARTED" }
  | { kind: "RUN_REQUESTED" };

export interface StageDriverInput {
  state: InterviewState;
  signal: StageSignal;
  briefDelivered: boolean;
  solvedOptimally: boolean;
  followUpAvailable: boolean;
  remainingSeconds: number;
}

export interface PlannedTransition {
  from: InterviewState;
  to: InterviewState;
  reason: string;
}

const SUBSTANTIVE_REASONING = new Set<TurnIntent>([
  "THINK_ALOUD",
  "APPROACH_COMMITMENT",
  "COMPLEXITY_CLAIM",
  "TEST_PLAN",
]);

const ORDER: InterviewState[] = [
  "ORAL_PROBLEM_DELIVERY",
  "CLARIFICATION",
  "APPROACH_EXPLORATION",
  "IMPLEMENTATION",
  "TEST_AND_DEBUG",
];

/**
 * Deterministic stage planning for one persisted candidate event.
 *
 * A code delta or run may legitimately imply several missed phases (someone can
 * start typing immediately), so those signals walk the legal path to a minimum
 * stage. A spoken DONE signal deliberately advances only once: entering
 * FOLLOW_UP and immediately leaving it on the same utterance would make the
 * follow-up impossible to hear.
 */
export function planStageTransitions(input: StageDriverInput): PlannedTransition[] {
  const plans: PlannedTransition[] = [];
  let current = input.state;

  const move = (to: InterviewState, reason: string): void => {
    if (!isTransitionAllowed(current, to)) {
      throw new Error(`Stage driver planned an illegal transition: ${current} -> ${to}`);
    }
    plans.push({ from: current, to, reason });
    current = to;
  };

  const advanceTo = (target: InterviewState, reason: string): void => {
    const currentIndex = ORDER.indexOf(current);
    const targetIndex = ORDER.indexOf(target);
    if (currentIndex < 0 || targetIndex < 0 || currentIndex >= targetIndex) return;

    while (current !== target) {
      const next = ALLOWED_TRANSITIONS[current][0];
      if (!next) break;
      move(next, reason);
    }
  };

  if (input.signal.kind === "BRIEF_COMPLETED") {
    if (current === "ORAL_PROBLEM_DELIVERY" && input.briefDelivered) {
      move("CLARIFICATION", "oral brief delivery completed");
    }
    return plans;
  }

  if (input.signal.kind === "CODE_STARTED") {
    if (input.briefDelivered) advanceTo("IMPLEMENTATION", "candidate started coding");
    return plans;
  }

  if (input.signal.kind === "RUN_REQUESTED") {
    if (input.briefDelivered) advanceTo("TEST_AND_DEBUG", "candidate requested the first run");
    return plans;
  }

  // The first candidate turn proves the delivered brief has reached the other
  // side of the audio channel. Until then the voice tool still needs the oral
  // delivery stage in order to retrieve the opening script.
  if (current === "ORAL_PROBLEM_DELIVERY" && input.briefDelivered) {
    move("CLARIFICATION", "candidate responded after the oral brief");
  }

  if (current === "CLARIFICATION" && SUBSTANTIVE_REASONING.has(input.signal.intent)) {
    move("APPROACH_EXPLORATION", "candidate began substantive reasoning");
  }

  const done = input.signal.intent === "DONE_SIGNAL";
  const timeLow = input.remainingSeconds <= 120;

  if (input.state === "TEST_AND_DEBUG" && (done || timeLow)) {
    if (done && input.solvedOptimally && input.followUpAvailable && input.remainingSeconds >= 300) {
      move("FOLLOW_UP", "candidate completed the base problem with time for a follow-up");
    } else {
      move("WRAP_UP", timeLow ? "two minutes remain" : "candidate finished the base problem");
    }
  } else if (input.state === "FOLLOW_UP" && (done || timeLow)) {
    move("WRAP_UP", timeLow ? "two minutes remain" : "candidate completed the follow-up");
  }

  return plans;
}
