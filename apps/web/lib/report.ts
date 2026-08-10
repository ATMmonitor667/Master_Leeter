/**
 * Report types and presentation helpers.
 *
 * Mirrors the server's public report shape — note `scenarioRef`, not
 * `scenarioVersionId`: the internal id names the problem, so it does not leave
 * the server.
 */

export interface EvidenceMoment {
  seq: number;
  occurredAt: string;
  kind: string;
  summary: string;
  evidenceHash: string;
  codeRevision?: number;
}

export interface DimensionScore {
  dimension: string;
  score: number;
  confidence: number;
  rationale: string;
  evidence: EvidenceMoment[];
}

export interface SessionReport {
  sessionId: string;
  scenarioRef: string;
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

export const DIMENSION_LABELS: Record<string, string> = {
  problemUnderstanding: "Problem understanding",
  approach: "Approach and algorithm",
  correctness: "Correctness and implementation",
  complexityReasoning: "Complexity reasoning",
  testing: "Testing and verification",
  communication: "Technical communication",
  adaptability: "Adaptability and follow-up",
};

/**
 * Confidence, in words.
 *
 * Deliberately prominent in the UI. A 2.5 backed by two runs and a 2.5 backed
 * by nothing are different claims, and a report that presented them
 * identically would be overstating what it knows.
 */
export function confidenceLabel(confidence: number): { text: string; tone: "high" | "medium" | "low" } {
  if (confidence >= 0.7) return { text: "well evidenced", tone: "high" };
  if (confidence >= 0.4) return { text: "partially evidenced", tone: "medium" };
  return { text: "little evidence", tone: "low" };
}

export function scoreLabel(score: number): string {
  if (score >= 3.5) return "Strong";
  if (score >= 2.5) return "Solid";
  if (score >= 1.75) return "Mixed";
  return "Needs work";
}

/** Timestamp as mm:ss from session start, which is how a candidate remembers it. */
export function relativeTime(occurredAt: string, startedAt: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(occurredAt) - Date.parse(startedAt)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export const MOMENT_LABELS: Record<string, string> = {
  clarification: "Clarification",
  probe: "Interviewer probe",
  hint: "Hint",
  "follow-up": "Follow-up",
  run: "Code run",
  milestone: "Milestone",
  said: "You said",
};
