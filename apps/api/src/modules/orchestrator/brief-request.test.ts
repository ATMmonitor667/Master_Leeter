import { describe, expect, it } from "vitest";
import { isBriefRequest } from "./brief-request.js";
import { ruleBasedClassifier } from "./classifier.js";

describe("requests to hear the problem", () => {
  it.each([
    "So wha t is the problem that we'll be solving today?",
    "And what are the problem s ? Can you explain to me what the problem s are ?",
    "what is the problem",
    "what are the coding problems",
    "can you explain the problem please",
    "please read the problem statement",
    "repeat the question",
    "sorry can you say that again",
  ])("recognizes %s, even without transcription punctuation", (transcript) => {
    expect(isBriefRequest(transcript)).toBe(true);
    const classification = ruleBasedClassifier.classify({ transcript, finalized: true });
    expect(classification.intent).toBe("EXPLICIT_QUESTION");
    expect(classification.semanticEndProbability).toBeGreaterThanOrEqual(0.9);
    expect(ruleBasedClassifier.classify({ transcript, finalized: false }).semanticEndProbability).toBe(0);
  });

  it.each([
    "what is the problem with my code",
    "explain the solution to the problem",
    "what is the problem size",
    "let me try that again with a set",
    "the problem is that I forgot the empty case",
    "what are the input constraints",
    "repeat the loop until the problem is solved",
  ])("keeps reasoning and fact questions out: %s", (transcript) => {
    expect(isBriefRequest(transcript)).toBe(false);
  });
});
