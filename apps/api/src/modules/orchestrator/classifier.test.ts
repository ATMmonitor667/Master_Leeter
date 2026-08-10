import { describe, expect, it } from "vitest";
import { POLICIES } from "./policy.js";
import { RuleBasedClassifier } from "./classifier.js";

/**
 * The stub classifier's job is not to be right. It is to be deterministic and
 * biased toward silence, so the gate can run in the live path without
 * manufacturing interruptions before M4-1 lands.
 *
 * These tests pin that bias. If someone later "improves" the stub by raising
 * its confidence on unpunctuated speech, this file should fail.
 */

const classifier = new RuleBasedClassifier();
const classify = (transcript: string, finalized = true) =>
  classifier.classify({ transcript, finalized });

describe("intent", () => {
  it("reads a hint request as a hint request, not a question", () => {
    // Both readings are defensible. Only one spends the candidate's hint budget
    // instead of handing them a canonical fact for free.
    expect(classify("could you give me a hint?").intent).toBe("HINT_REQUEST");
    expect(classify("I'm stuck").intent).toBe("HINT_REQUEST");
  });

  it("separates clarification requests from general questions", () => {
    expect(classify("can the input contain duplicates?").intent).toBe("CLARIFICATION_REQUEST");
    expect(classify("is the list sorted?").intent).toBe("CLARIFICATION_REQUEST");
    expect(classify("how much time do I have left?").intent).toBe("EXPLICIT_QUESTION");
  });

  it("recognizes complexity claims in the forms people actually say them", () => {
    for (const said of ["that's O(n) time", "this is linear time", "it's n log n overall"]) {
      expect(classify(said).intent, said).toBe("COMPLEXITY_CLAIM");
    }
  });

  it("recognizes done signals, test plans, and confusion", () => {
    expect(classify("I think that's it").intent).toBe("DONE_SIGNAL");
    expect(classify("let me test the empty case").intent).toBe("TEST_PLAN");
    expect(classify("I'm not sure why that failed").intent).toBe("CONFUSION");
  });

  it("defaults to thinking aloud", () => {
    expect(classify("okay so the readings come in one at a time").intent).toBe("THINK_ALOUD");
    expect(classify("").intent).toBe("THINK_ALOUD");
  });
});

describe("turn completion — the bias that matters", () => {
  const threshold = POLICIES.MOCK.endOfTurnThreshold;

  it("is confident only about explicit questions", () => {
    expect(classify("are duplicates possible?").semanticEndProbability).toBeGreaterThan(threshold);
  });

  it("treats a trailing conjunction as mid-thought, whatever the pause suggests", () => {
    for (const trailing of [
      "so I could use a set and then",
      "I think the answer is probably",
      "it would be O(n) because",
      "maybe if I",
    ]) {
      expect(classify(trailing).semanticEndProbability, trailing).toBeLessThan(threshold);
    }
  });

  it("stays below every mode's threshold on unpunctuated speech", () => {
    // The honest middle. This is the gap M4-2 exists to close, and it should be
    // visible as under-responding rather than hidden as over-confidence.
    const p = classify("I'll iterate through the readings and track what I've seen")
      .semanticEndProbability;
    for (const policy of Object.values(POLICIES)) {
      expect(p, policy.mode).toBeLessThan(policy.endOfTurnThreshold);
    }
  });

  it("returns zero when the transport says the utterance is still streaming", () => {
    expect(classify("are duplicates possible?", false).semanticEndProbability).toBe(0);
  });
});

describe("determinism", () => {
  it("returns identical output for identical input", () => {
    const a = classify("can the input be empty?");
    const b = classify("can the input be empty?");
    expect(a).toEqual(b);
  });

  it("stamps which classifier decided, so old sessions stay auditable", () => {
    expect(classify("hello").classifierId).toBe("stub-rules-v1");
  });
});
