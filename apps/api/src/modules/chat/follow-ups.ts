import { emptyCandidateState, type ChatTurn, type FollowUp, type InterviewScenarioVersion, type RunResult, type SessionEvent } from "@master-leeter/contracts";
import { hashInput } from "../runner/runner.js";
import { evaluateTrigger, UnknownPredicateError } from "../scenario/triggers.js";

/**
 * Follow-up escalation for text interviews.
 *
 * Deterministic by design: the candidate asks to move on (DONE), and a rule —
 * never the model — decides whether the base problem has been demonstrated
 * and which authored follow-up comes next. Follow-up text is the scenario's
 * reviewed `oralDelta`, never a generated variation.
 */
export type FollowUpDecision =
  | { kind: "PRESENT"; followUp: FollowUp }
  | { kind: "NEEDS_CODE" | "NEEDS_PASSING_RUN" | "NONE_ELIGIBLE" | "EXHAUSTED" };

export function followUpsUsed(history: ChatTurn[]): string[] {
  return history.flatMap((t) => (t.followUpId ? [t.followUpId] : []));
}

/**
 * True when a run of the latest submitted code passed. Same bar as the voice
 * BASE_TESTS_PASS milestone: completed, and every visible test passed when
 * visible tests were part of the run.
 */
export function submittedCodePassed(history: ChatTurn[], events: SessionEvent[]): boolean {
  const code = history.filter((t) => t.code !== undefined).at(-1)?.code;
  if (code === undefined) return false;
  const sourceHash = hashInput(code);
  const requested = new Set(events
    .filter((e) => e.type === "RUN_REQUESTED" && e.payload["sourceHash"] === sourceHash)
    .map((e) => e.payload["runId"]));
  return events.some((e) => {
    if (e.type !== "RUN_COMPLETED") return false;
    const run = e.payload as unknown as RunResult;
    return requested.has(run.runId) && run.status === "PASSED" &&
      (run.visibleTestsTotal === undefined || run.visibleTestsPassed === run.visibleTestsTotal);
  });
}

export function decideFollowUp(input: {
  scenario: InterviewScenarioVersion;
  history: ChatTurn[];
  events: SessionEvent[];
  remainingSeconds: number;
  now: string;
}): FollowUpDecision {
  if (!input.history.some((t) => t.code !== undefined)) return { kind: "NEEDS_CODE" };
  const passed = submittedCodePassed(input.history, input.events);
  if (!passed) return { kind: "NEEDS_PASSING_RUN" };
  const used = followUpsUsed(input.history);
  const remaining = input.scenario.followUps.filter((f) => !used.includes(f.id));
  if (!remaining.length) return { kind: "EXHAUSTED" };
  const ctx = {
    scenario: input.scenario,
    candidateState: emptyCandidateState(input.now),
    state: "FOLLOW_UP" as const,
    remainingMinutes: Math.floor(input.remainingSeconds / 60),
    followUpsUsed: used,
    // Text sessions have no solution-family observer yet; a passing run of the
    // submitted code is the demonstrated-solution signal (see docs).
    solvedOptimally: passed,
  };
  const next = remaining.find((f) => {
    try { return evaluateTrigger(f.trigger, ctx); }
    catch (error) { if (error instanceof UnknownPredicateError) return false; throw error; }
  });
  return next ? { kind: "PRESENT", followUp: next } : { kind: "NONE_ELIGIBLE" };
}

export const FOLLOW_UP_REPLIES: Record<Exclude<FollowUpDecision["kind"], "PRESENT">, string> = {
  NEEDS_CODE: "Before we move on, submit your implementation so we're both looking at the same code.",
  NEEDS_PASSING_RUN: "Before I change the requirements, show me the submitted code working: run it and confirm the result.",
  NONE_ELIGIBLE: "I won't add another requirement right now. Walk me through the final complexity of your solution, then finish when you're ready.",
  EXHAUSTED: "That covers the requirements I had. Tell me anything else you'd test, or finish the interview when you're ready.",
};
