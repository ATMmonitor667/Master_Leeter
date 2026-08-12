import { z } from "zod";
import { CandidateStateSchema } from "./candidate-state.js";
import { InterviewActionSchema, InterviewPolicySchema, InterviewStateSchema } from "./interview-state.js";

/**
 * Response Gate contract.
 *
 * This is the product-defining control surface. Turn detection is not
 * permission to speak (ADR-001). The gate consumes an InterviewContext and
 * returns exactly one InterviewAction — defaulting to STAY_SILENT.
 *
 * Deterministic rules run BEFORE model reasoning (CLAUDE.md invariant 9).
 * The classifier supplies probabilities; the gate decides consequences.
 */

export const TURN_INTENTS = [
  "THINK_ALOUD",
  "EXPLICIT_QUESTION",
  "CLARIFICATION_REQUEST",
  "HINT_REQUEST",
  "COMPLEXITY_CLAIM",
  "APPROACH_COMMITMENT",
  "TEST_PLAN",
  "CONFUSION",
  "DONE_SIGNAL",
  "SOCIAL_SMALL_TALK",
] as const;
export const TurnIntentSchema = z.enum(TURN_INTENTS);
export type TurnIntent = z.infer<typeof TurnIntentSchema>;

export const TurnSchema = z.object({
  turnId: z.string(),
  /** The gate never acts on a non-finalized turn. Guessing is worse than waiting. */
  finalized: z.boolean(),
  transcript: z.string(),
  /**
   * Confidence that the candidate actually finished their thought.
   *
   * The number the gate thresholds against. Since M4-2 this fuses what the words
   * say with how long the candidate has been quiet — see the two fields below
   * for the parts it was built from.
   */
  semanticEndProbability: z.number().min(0).max(1),
  /**
   * What the classifier made of the transcript alone, before timing was applied.
   *
   * Kept for evidence rather than for decisions: when a session produces an
   * interruption worth annotating (M4-5b), "the model was sure and the clock
   * disagreed" and "the model was unsure" are different bugs with different
   * fixes, and the fused number alone cannot tell them apart.
   */
  textEndProbability: z.number().min(0).max(1).optional(),
  /**
   * Quiet time between VAD speech-stop and this finalized transcript.
   *
   * Absent when no speech-stop preceded the turn — a text-only path, or voice
   * that has not reported one. Absence means "unknown", never "zero".
   */
  silenceMsBeforeEnd: z.number().nonnegative().optional(),
  intent: TurnIntentSchema,
  intentProbabilities: z.record(z.number().min(0).max(1)),
  endedAt: z.string().datetime(),
});
export type Turn = z.infer<typeof TurnSchema>;

export const InterviewContextSchema = z.object({
  sessionId: z.string().uuid(),
  state: InterviewStateSchema,
  policy: InterviewPolicySchema,
  candidateState: CandidateStateSchema,
  turn: TurnSchema.nullable(),

  /** True while interviewer audio is playing. */
  interviewerCurrentlySpeaking: z.boolean(),
  /** True when the candidate has begun speaking over the interviewer → barge-in. */
  candidateSpeechStarted: z.boolean(),

  secondsSinceInterviewerLastSpoke: z.number().nonnegative(),
  secondsSinceCodeActivity: z.number().nonnegative(),
  remainingSeconds: z.number().int().nonnegative(),
  hintsUsedCount: z.number().int().nonnegative(),

  /** Latest code revision the observer has processed. Staleness guard input. */
  latestCodeRevision: z.number().int().nonnegative(),
  scenarioVersionId: z.string(),
  traceId: z.string(),
});
export type InterviewContext = z.infer<typeof InterviewContextSchema>;

/**
 * The gate's output.
 *
 * `reason` is mandatory. Every decision — including silence — is logged with why,
 * because "why didn't it speak?" is the most common debugging question in this
 * product and replay determinism depends on being able to answer it.
 */
export const GateDecisionSchema = z.object({
  action: InterviewActionSchema,
  reason: z.string().min(1),
  /** True when a deterministic rule decided this without any model call. */
  decidedByRule: z.boolean(),
  probeId: z.string().optional(),
  hintLevel: z.number().int().min(1).max(4).optional(),
  factKey: z.string().optional(),
  followUpId: z.string().optional(),
  /** Revision the response is grounded in. Required for anything that speaks about code. */
  groundedInRevision: z.number().int().nonnegative().optional(),
});
export type GateDecision = z.infer<typeof GateDecisionSchema>;

export const SILENT = (reason: string): GateDecision => ({
  action: "STAY_SILENT",
  reason,
  decidedByRule: true,
});
