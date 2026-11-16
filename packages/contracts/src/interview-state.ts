import { z } from "zod";

/**
 * Interview state machine.
 *
 * Legacy stage names. They remain because the sessions table stores one; new
 * sessions only use the first (created), the second (started) and EVALUATION (ended).
 */
export const INTERVIEW_STATES = [
  "ORAL_PROBLEM_DELIVERY",
  "CLARIFICATION",
  "APPROACH_EXPLORATION",
  "IMPLEMENTATION",
  "TEST_AND_DEBUG",
  "FOLLOW_UP",
  "WRAP_UP",
  /** Post-session. Cannot speak into the live round. */
  "EVALUATION",
] as const;

export const InterviewStateSchema = z.enum(INTERVIEW_STATES);
export type InterviewState = z.infer<typeof InterviewStateSchema>;

/** Stored per session for the sessions table. Derived from the interview style. */
export const INTERVIEW_MODES = ["LEARNING", "MOCK", "STRICT"] as const;
export const InterviewModeSchema = z.enum(INTERVIEW_MODES);
export type InterviewMode = z.infer<typeof InterviewModeSchema>;

/** Kept small: the style decides behaviour through the prompt, not through tuning numbers. */
export const InterviewPolicySchema = z.object({ mode: InterviewModeSchema, hints: z.number().int().min(0).max(4) }).passthrough();
export type InterviewPolicy = z.infer<typeof InterviewPolicySchema>;
