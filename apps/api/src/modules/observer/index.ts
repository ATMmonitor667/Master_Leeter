import type { CandidateState, MilestoneKind, RunResult } from "@master-leeter/contracts";
import { type MilestoneState, applyRunResult, applySnapshot } from "./milestones.js";
import { type SemanticSnapshot, detectSolutionFamily } from "./semantic-snapshot.js";

export {
  applyRunResult,
  applySnapshot,
  complexityMismatch,
  emptyMilestoneState,
  failureFingerprint,
  normalizeComplexity,
  type MilestoneState,
} from "./milestones.js";
export {
  buildSnapshot,
  detectSolutionFamily,
  type FunctionSummary,
  type SemanticSnapshot,
} from "./semantic-snapshot.js";
export {
  applyComplexityMismatch,
  extractComplexityClaims,
  observeTranscript,
  type TranscriptObservation,
  type TranscriptObservationResult,
} from "./transcript.js";

/**
 * Candidate Observer — code half (M5-1).
 *
 * Folds snapshots, runs and milestones into the compressed CandidateState the
 * gate reasons over. Everything here is derived from what the candidate *did*,
 * which makes it deterministic and replayable.
 *
 * The transcript-derived fields — claimed complexity, alternatives mentioned,
 * understood constraints — stay null until the intent classifier lands (M4-1).
 * That is deliberate rather than incomplete: a claim the candidate never made
 * must not be invented, and `complexityMismatch` already treats null as absence
 * rather than error, so an unpopulated field cannot fire a probe.
 *
 * Runs asynchronously between turns and never on the critical path of a
 * response decision.
 */

export interface ObserverInput {
  previous: CandidateState;
  milestones: MilestoneState;
  snapshot?: SemanticSnapshot | undefined;
  run?: RunResult | undefined;
  /** Seconds since the last code edit. Drives activity level and stuck score. */
  secondsSinceCodeActivity: number;
  /**
   * Consecutive identical failures. Ignored when `run` is supplied, because the
   * milestone state has just recomputed it and two sources of truth for one
   * number is how they drift.
   */
  consecutiveFailures: number;
  now: string;
}

export interface ObserverResult {
  state: CandidateState;
  milestones: MilestoneState;
  /**
   * Milestones newly reached by THIS call.
   *
   * Distinct from `state.milestonesReached`, which is cumulative. The caller
   * needs the delta because `REPEATED_SAME_FAILURE` is deliberately
   * re-emittable — a candidate stuck at their sixth identical failure is still
   * stuck, and a cumulative set cannot express that.
   */
  emitted: MilestoneKind[];
}

export function observe(input: ObserverInput): ObserverResult {
  let milestones = input.milestones;
  const emitted: MilestoneKind[] = [];
  const next: CandidateState = { ...input.previous, updatedAt: input.now };
  let runApplied = false;

  if (input.snapshot) {
    const update = applySnapshot(milestones, input.snapshot);
    milestones = update.state;
    emitted.push(...update.emitted);

    next.detectedSolutionFamilyId = detectSolutionFamily(input.snapshot);
    next.implementationProgress = estimateProgress(input.snapshot);
    // The revision this state was derived from. The gate's staleness guard
    // compares it against the latest revision the server has seen — commenting
    // on code that has already changed is a visible product failure.
    next.derivedFromRevision = input.snapshot.revision;
    next.codeObservedAt = input.now;

    if (next.detectedSolutionFamilyId) {
      next.confidence = { ...next.confidence, approach: 0.8 };
    }
  }

  if (input.run) {
    const update = applyRunResult(milestones, input.run);
    milestones = update.state;
    emitted.push(...update.emitted);
    runApplied = true;
  }

  next.milestonesReached = [...milestones.reached];
  next.recentCodeActivity = activityLevel(input.secondsSinceCodeActivity);
  // Scored against the milestones as of AFTER this call, not before it. Reading
  // the incoming state meant a run that finally went green left the candidate
  // marked stuck until the next observation — the interviewer could offer a
  // hint for a problem the candidate had just solved.
  next.stuckScore = stuckScore(input, milestones, runApplied);

  return { state: next, milestones, emitted };
}

function activityLevel(secondsSince: number): CandidateState["recentCodeActivity"] {
  if (secondsSince <= 5) return "HIGH";
  if (secondsSince <= 20) return "MEDIUM";
  if (secondsSince <= 60) return "LOW";
  return "NONE";
}

/**
 * Rough completeness of the implementation.
 *
 * Structural, not semantic — a function with a body, a loop and a return is
 * probably an attempt, not a stub. It exists to distinguish "hasn't started"
 * from "nearly done", which is all the gate needs; anything more precise would
 * be a guess dressed as a measurement.
 */
function estimateProgress(snapshot: SemanticSnapshot): number {
  const fn = snapshot.functions[0];
  if (!fn) return 0;

  let score = 0.2; // a function exists
  if (snapshot.nonEmptyLines >= 4) score += 0.2;
  if (fn.loopCount > 0 || fn.recursive) score += 0.2;
  if (snapshot.dataStructures.length > 0) score += 0.2;
  if (fn.hasEarlyReturn) score += 0.1;
  if (snapshot.syntaxValid) score += 0.1;

  return Math.min(1, Number(score.toFixed(2)));
}

/**
 * How stuck the candidate is, 0 to 1.
 *
 * Only two things count as evidence: repeating the same failure, and going
 * quiet while having made little progress. Note what is NOT here — thinking
 * time. A candidate reasoning in silence for two minutes is working, not stuck,
 * and a stuck score that rose with silence would turn the hint rule into an
 * impatience rule, which is the failure mode this whole product exists to
 * avoid.
 */
function stuckScore(
  input: ObserverInput,
  milestones: MilestoneState,
  runApplied: boolean,
): number {
  let score = 0;

  // When a run was applied here, the milestone state is authoritative — it just
  // counted this failure. Otherwise fall back to the caller's figure, which is
  // how the simulator and unit tests drive this without a RunResult.
  const consecutiveFailures = runApplied
    ? milestones.consecutiveIdenticalFailures
    : input.consecutiveFailures;

  // Each repeat past the first is real evidence of being stuck.
  score += Math.min(0.6, Math.max(0, consecutiveFailures - 1) * 0.3);

  const progress = input.snapshot
    ? estimateProgress(input.snapshot)
    : input.previous.implementationProgress;

  // Inactive AND barely started. Either alone means nothing.
  if (input.secondsSinceCodeActivity > 90 && progress < 0.5) score += 0.3;

  const solved = milestones.reached.includes("BASE_TESTS_PASS");
  if (solved) score = 0;

  return Math.min(1, Number(score.toFixed(2)));
}
