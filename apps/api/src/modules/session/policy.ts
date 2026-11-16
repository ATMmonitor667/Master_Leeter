import type { InterviewMode, InterviewPolicy, InterviewState } from "@master-leeter/contracts";

/** A session is created in this state; the clock starts when it leaves it. */
export const INITIAL_STATE: InterviewState = "ORAL_PROBLEM_DELIVERY";

/** Stored with the session. Behaviour itself comes from the interviewer prompt. */
export function policyFor(mode: InterviewMode): InterviewPolicy {
  return { mode, hints: mode === "LEARNING" ? 3 : mode === "MOCK" ? 2 : 1 };
}
