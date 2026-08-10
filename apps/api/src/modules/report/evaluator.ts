import type { SessionEvent } from "@master-leeter/contracts";
import { type EvidenceMoment, type SessionFacts, extractFacts, momentsFor } from "./evidence.js";
import { type Rubric, type RubricDimension, rubricById, weightSum } from "./rubric.js";

/**
 * Evaluator (M6-2).
 *
 * A queue consumer over the immutable event log. It cannot block, read into, or
 * be read by the live session path (ADR-004) — mixing the live interviewer with
 * the grader causes leakage ("I think you did great") and self-grading bias,
 * where the model marks up work it hinted its way to.
 *
 * The baseline implementation below is deterministic. That is not a placeholder
 * for a model: it is the floor a model has to beat, and having it means M6-5
 * calibration can measure whether the model adds anything over counting.
 */

export interface DimensionScore {
  dimension: RubricDimension;
  /** 1–4. Deliberately coarse; finer bands imply precision that isn't there. */
  score: number;
  /** 0–1. Low confidence with thin evidence is more honest than a firm guess. */
  confidence: number;
  rationale: string;
  evidence: EvidenceMoment[];
}

export interface SessionReport {
  sessionId: string;
  scenarioVersionId: string;
  rubricId: string;
  rubricVersion: number;
  generatedAt: string;

  overall: number;
  dimensions: DimensionScore[];

  hintsUsed: number[];
  probesAsked: string[];
  missedOpportunities: string[];
  drills: { communication: string; algorithmic: string; testing: string };
}

export interface Evaluator {
  evaluate(events: SessionEvent[], rubricId: string): Promise<SessionReport>;
}

const MIN_SCORE = 1;
const MAX_SCORE = 4;

const clamp = (n: number) => Math.max(MIN_SCORE, Math.min(MAX_SCORE, n));

/**
 * Deterministic baseline evaluator.
 *
 * Scores only what the event log proves. Where the log is silent — most of what
 * a candidate *said*, until the classifier lands — it returns low confidence and
 * says so, rather than inventing a judgement. An unconfident score a reviewer
 * can audit is worth more than a confident one they cannot.
 */
export class BaselineEvaluator implements Evaluator {
  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  async evaluate(events: SessionEvent[], rubricId: string): Promise<SessionReport> {
    const rubric = rubricById(rubricId);
    const facts = extractFacts(events);

    const dimensions = rubric.dimensions.map((spec) => this.scoreDimension(spec.key, facts));
    const overall = weightedOverall(rubric, dimensions);

    return {
      sessionId: facts.sessionId,
      scenarioVersionId: facts.scenarioVersionId,
      rubricId: rubric.id,
      rubricVersion: rubric.version,
      generatedAt: this.now(),
      overall,
      dimensions,
      hintsUsed: facts.hintsGiven,
      probesAsked: facts.probesAsked,
      missedOpportunities: missedOpportunities(facts),
      drills: drills(facts),
    };
  }

  private scoreDimension(dimension: RubricDimension, facts: SessionFacts): DimensionScore {
    const evidence = momentsFor(facts, dimension);
    const { score, confidence, rationale } = this.judge(dimension, facts, evidence.length);

    return { dimension, score: clamp(score), confidence, rationale, evidence };
  }

  private judge(
    dimension: RubricDimension,
    facts: SessionFacts,
    evidenceCount: number,
  ): { score: number; confidence: number; rationale: string } {
    const passed = facts.milestonesReached.includes("BASE_TESTS_PASS") || facts.firstPassSeq !== null;
    const hintPenalty = facts.hintsGiven.length * 0.4;

    switch (dimension) {
      case "problemUnderstanding": {
        const asked = facts.clarificationsAsked;
        // Zero clarifications on a deliberately under-specified brief is a
        // finding, not a neutral absence.
        if (asked === 0) {
          return { score: 1.5, confidence: 0.7, rationale: "Asked no clarifying questions about an under-specified problem." };
        }
        return {
          score: asked >= 3 ? 3.5 : 2.5,
          confidence: 0.6,
          rationale: `Asked ${asked} clarifying question${asked === 1 ? "" : "s"}, covering ${facts.clarificationFactKeys.length} canonical facts.`,
        };
      }

      case "approach": {
        if (!passed) {
          return { score: 2, confidence: 0.5, rationale: "Base tests did not pass, so the approach was not demonstrated end to end." };
        }
        return {
          score: clamp(3.5 - hintPenalty),
          confidence: 0.6,
          rationale: `Reached a working approach${facts.hintsGiven.length > 0 ? ` with ${facts.hintsGiven.length} hint(s)` : " unaided"}.`,
        };
      }

      case "correctness": {
        if (facts.runs.length === 0) {
          return { score: 1, confidence: 0.4, rationale: "No code was executed, so correctness is unevidenced." };
        }
        const failures = facts.runs.filter((r) => r.status !== "PASSED").length;
        return {
          score: passed ? clamp(4 - failures * 0.3) : 1.5,
          confidence: 0.85,
          rationale: passed
            ? `Tests passed after ${failures} failing run${failures === 1 ? "" : "s"}.`
            : `${facts.runs.length} run(s), none passing.`,
        };
      }

      case "complexityReasoning": {
        const probed = facts.probesAsked.includes("complexity_claim");
        return {
          score: probed ? 2 : 2.5,
          // Complexity lives almost entirely in speech. Until the classifier
          // lands, this is close to a guess and should not pretend otherwise.
          confidence: 0.25,
          rationale: probed
            ? "Interviewer challenged a complexity claim; the response is not yet machine-readable."
            : "No complexity claim was captured in the event log.",
        };
      }

      case "testing": {
        const runs = facts.runs.length;
        if (runs === 0) return { score: 1, confidence: 0.8, rationale: "Never ran the code." };
        return {
          score: runs >= 3 ? 3.5 : 2.5,
          confidence: 0.7,
          rationale: `Ran ${runs} time${runs === 1 ? "" : "s"} against custom input.`,
        };
      }

      case "communication": {
        if (evidenceCount === 0) {
          return { score: 2, confidence: 0.1, rationale: "No transcript captured; communication could not be assessed." };
        }
        return { score: 2.5, confidence: 0.2, rationale: `${evidenceCount} spoken moment(s) captured; narrative assessment pending the transcript classifier.` };
      }

      case "adaptability": {
        if (facts.followUpsPresented.length === 0) {
          return { score: 2, confidence: 0.3, rationale: "No follow-up was reached, so adaptability was not tested." };
        }
        return { score: 3, confidence: 0.5, rationale: `Handled ${facts.followUpsPresented.length} follow-up branch(es).` };
      }
    }
  }
}

export function weightedOverall(rubric: Rubric, scores: DimensionScore[]): number {
  const byKey = new Map(scores.map((s) => [s.dimension, s.score]));
  const total = rubric.dimensions.reduce(
    (sum, spec) => sum + spec.weight * (byKey.get(spec.key) ?? 0),
    0,
  );
  // Sanity: a rubric whose weights don't sum to 1 produces a meaningless number.
  if (Math.abs(weightSum(rubric) - 1) > 0.001) {
    throw new Error(`Rubric ${rubric.id} weights sum to ${weightSum(rubric)}, expected 1`);
  }
  return Number(total.toFixed(2));
}

function missedOpportunities(facts: SessionFacts): string[] {
  const missed: string[] = [];

  if (facts.clarificationsAsked === 0) {
    missed.push("Did not ask any clarifying questions before starting.");
  }
  if (facts.runs.length === 0) {
    missed.push("Never executed the code against a case of their own.");
  }
  if (facts.runs.length > 0 && facts.firstPassSeq === null) {
    missed.push("Left the session without a passing run.");
  }
  if (facts.milestonesReached.includes("REPEATED_SAME_FAILURE")) {
    missed.push("Repeated the same failing case without changing the diagnosis.");
  }
  if (facts.hintsGiven.length >= 2) {
    missed.push(`Relied on ${facts.hintsGiven.length} hints to make progress.`);
  }

  return missed;
}

function drills(facts: SessionFacts): SessionReport["drills"] {
  return {
    communication:
      facts.clarificationsAsked === 0
        ? "Before writing code, state three assumptions out loud and ask whether each holds."
        : "Narrate one decision per minute for a full practice session, without pausing to code.",
    algorithmic:
      facts.firstPassSeq === null
        ? "Re-solve this pattern from scratch, naming the invariant before you type."
        : "Solve two more problems in this family and state the invariant before implementing.",
    testing:
      facts.runs.length < 2
        ? "Write three edge cases — empty, single element, all-identical — before your first run."
        : "For your next problem, write the failing case you expect before running anything.",
  };
}
