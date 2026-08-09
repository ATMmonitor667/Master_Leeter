import { z } from "zod";

/**
 * The content unit is a SCENARIO, not a "problem" (ADR-002).
 *
 * A scenario packages everything a competent human interviewer needs to run a
 * consistent session. Versions are immutable: a session pins one, and a pinned
 * version is retired rather than edited (CLAUDE.md invariant 4).
 */

/** When the candidate is allowed to learn a given fact. */
export const DISCLOSURE_LEVELS = [
  /** Stated in the oral brief whether or not the candidate asks. */
  "ALWAYS",
  /** Answered truthfully, but only on request. */
  "IF_ASKED",
  /** Withheld until the candidate has been probed on the relevant issue. */
  "AFTER_PROBE",
] as const;
export const DisclosureLevelSchema = z.enum(DISCLOSURE_LEVELS);
export type DisclosureLevel = z.infer<typeof DisclosureLevelSchema>;

/**
 * Content provenance. Hiding the problem text is a UX decision, NOT legal
 * clearance — every scenario must be original or licensed, with a record.
 */
export const ProvenanceSchema = z.object({
  type: z.enum(["ORIGINAL", "LICENSED"]),
  author: z.string().min(1),
  reviewNotes: z.string(),
  reviewedBy: z.string().optional(),
  reviewedAt: z.string().datetime().optional(),
  similarityCheck: z
    .object({
      performedAt: z.string().datetime(),
      method: z.string(),
      result: z.enum(["CLEAR", "FLAGGED"]),
      notes: z.string().optional(),
    })
    .optional(),
  licenseRef: z.string().optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const FactSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
  disclosure: DisclosureLevelSchema,
  /** Natural-language forms a candidate might use to ask for this fact. */
  askedAs: z.array(z.string()).default([]),
});
export type Fact = z.infer<typeof FactSchema>;

export const SolutionFamilySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  timeComplexity: z.string().min(1),
  spaceComplexity: z.string().min(1),
  /** Observable signals that the candidate is pursuing this family. */
  recognitionSignals: z.array(z.string()),
  invariants: z.array(z.string()),
  failureModes: z.array(z.string()),
  isOptimal: z.boolean().default(false),
});
export type SolutionFamily = z.infer<typeof SolutionFamilySchema>;

export const ProbeSchema = z.object({
  id: z.string().min(1),
  /** Machine-checkable condition over CandidateState / milestones. */
  trigger: z.string().min(1),
  /** What the probe is testing. Surfaced in the report so scores are explainable. */
  questionIntent: z.string().min(1),
  /** Pre-approved wordings. The model picks one; it does not invent probes. */
  authoredVariants: z.array(z.string().min(1)).min(1),
  maxUses: z.number().int().min(1).default(1),
  priority: z.number().int().default(0),
});
export type Probe = z.infer<typeof ProbeSchema>;

/**
 * Four escalating hint levels. L1 nudges attention; L4 approaches the approach.
 * Mode policy caps which levels are reachable, and every hint is recorded with
 * its score impact.
 */
export const HintSchema = z.object({
  level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  text: z.string().min(1),
  scoreImpact: z.number().min(0).max(1),
});
export type Hint = z.infer<typeof HintSchema>;

export const FollowUpSchema = z.object({
  id: z.string().min(1),
  trigger: z.string().min(1),
  /** Spoken delta describing the changed constraint. Never a new full problem. */
  oralDelta: z.string().min(1),
  rubricDelta: z.record(z.number()).default({}),
  expectedAdaptation: z.string().min(1),
});
export type FollowUp = z.infer<typeof FollowUpSchema>;

export const TestCaseSchema = z.object({
  id: z.string().min(1),
  input: z.string(),
  expectedOutput: z.string(),
  /** Hidden tests never leave the server. */
  hidden: z.boolean().default(false),
  description: z.string().optional(),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

export const SCENARIO_STATUSES = ["DRAFT", "IN_REVIEW", "ACTIVE", "RETIRED"] as const;
export const ScenarioStatusSchema = z.enum(SCENARIO_STATUSES);
export type ScenarioStatus = z.infer<typeof ScenarioStatusSchema>;

export const InterviewScenarioVersionSchema = z.object({
  id: z.string().min(1),
  scenarioId: z.string().min(1),
  version: z.number().int().min(1),
  status: ScenarioStatusSchema,
  provenance: ProvenanceSchema,

  target: z.object({
    level: z.enum(["INTERN", "JUNIOR", "MID", "SENIOR", "STAFF"]),
    topics: z.array(z.string()).min(1),
    expectedMinutes: z.number().int().min(5),
  }),

  /**
   * Oral delivery only. This text is spoken, never rendered
   * (CLAUDE.md invariant 2). Repeat variants are pre-reviewed so a "can you
   * repeat that?" cannot leak more than the original.
   */
  oralBrief: z.object({
    openingScript: z.string().min(1),
    repeatVariants: z.array(z.string().min(1)).min(1),
  }),

  facts: z.array(FactSchema),
  examples: z.array(z.object({ input: z.string(), output: z.string(), note: z.string().optional() })),
  visibleStarterTests: z.array(TestCaseSchema),
  hiddenTests: z.array(TestCaseSchema),
  solutionFamilies: z.array(SolutionFamilySchema).min(1),
  probes: z.array(ProbeSchema),
  hintLadder: z.array(HintSchema).length(4),
  followUps: z.array(FollowUpSchema),
  rubricId: z.string().min(1),
});
export type InterviewScenarioVersion = z.infer<typeof InterviewScenarioVersionSchema>;

/** Returned when a clarification has no canonical answer. The model never fills this gap. */
export const NOT_ANSWERABLE = "NOT_ANSWERABLE" as const;

export const ClarificationResultSchema = z.union([
  z.object({ answerable: z.literal(true), factKey: z.string(), value: z.string() }),
  z.object({
    answerable: z.literal(false),
    reason: z.enum(["NO_SUCH_FACT", "NOT_YET_DISCLOSABLE", "CANDIDATE_SHOULD_ASSUME"]),
  }),
]);
export type ClarificationResult = z.infer<typeof ClarificationResultSchema>;
