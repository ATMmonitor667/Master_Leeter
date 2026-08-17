import { z } from "zod";
import { MilestoneKindSchema } from "./session-event.js";

/**
 * Compressed candidate model.
 *
 * The interviewer reasons over THIS, not over the raw transcript and full code.
 * Maintained asynchronously by the observer between turns — never on the
 * critical path of a response decision.
 */

export const CODE_ACTIVITY_LEVELS = ["NONE", "LOW", "MEDIUM", "HIGH"] as const;
export const CodeActivitySchema = z.enum(CODE_ACTIVITY_LEVELS);
export type CodeActivity = z.infer<typeof CodeActivitySchema>;

export const CandidateStateSchema = z.object({
  /** Free-text summary of the approach currently being pursued. */
  currentApproach: z.string().nullable(),
  alternativesMentioned: z.array(z.string()).default([]),
  /** What the candidate CLAIMED, not what the code does. The gap is a probe trigger. */
  claimedTime: z.string().nullable(),
  claimedSpace: z.string().nullable(),
  /** Solution family the code appears to belong to, per the semantic snapshot. */
  detectedSolutionFamilyId: z.string().nullable(),

  understoodConstraints: z.array(z.string()).default([]),
  unresolvedRisks: z.array(z.string()).default([]),

  implementationProgress: z.number().min(0).max(1).default(0),
  recentCodeActivity: CodeActivitySchema.default("NONE"),
  /** 0 = flowing, 1 = thoroughly stuck. Drives unsolicited-hint eligibility. */
  stuckScore: z.number().min(0).max(1).default(0),

  hintsUsed: z.array(z.number().int().min(1).max(4)).default([]),
  probeHistory: z.array(z.string()).default([]),
  milestonesReached: z.array(MilestoneKindSchema).default([]),

  /** Observer confidence per field. Low confidence should suppress probing. */
  confidence: z
    .object({
      approach: z.number().min(0).max(1),
      complexity: z.number().min(0).max(1),
    })
    .default({ approach: 0, complexity: 0 }),

  /** Code revision this state was derived from. Staleness guard input (M5-3). */
  derivedFromRevision: z.number().int().nonnegative().default(0),
  /**
   * When `derivedFromRevision` was actually observed.
   *
   * Optional for compatibility with older persisted events. A missing value is
   * treated as unknown (and therefore unsafe for code-grounded speech), never
   * as fresh.
   */
  codeObservedAt: z.string().datetime().nullable().optional(),
  updatedAt: z.string().datetime(),
});
export type CandidateState = z.infer<typeof CandidateStateSchema>;

export function emptyCandidateState(now: string): CandidateState {
  return {
    currentApproach: null,
    alternativesMentioned: [],
    claimedTime: null,
    claimedSpace: null,
    detectedSolutionFamilyId: null,
    understoodConstraints: [],
    unresolvedRisks: [],
    implementationProgress: 0,
    recentCodeActivity: "NONE",
    stuckScore: 0,
    hintsUsed: [],
    probeHistory: [],
    milestonesReached: [],
    confidence: { approach: 0, complexity: 0 },
    derivedFromRevision: 0,
    codeObservedAt: null,
    updatedAt: now,
  };
}
