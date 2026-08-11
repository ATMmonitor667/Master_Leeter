import type { TurnIntent } from "@master-leeter/contracts";
import { describe, expect, it } from "vitest";
import { TURN_INTENTS } from "@master-leeter/contracts";
import { POLICIES } from "./policy.js";
import { HELD_FLOOR_CEILING, estimateTurnCompletion, silenceCeiling } from "./turn-completion.js";

/**
 * M4-2 — turn-completion confidence.
 *
 * The acceptance criterion in CLAUDE.md is one sentence: *a 1.5s pause
 * mid-explanation does not read as turn end.* The first block below is that
 * sentence as a test, and the rest exist to stop it being satisfied trivially by
 * an estimator that simply returns zero.
 */

const MOCK = POLICIES.MOCK;

/** A complete, confident, finished-sounding sentence. The hard case. */
const FINISHED_SOUNDING = "I'll use a hash map to track what I've already seen";

function estimate(over: {
  transcript?: string | undefined;
  intent?: TurnIntent | undefined;
  textEndProbability?: number | undefined;
  /** Explicit `undefined` is a case under test, so the type has to admit it. */
  silenceMs?: number | undefined;
}) {
  return estimateTurnCompletion({
    transcript: over.transcript ?? FINISHED_SOUNDING,
    intent: over.intent ?? "THINK_ALOUD",
    textEndProbability: over.textEndProbability ?? 0.95,
    ...(over.silenceMs !== undefined ? { silenceMs: over.silenceMs } : {}),
    policy: MOCK,
  });
}

describe("the acceptance criterion", () => {
  it("does not read a 1.5s pause mid-explanation as a turn end", () => {
    const result = estimate({ silenceMs: 1_500 });

    expect(result.endProbability).toBeLessThan(MOCK.endOfTurnThreshold);
    expect(result.reason).toMatch(/held/);
  });

  it("holds even when the transcript could not look more finished", () => {
    // The whole point: text confidence cannot buy its way past the clock. A
    // classifier certain to three decimal places is still describing words, and
    // the words are the same either side of a breath.
    const result = estimate({ textEndProbability: 1, silenceMs: 1_500 });

    expect(result.endProbability).toBe(HELD_FLOOR_CEILING);
    expect(result.textEndProbability).toBe(1);
  });

  it("holds a 1.5s pause in every mode, not just the measured one", () => {
    for (const policy of Object.values(POLICIES)) {
      const result = estimateTurnCompletion({
        transcript: FINISHED_SOUNDING,
        intent: "THINK_ALOUD",
        textEndProbability: 1,
        silenceMs: 1_500,
        policy,
      });
      expect(result.endProbability, policy.mode).toBeLessThan(policy.endOfTurnThreshold);
    }
  });

  it("eventually accepts that the candidate has finished", () => {
    // The counterweight. An estimator that never yields is not cautious, it is
    // broken — missed-response rate is a tracked metric too.
    const result = estimate({ silenceMs: 4_000 });

    expect(result.endProbability).toBeGreaterThanOrEqual(MOCK.endOfTurnThreshold);
  });
});

describe("the safety property", () => {
  /**
   * Fusing can only ever lower the number.
   *
   * This is what made M4-2 safe to drop into an existing gate: it can turn
   * speech into silence, never silence into speech, so no previously clean
   * trajectory can acquire an interruption from it.
   */
  it("never returns more than the text probability it was given", () => {
    for (const intent of TURN_INTENTS) {
      for (const text of [0, 0.2, 0.5, 0.75, 0.8, 0.95, 1]) {
        for (const silenceMs of [undefined, 0, 500, 1_500, 2_000, 2_800, 10_000]) {
          const result = estimateTurnCompletion({
            transcript: FINISHED_SOUNDING,
            intent,
            textEndProbability: text,
            ...(silenceMs !== undefined ? { silenceMs } : {}),
            policy: MOCK,
          });
          expect(result.endProbability, `${intent} text=${text} silence=${String(silenceMs)}`)
            .toBeLessThanOrEqual(text);
        }
      }
    }
  });

  it("is monotonic in silence — waiting longer never lowers confidence", () => {
    let previous = -1;
    for (let ms = 0; ms <= 5_000; ms += 100) {
      const { endProbability } = estimate({ silenceMs: ms });
      expect(endProbability, `${ms}ms`).toBeGreaterThanOrEqual(previous);
      previous = endProbability;
    }
  });

  it("clamps a nonsensical probability rather than propagating it", () => {
    expect(estimate({ textEndProbability: 4, silenceMs: 5_000 }).endProbability).toBe(1);
    expect(estimate({ textEndProbability: Number.NaN, silenceMs: 5_000 }).endProbability).toBe(0);
  });
});

describe("questions", () => {
  const QUESTION = "can the input have duplicates";

  it("are answered without waiting out the silence timer", () => {
    // Missed-response rate. Making someone wait 2.4s after a direct question is
    // not patience, it reads as not having heard them.
    for (const intent of ["EXPLICIT_QUESTION", "CLARIFICATION_REQUEST", "HINT_REQUEST"] as const) {
      const result = estimate({ transcript: QUESTION, intent, textEndProbability: 0.95, silenceMs: 0 });
      expect(result.endProbability, intent).toBe(0.95);
      expect(result.reason, intent).toMatch(/floor yielded/);
    }
  });

  it("are still held when the question itself trails off unfinished", () => {
    // The exemption is for questions that were finished being asked.
    const result = estimate({
      transcript: "so is the list sorted or",
      intent: "CLARIFICATION_REQUEST",
      textEndProbability: 0.95,
      silenceMs: 0,
    });

    expect(result.endProbability).toBeLessThan(MOCK.endOfTurnThreshold);
    expect(result.reason).toMatch(/mid-thought/);
  });
});

describe("the silence ceiling", () => {
  it("holds flat below the minimum and lifts fully once settled", () => {
    expect(silenceCeiling(0, MOCK)).toBe(HELD_FLOOR_CEILING);
    expect(silenceCeiling(MOCK.minTurnEndSilenceMs, MOCK)).toBe(HELD_FLOOR_CEILING);
    expect(silenceCeiling(MOCK.settledTurnEndSilenceMs, MOCK)).toBe(1);
    expect(silenceCeiling(30_000, MOCK)).toBe(1);
  });

  it("ramps continuously between them", () => {
    // A hard step would make two near-identical pauses produce opposite
    // decisions, which is exactly what reads as "it isn't really listening".
    const mid = silenceCeiling((MOCK.minTurnEndSilenceMs + MOCK.settledTurnEndSilenceMs) / 2, MOCK);
    expect(mid).toBeGreaterThan(HELD_FLOOR_CEILING);
    expect(mid).toBeLessThan(1);
  });

  it("keeps STRICT more patient than LEARNING at the same pause", () => {
    // Modes are data over one gate (M1-7). Patience is part of a mode's
    // character, so it has to actually differ.
    expect(silenceCeiling(2_000, POLICIES.STRICT)).toBeLessThan(silenceCeiling(2_000, POLICIES.LEARNING));
  });

  it("sits below every mode's threshold while the floor is held", () => {
    for (const policy of Object.values(POLICIES)) {
      expect(HELD_FLOOR_CEILING, policy.mode).toBeLessThan(policy.endOfTurnThreshold);
    }
  });
});

describe("unknown timing", () => {
  it("is treated as no evidence, not as zero silence", () => {
    // Nothing emits speech-stop until M3-2. Reading absence as "no silence has
    // elapsed" would hold the floor forever and mute the interviewer entirely.
    const result = estimate({ silenceMs: undefined, textEndProbability: 0.95 });

    expect(result.endProbability).toBe(0.95);
    expect(result.silenceMs).toBeUndefined();
    expect(result.reason).toMatch(/transcript alone/);
  });

  it("clamps a negative interval to zero rather than discarding it", () => {
    // Clock skew still tells us a speech-stop happened. Discarding it would
    // lift the ceiling, which is the one direction this must never fail in.
    const result = estimate({ silenceMs: -500, textEndProbability: 1 });

    expect(result.silenceMs).toBe(0);
    expect(result.endProbability).toBe(HELD_FLOOR_CEILING);
  });
});

describe("evidence", () => {
  it("preserves what the text said alongside what was decided", () => {
    const result = estimate({ textEndProbability: 0.95, silenceMs: 1_500 });

    expect(result.textEndProbability).toBe(0.95);
    expect(result.endProbability).toBe(HELD_FLOOR_CEILING);
    expect(result.silenceMs).toBe(1_500);
  });

  it("always explains itself", () => {
    for (const silenceMs of [undefined, 0, 1_500, 5_000]) {
      const result = estimate({ ...(silenceMs !== undefined ? { silenceMs } : {}) });
      expect(result.reason.length, String(silenceMs)).toBeGreaterThan(0);
    }
  });
});
