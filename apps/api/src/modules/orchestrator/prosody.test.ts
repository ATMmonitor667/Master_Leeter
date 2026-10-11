import { describe, expect, it } from "vitest";
import { POLICIES } from "./policy.js";
import { estimateTurnCompletion, turnEndWindow } from "./turn-completion.js";

describe("prosodic turn timing trajectories", () => {
  it.each(Object.values(POLICIES))("keeps $mode clock timing when evidence has zero confidence", (policy) => {
    expect(turnEndWindow(policy, { probability: 1, confidence: 0 })).toEqual(turnEndWindow(policy));
    expect(turnEndWindow(policy, { probability: 0.5, confidence: 1 })).toEqual(turnEndWindow(policy));
  });

  it.each(Object.values(POLICIES))("makes $mode more patient for a held floor and faster for a yielded one", (policy) => {
    const normal = turnEndWindow(policy);
    const held = turnEndWindow(policy, { probability: 0, confidence: 1 });
    const yielded = turnEndWindow(policy, { probability: 1, confidence: 1 });
    expect(held.min).toBeGreaterThanOrEqual(normal.min);
    expect(held.settled).toBeGreaterThanOrEqual(normal.settled);
    expect(yielded.min).toBeLessThanOrEqual(normal.min);
    expect(yielded.settled).toBeLessThanOrEqual(normal.settled);
  });

  it("holds a 1.5-second thinking pause despite finished-looking text", () => {
    const result = estimateTurnCompletion({ policy: POLICIES.MOCK, transcript: "I will keep a set of seen readings",
      intent: "THINK_ALOUD", textEndProbability: 1, silenceMs: 1500, prosody: { probability: 0, confidence: 1 } });
    expect(result.endProbability).toBeLessThan(POLICIES.MOCK.endOfTurnThreshold);
  });

  it("increases completion confidence monotonically as silence elapses", () => {
    const probabilities = [0, 200, 500, 1000, 2000, 4000, 8000].map((silenceMs) => estimateTurnCompletion({
      policy: POLICIES.MOCK, transcript: "I will keep a set of seen readings", intent: "THINK_ALOUD",
      textEndProbability: 1, silenceMs, prosody: { probability: 1, confidence: 1 },
    }).endProbability);
    expect(probabilities).toEqual([...probabilities].sort((a, b) => a - b));
    expect(probabilities.at(-1)).toBeGreaterThanOrEqual(POLICIES.MOCK.endOfTurnThreshold);
  });
});
