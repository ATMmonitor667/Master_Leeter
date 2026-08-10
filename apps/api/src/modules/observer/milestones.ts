import type { MilestoneKind, RunResult } from "@master-leeter/contracts";
import type { SemanticSnapshot } from "./semantic-snapshot.js";

/**
 * Milestone detection (M2-6).
 *
 * Derived events, not observations. A milestone is the moment something
 * interesting became true — the first successful parse, the first green run, the
 * third identical failure — and it is what makes a probe trigger fire at a
 * defensible moment rather than on a timer.
 *
 * All of it is deterministic. Milestones feed probe eligibility, and probe
 * eligibility must never be a model decision.
 */

export interface MilestoneState {
  reached: MilestoneKind[];
  /** Consecutive runs failing the same way. Resets when the failure changes. */
  consecutiveIdenticalFailures: number;
  lastFailureFingerprint: string | null;
  lastSnapshotCode: string | null;
}

export function emptyMilestoneState(): MilestoneState {
  return {
    reached: [],
    consecutiveIdenticalFailures: 0,
    lastFailureFingerprint: null,
    lastSnapshotCode: null,
  };
}

/**
 * Identity of a failure, for repeat detection.
 *
 * Deliberately excludes timing and memory: the same bug run three times
 * produces three different CPU readings, and treating those as different
 * failures would defeat the whole point. Status plus the first line of stderr
 * plus the exit code is what a human means by "the same error again".
 */
export function failureFingerprint(result: RunResult): string {
  const firstStderrLine = result.stderr.split("\n").find((l) => l.trim().length > 0) ?? "";
  return `${result.status}|${result.exitCode ?? "null"}|${firstStderrLine.trim()}`;
}

/** LARGE_REWRITE threshold. Below this, churn is editing; above it, reconsidering. */
const LARGE_REWRITE_CHURN = 0.5;
const LARGE_REWRITE_MIN_LINES = 6;
const REPEATED_FAILURE_THRESHOLD = 3;

export interface MilestoneUpdate {
  state: MilestoneState;
  /** Milestones newly reached by this event. Empty most of the time. */
  emitted: MilestoneKind[];
}

export function applyRunResult(state: MilestoneState, result: RunResult): MilestoneUpdate {
  const emitted: MilestoneKind[] = [];
  const next: MilestoneState = { ...state, reached: [...state.reached] };

  const compiled = result.status !== "COMPILE_ERROR";
  if (compiled && !next.reached.includes("FIRST_COMPILES")) {
    next.reached.push("FIRST_COMPILES");
    emitted.push("FIRST_COMPILES");
  }

  const passed =
    result.status === "PASSED" &&
    (result.visibleTestsTotal === undefined ||
      result.visibleTestsPassed === result.visibleTestsTotal);

  if (passed) {
    if (!next.reached.includes("BASE_TESTS_PASS")) {
      next.reached.push("BASE_TESTS_PASS");
      emitted.push("BASE_TESTS_PASS");
    }
    // Success clears the streak. Someone who fixes it and then breaks it again
    // is not on their fourth identical failure.
    next.consecutiveIdenticalFailures = 0;
    next.lastFailureFingerprint = null;
    return { state: next, emitted };
  }

  const fingerprint = failureFingerprint(result);
  if (fingerprint === next.lastFailureFingerprint) {
    next.consecutiveIdenticalFailures += 1;
  } else {
    next.consecutiveIdenticalFailures = 1;
    next.lastFailureFingerprint = fingerprint;
  }

  if (next.consecutiveIdenticalFailures >= REPEATED_FAILURE_THRESHOLD) {
    // Re-emittable on purpose. A candidate stuck at failure six is still stuck,
    // and the probe's own maxUses is what stops the interviewer repeating itself.
    emitted.push("REPEATED_SAME_FAILURE");
    if (!next.reached.includes("REPEATED_SAME_FAILURE")) {
      next.reached.push("REPEATED_SAME_FAILURE");
    }
  }

  return { state: next, emitted };
}

export function applySnapshot(state: MilestoneState, snapshot: SemanticSnapshot): MilestoneUpdate {
  const emitted: MilestoneKind[] = [];
  const next: MilestoneState = { ...state, reached: [...state.reached] };

  // A short file rewritten wholesale is normal early typing, not a change of
  // mind. The line floor keeps LARGE_REWRITE meaningful.
  if (snapshot.churn >= LARGE_REWRITE_CHURN && snapshot.nonEmptyLines >= LARGE_REWRITE_MIN_LINES) {
    emitted.push("LARGE_REWRITE");
    if (!next.reached.includes("LARGE_REWRITE")) next.reached.push("LARGE_REWRITE");
  }

  return { state: next, emitted };
}

/**
 * Whether a claimed complexity contradicts the detected approach.
 *
 * Returns the mismatch rather than emitting the milestone, because the caller
 * needs the scenario to look up what the detected family actually costs. The
 * full COMPLEXITY_CLAIM_MISMATCH wiring is M5-2, once the observer is
 * extracting claims from the transcript.
 */
export function complexityMismatch(
  claimed: string | null,
  familyComplexity: string | null,
): boolean {
  if (!claimed || !familyComplexity) return false;
  return normalizeComplexity(claimed) !== normalizeComplexity(familyComplexity);
}

/** O(N), O( n ), and o(n) are the same claim; treating them as different is noise. */
export function normalizeComplexity(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "").replace(/\^/g, "");
}
