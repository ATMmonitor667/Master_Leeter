import { z } from "zod";

/**
 * Coding rubric (M6-1).
 *
 * Versioned configuration, not universal truth. Weights are a starting point
 * from the design report; company packs may override them, and M6-5 calibration
 * against human graders is what turns them from plausible into defensible.
 *
 * Two constraints the report is emphatic about, encoded here:
 *
 *   1. Every dimension scores OBSERVABLE interview behavior. No personality,
 *      medical, psychological, or protected-class inference — not as a policy
 *      bolted on afterwards, but because there is no dimension here that could
 *      express one.
 *   2. Every score cites evidence. A dimension with no evidence does not get a
 *      confident score; it gets a low-confidence score and says why.
 */

export const RUBRIC_DIMENSIONS = [
  "problemUnderstanding",
  "approach",
  "correctness",
  "complexityReasoning",
  "testing",
  "communication",
  "adaptability",
] as const;

export const RubricDimensionSchema = z.enum(RUBRIC_DIMENSIONS);
export type RubricDimension = z.infer<typeof RubricDimensionSchema>;

export interface DimensionSpec {
  key: RubricDimension;
  label: string;
  weight: number;
  /** What a grader is looking for. Shown in the report so scores are legible. */
  lookingFor: string;
  /** Event types that can support a score here. Guards evidence relevance. */
  evidenceFrom: string[];
}

export interface Rubric {
  id: string;
  version: number;
  dimensions: DimensionSpec[];
}

export const CODING_RUBRIC_V1: Rubric = {
  id: "rubric-coding-v1",
  version: 1,
  dimensions: [
    {
      key: "problemUnderstanding",
      label: "Problem understanding",
      weight: 0.15,
      lookingFor:
        "Asked useful clarifying questions, identified ambiguity, and worked from the constraints rather than assumptions.",
      evidenceFrom: ["CLARIFICATION_ANSWERED", "SPEECH_FINAL"],
    },
    {
      key: "approach",
      label: "Approach and algorithm",
      weight: 0.25,
      lookingFor:
        "Found a viable approach, justified the data structures, and improved when challenged.",
      evidenceFrom: ["SEMANTIC_SNAPSHOT", "SPEECH_FINAL", "PROBE_ASKED"],
    },
    {
      key: "correctness",
      label: "Correctness and implementation",
      weight: 0.25,
      lookingFor: "Code behaves correctly, including on edge cases and hidden tests.",
      evidenceFrom: ["RUN_COMPLETED", "MILESTONE"],
    },
    {
      key: "complexityReasoning",
      label: "Complexity reasoning",
      weight: 0.1,
      lookingFor: "Correct asymptotic analysis, and can explain which operation dominates.",
      evidenceFrom: ["SPEECH_FINAL", "PROBE_ASKED", "MILESTONE"],
    },
    {
      key: "testing",
      label: "Testing and verification",
      weight: 0.1,
      lookingFor: "Generated useful cases, traced execution, and diagnosed failures.",
      evidenceFrom: ["RUN_REQUESTED", "RUN_COMPLETED"],
    },
    {
      key: "communication",
      label: "Technical communication",
      weight: 0.1,
      lookingFor: "Explained decisions clearly without hand-waving.",
      evidenceFrom: ["SPEECH_FINAL"],
    },
    {
      key: "adaptability",
      label: "Adaptability and follow-up",
      weight: 0.05,
      lookingFor: "Handled changed constraints and incorporated feedback.",
      evidenceFrom: ["FOLLOW_UP_PRESENTED", "SPEECH_FINAL", "SEMANTIC_SNAPSHOT"],
    },
  ],
};

export function rubricById(id: string): Rubric {
  if (id !== CODING_RUBRIC_V1.id) throw new Error(`Unknown rubric: ${id}`);
  return CODING_RUBRIC_V1;
}

/** Weights must sum to 1, or the overall score means nothing. Asserted in tests. */
export function weightSum(rubric: Rubric): number {
  return Number(rubric.dimensions.reduce((sum, d) => sum + d.weight, 0).toFixed(4));
}
