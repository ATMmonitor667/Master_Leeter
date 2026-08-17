import type {
  CandidateState,
  InterviewScenarioVersion,
  MilestoneKind,
  TurnIntent,
} from "@master-leeter/contracts";
import { complexityMismatch, type MilestoneState } from "./milestones.js";

/** One finalized candidate utterance, ready for the asynchronous observer. */
export interface TranscriptObservation {
  transcript: string;
  intent: TurnIntent;
  observedAt: string;
}

export interface TranscriptObservationResult {
  state: CandidateState;
  milestones: MilestoneState;
  emitted: MilestoneKind[];
}

/**
 * Extract only claims the candidate actually made.
 *
 * This intentionally uses a conservative deterministic grammar. Returning
 * null is preferable to turning an interviewer inference into a candidate
 * claim, and the raw transcript remains in the event log for later review.
 */
export function observeTranscript(
  previous: CandidateState,
  milestones: MilestoneState,
  scenario: InterviewScenarioVersion,
  observation: TranscriptObservation,
): TranscriptObservationResult {
  const transcript = compact(observation.transcript);
  const state: CandidateState = { ...previous, updatedAt: observation.observedAt };

  if (observation.intent === "COMPLEXITY_CLAIM" || complexityLanguage.test(transcript)) {
    const claims = extractComplexityClaims(transcript);
    if (claims.time) state.claimedTime = claims.time;
    if (claims.space) state.claimedSpace = claims.space;
    if (claims.time || claims.space) {
      state.confidence = { ...state.confidence, complexity: 0.9 };
    }
  }

  if (observation.intent === "APPROACH_COMMITMENT") {
    const approach = explicitApproach(transcript);
    if (approach) {
      state.currentApproach = approach;
      state.confidence = { ...state.confidence, approach: 0.9 };
    }
  }

  state.alternativesMentioned = unique([
    ...state.alternativesMentioned,
    ...extractAlternatives(transcript),
  ]);
  state.understoodConstraints = unique([
    ...state.understoodConstraints,
    ...recognizedConstraints(transcript, scenario),
  ]);

  const mismatch = applyComplexityMismatch(state, milestones, scenario);
  return { state, milestones: mismatch.milestones, emitted: mismatch.emitted };
}

/**
 * Re-check after either side of the comparison changes: a transcript can land
 * before code is parseable, and a later snapshot can be the moment the mismatch
 * becomes knowable.
 */
export function applyComplexityMismatch(
  state: CandidateState,
  milestones: MilestoneState,
  scenario: InterviewScenarioVersion,
): { milestones: MilestoneState; emitted: MilestoneKind[] } {
  if (milestones.reached.includes("COMPLEXITY_CLAIM_MISMATCH")) {
    return { milestones, emitted: [] };
  }

  const family = scenario.solutionFamilies.find(
    (candidate) => candidate.id === state.detectedSolutionFamilyId,
  );
  if (!family) return { milestones, emitted: [] };

  const timeMismatch = complexityMismatch(state.claimedTime, family.timeComplexity);
  const spaceMismatch = complexityMismatch(state.claimedSpace, family.spaceComplexity);
  if (!timeMismatch && !spaceMismatch) return { milestones, emitted: [] };

  return {
    milestones: {
      ...milestones,
      reached: [...milestones.reached, "COMPLEXITY_CLAIM_MISMATCH"],
    },
    emitted: ["COMPLEXITY_CLAIM_MISMATCH"],
  };
}

export function extractComplexityClaims(transcript: string): {
  time: string | null;
  space: string | null;
} {
  const text = compact(transcript.toLowerCase());
  const time = complexityNear(text, "time") ?? spokenComplexity(text, "time");
  const space = complexityNear(text, "space") ?? spokenComplexity(text, "space");

  // A single symbolic claim in a turn classified as complexity is almost
  // always the time bound unless the candidate explicitly says space.
  const symbolic = allBigO(text);
  return {
    time: time ?? (space === null && symbolic.length === 1 ? symbolic[0]! : null),
    space,
  };
}

function complexityNear(text: string, dimension: "time" | "space"): string | null {
  const clauses = text.split(/,|[.;]|\band\b/);
  const clause = clauses.find((part) => new RegExp(`\\b${dimension}\\b`).test(part));
  if (clause) return allBigO(clause)[0] ?? null;
  return null;
}

function allBigO(text: string): string[] {
  const found: string[] = [];
  const pattern = /\b(?:big\s*)?o\s*\(([^\n]{1,48}?)\)(?=\s*(?:time|space|and|,|\.|$))/gi;
  for (const match of text.matchAll(pattern)) {
    const body = match[1]?.trim();
    if (body) found.push(`O(${body.replace(/\s+/g, " ")})`);
  }
  return found;
}

function spokenComplexity(text: string, dimension: "time" | "space"): string | null {
  const patterns: Array<[RegExp, string]> = [
    [/(?:constant|o of one)/, "O(1)"],
    [/(?:quadratic|o of n squared|n squared)/, "O(n^2)"],
    [/(?:n log n|linearithmic|o of n log n)/, "O(n log n)"],
    [/(?:linear|o of n)(?!\s*(?:squared|log))/, "O(n)"],
    [/(?:logarithmic|o of log n)/, "O(log n)"],
  ];
  const clauses = text.split(/[.;]|\bbut\b|\band\b/);
  const clause = clauses.find((part) => new RegExp(`\\b${dimension}\\b`).test(part));
  if (!clause) return null;
  return patterns.find(([pattern]) => pattern.test(clause))?.[1] ?? null;
}

function explicitApproach(transcript: string): string | null {
  const match = /\b(?:my approach is|i(?:'m| am) going to|i(?:'ll| will)|i plan to)\s+(.+)/i.exec(
    transcript,
  );
  if (!match?.[1]) return null;
  return trimClaim(match[1]);
}

function extractAlternatives(transcript: string): string[] {
  const patterns = [
    /\b(?:i could also|another (?:option|approach) (?:is|would be)|alternatively,?)\s+(.+)/gi,
    /\binstead of\s+(.+?)(?:,|\.|$)/gi,
  ];
  const results: string[] = [];
  for (const pattern of patterns) {
    for (const match of transcript.matchAll(pattern)) {
      if (match[1]) results.push(trimClaim(match[1]));
    }
  }
  return results.filter(Boolean);
}

function recognizedConstraints(
  transcript: string,
  scenario: InterviewScenarioVersion,
): string[] {
  const normalized = transcript.toLowerCase();
  return scenario.facts
    .filter((fact) => {
      const keyPhrase = fact.key.replace(/[_-]+/g, " ").toLowerCase();
      if (keyPhrase.length >= 4 && normalized.includes(keyPhrase)) return true;
      return fact.askedAs.some((phrase) => phrase.length >= 4 && normalized.includes(phrase.toLowerCase()));
    })
    .map((fact) => fact.key);
}

function trimClaim(value: string): string {
  return value.split(/[.!?]/, 1)[0]!.trim().slice(0, 240);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const complexityLanguage =
  /\b(?:time|space) complexity\b|\b(?:constant|linear|quadratic|logarithmic|n log n) (?:time|space)\b|\bo\s*\(/i;
