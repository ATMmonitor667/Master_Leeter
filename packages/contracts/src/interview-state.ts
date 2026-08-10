import { z } from "zod";

/**
 * Interview state machine.
 *
 * Each state exposes a LIMITED action set. This is the structural guarantee that
 * the voice model cannot skip the interview flow or prematurely teach a solution.
 * See CLAUDE.md invariant 1 and docs/system-design-report.pdf §7.
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

/**
 * The complete set of things the interviewer may do.
 *
 * STAY_SILENT is a first-class action, not the absence of one. Every turn
 * produces exactly one InterviewAction, and the overwhelming majority of them
 * are STAY_SILENT.
 */
export const INTERVIEW_ACTIONS = [
  "STAY_SILENT",
  "ACKNOWLEDGE_BRIEFLY",
  "ANSWER_CLARIFICATION",
  "ASK_PROBE",
  "GIVE_HINT_L1",
  "GIVE_HINT_L2",
  "TRANSITION_STAGE",
  "PRESENT_FOLLOW_UP",
  "END_INTERVIEW",
] as const;

export const InterviewActionSchema = z.enum(INTERVIEW_ACTIONS);
export type InterviewAction = z.infer<typeof InterviewActionSchema>;

/**
 * Which actions each state permits.
 *
 * An action absent from a state's list is not "discouraged" — it is a
 * programming error, and the orchestrator throws rather than degrading to it.
 */
export const ALLOWED_ACTIONS: Record<InterviewState, readonly InterviewAction[]> = {
  ORAL_PROBLEM_DELIVERY: ["STAY_SILENT", "TRANSITION_STAGE"],
  CLARIFICATION: [
    "STAY_SILENT",
    "ACKNOWLEDGE_BRIEFLY",
    "ANSWER_CLARIFICATION",
    "TRANSITION_STAGE",
  ],
  APPROACH_EXPLORATION: [
    "STAY_SILENT",
    "ACKNOWLEDGE_BRIEFLY",
    "ANSWER_CLARIFICATION",
    "ASK_PROBE",
    "GIVE_HINT_L1",
    "TRANSITION_STAGE",
  ],
  // Mostly silence by design. No hints above L1, no follow-ups, no probing
  // the candidate out of flow while they are writing code.
  IMPLEMENTATION: [
    "STAY_SILENT",
    "ANSWER_CLARIFICATION",
    "ASK_PROBE",
    "GIVE_HINT_L1",
    "TRANSITION_STAGE",
  ],
  TEST_AND_DEBUG: [
    "STAY_SILENT",
    "ACKNOWLEDGE_BRIEFLY",
    "ANSWER_CLARIFICATION",
    "ASK_PROBE",
    "GIVE_HINT_L1",
    "GIVE_HINT_L2",
    "TRANSITION_STAGE",
  ],
  FOLLOW_UP: [
    "STAY_SILENT",
    "ACKNOWLEDGE_BRIEFLY",
    "ANSWER_CLARIFICATION",
    "ASK_PROBE",
    "PRESENT_FOLLOW_UP",
    "TRANSITION_STAGE",
  ],
  WRAP_UP: ["STAY_SILENT", "ACKNOWLEDGE_BRIEFLY", "END_INTERVIEW"],
  // The evaluator never speaks into the live round (ADR-004).
  EVALUATION: [],
};

/** Legal forward transitions. Interviews move forward; they do not revisit stages. */
export const ALLOWED_TRANSITIONS: Record<InterviewState, readonly InterviewState[]> = {
  ORAL_PROBLEM_DELIVERY: ["CLARIFICATION"],
  CLARIFICATION: ["APPROACH_EXPLORATION"],
  APPROACH_EXPLORATION: ["IMPLEMENTATION"],
  IMPLEMENTATION: ["TEST_AND_DEBUG"],
  TEST_AND_DEBUG: ["FOLLOW_UP", "WRAP_UP"],
  FOLLOW_UP: ["WRAP_UP"],
  WRAP_UP: ["EVALUATION"],
  EVALUATION: [],
};

export function isActionAllowed(state: InterviewState, action: InterviewAction): boolean {
  return ALLOWED_ACTIONS[state].includes(action);
}

export function isTransitionAllowed(from: InterviewState, to: InterviewState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Interviewer behavior policy. Modes are configuration over one gate, not separate code paths. */
export const INTERVIEW_MODES = ["LEARNING", "MOCK", "STRICT"] as const;
export const InterviewModeSchema = z.enum(INTERVIEW_MODES);
export type InterviewMode = z.infer<typeof InterviewModeSchema>;

export const InterviewPolicySchema = z.object({
  mode: InterviewModeSchema,
  /** Highest hint level the mode permits. 0 means no hints at all. */
  maxHintLevel: z.number().int().min(0).max(4),
  /** Total hints allowed across the session, regardless of level. */
  hintBudget: z.number().int().min(0),
  /** stuckScore above which an unsolicited L1 hint becomes eligible. */
  stallThreshold: z.number().min(0).max(1),
  /** Minimum seconds between two interviewer-initiated utterances. */
  minSecondsBetweenProbes: z.number().int().min(0),
  /**
   * Whether social small talk earns a brief acknowledgement.
   * Off in Mock and Strict: a real interviewer does not fill every silence.
   */
  acknowledgeSmallTalk: z.boolean(),
  /** Semantic end-of-turn probability required before any response is considered. */
  endOfTurnThreshold: z.number().min(0).max(1),
  /** Maximum age, in seconds, of a code revision an interviewer response may reference. */
  maxCodeStalenessSeconds: z.number().int().min(1),
  expectedMinutes: z.number().int().min(1),
});
export type InterviewPolicy = z.infer<typeof InterviewPolicySchema>;
