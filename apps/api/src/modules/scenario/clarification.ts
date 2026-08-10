import type {
  ClarificationResult,
  InterviewScenarioVersion,
  InterviewState,
} from "@master-leeter/contracts";

/**
 * Clarification map (M1-4).
 *
 * The single most important property of this module: it can only return facts
 * the scenario author wrote. There is no branch in which a model supplies a
 * value (invariant 3). When there is no canonical answer, the caller gets
 * `answerable: false` and a reason — and the interviewer says so, or asks the
 * candidate to make an assumption, per policy.
 *
 * This is what stops two candidates receiving incompatible versions of the same
 * problem, which would make every score incomparable.
 */

export interface ClarificationRequest {
  scenario: InterviewScenarioVersion;
  /** Finalized transcript of the candidate's question. */
  utterance: string;
  state: InterviewState;
  /** Probe ids already delivered — gates AFTER_PROBE facts. */
  probeHistory: readonly string[];
}

/** Normalizes for matching: lowercase, strip punctuation, collapse whitespace. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "am", "do", "does", "did", "can", "could",
  "would", "should", "will", "i", "we", "you", "it", "they", "there", "of",
  "to", "in", "on", "at", "for", "and", "or", "be", "have", "has", "my",
  "what", "how", "if", "so", "that", "this",
]);

function contentTokens(text: string): Set<string> {
  return new Set(normalize(text).split(" ").filter((t) => t.length > 0 && !STOPWORDS.has(t)));
}

/**
 * Deterministic lexical match against authored `askedAs` phrasings.
 *
 * Deliberately dumb and deliberately first. A semantic matcher lands in M4 as a
 * fallback for what this misses — but a rule that can decide should decide
 * (invariant 9), and a cheap exact match is both faster and auditable.
 */
export function matchFactKey(
  scenario: InterviewScenarioVersion,
  utterance: string,
): { key: string; score: number } | null {
  const asked = normalize(utterance);
  const askedTokens = contentTokens(utterance);
  if (askedTokens.size === 0) return null;

  let best: { key: string; score: number } | null = null;

  for (const fact of scenario.facts) {
    for (const phrasing of fact.askedAs) {
      const normalizedPhrasing = normalize(phrasing);

      // Substring containment is a strong signal and cheap.
      if (asked.includes(normalizedPhrasing)) {
        return { key: fact.key, score: 1 };
      }

      const phraseTokens = contentTokens(phrasing);
      if (phraseTokens.size === 0) continue;

      let overlap = 0;
      for (const token of phraseTokens) {
        if (askedTokens.has(token)) overlap++;
      }
      const score = overlap / phraseTokens.size;

      if (score >= 0.6 && (!best || score > best.score)) {
        best = { key: fact.key, score };
      }
    }
  }

  return best;
}

export function getClarificationFact(req: ClarificationRequest): ClarificationResult {
  const match = matchFactKey(req.scenario, req.utterance);
  if (!match) {
    return { answerable: false, reason: "NO_SUCH_FACT" };
  }

  const fact = req.scenario.facts.find((f) => f.key === match.key);
  if (!fact) {
    return { answerable: false, reason: "NO_SUCH_FACT" };
  }

  switch (fact.disclosure) {
    case "ALWAYS":
    case "IF_ASKED":
      return { answerable: true, factKey: fact.key, value: fact.value };

    case "AFTER_PROBE":
      // Held back on purpose. Releasing it early removes the mistake the author
      // wanted the candidate to make and recover from.
      return req.probeHistory.length > 0
        ? { answerable: true, factKey: fact.key, value: fact.value }
        : { answerable: false, reason: "NOT_YET_DISCLOSABLE" };
  }
}

/** Facts stated up front in the oral brief whether or not the candidate asks. */
export function alwaysDisclosedFacts(scenario: InterviewScenarioVersion) {
  return scenario.facts.filter((f) => f.disclosure === "ALWAYS");
}

/**
 * Facts the candidate has demonstrably learned, for CandidateState.
 * A candidate who never asked about empty input has not "understood" it.
 */
export function disclosedFactKeys(
  scenario: InterviewScenarioVersion,
  answeredKeys: readonly string[],
): string[] {
  const always = alwaysDisclosedFacts(scenario).map((f) => f.key);
  return [...new Set([...always, ...answeredKeys])];
}
