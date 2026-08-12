import type { InterviewPolicy, TurnIntent } from "@master-leeter/contracts";
import { MID_THOUGHT_CEILING, endsMidThought } from "./classifier.js";

/**
 * Turn-completion confidence (M4-2).
 *
 * The gate has always thresholded `semanticEndProbability` against
 * `endOfTurnThreshold`. What it did not have was a trustworthy number to
 * threshold. M4-1 supplied the half derived from words; this supplies the half
 * derived from time, and fuses them.
 *
 * ── Why words alone cannot decide this ─────────────────────────────────────
 *
 * "I'll use a hash map" is a grammatically complete sentence. It is also the
 * first half of "I'll use a hash map... but that doesn't handle the duplicate
 * case." No classifier reading the transcript can tell those apart, because at
 * the moment of the pause they are the same string. The difference is entirely
 * in what happens next, and the only evidence available before it happens is
 * how long the candidate has been quiet.
 *
 * That is the acceptance criterion in CLAUDE.md, stated exactly: *a 1.5s pause
 * mid-explanation does not read as turn end.* Not "usually doesn't" — a pause
 * that short is not evidence of anything, so no amount of textual confidence is
 * allowed to convert it into permission to speak.
 *
 * ── The one property that makes this safe to add ───────────────────────────
 *
 * **The result is never greater than the text probability it started from.**
 * Every step is a `min`. Adding this estimator to an existing path can therefore
 * produce silence where there was speech, but can never produce speech where
 * there was silence — so it cannot invent an interruption in any trajectory that
 * was previously clean. `turn-completion.test.ts` asserts this across a sweep
 * rather than trusting the reading.
 *
 * ── What it deliberately does not do ───────────────────────────────────────
 *
 * There is no per-intent suppression of think-aloud, though it is the obvious
 * next knob. Two reasons. It would be nearly all decoration: to bite at all it
 * would have to sit below `endOfTurnThreshold`, and there it stops being a prior
 * and becomes a ban — probes after think-aloud are most of what an interviewer
 * does, and think-aloud is most of what a candidate says. And the gate is only
 * ever invoked on a finalized turn, so a blanket ban on the commonest intent
 * would make rules 9 and 10 close to unreachable. Timing is the honest
 * discriminator here; intent is not.
 *
 * ── Honest limit ───────────────────────────────────────────────────────────
 *
 * `silenceMs` arrives from VAD speech-stop, and nothing emits speech-stop until
 * WebRTC lands (M3-2). Until then the live path runs the text-only branch, which
 * is exactly what it did before — the mechanism, the policy and the tests are
 * real, but the timing half is not yet *exercised* end to end. ADR-001 carries
 * the related caveat that Gemini's turn boundaries are currently our own
 * `activity_end` signals echoed back, so the quality of `silenceMs` in
 * production is M3-2's problem before it is this module's.
 */

/**
 * Ceiling while the candidate has not been quiet long enough to have yielded.
 *
 * Chosen to sit below every mode's `endOfTurnThreshold` (lowest is LEARNING's
 * 0.75) with room to spare, so "not quiet long enough" always means silence and
 * never *nearly* means silence. It is not zero because the number is evidence
 * that gets logged and tuned against, and collapsing it to zero would throw away
 * the difference between a held floor and an unfinalized turn.
 */
export const HELD_FLOOR_CEILING = 0.35;

/**
 * Intents where the candidate has plainly handed back the floor.
 *
 * These skip the silence gate entirely, and that exemption is the single most
 * important thing in this file after the ceiling itself. Missed-response rate is
 * a tracked metric: making someone wait out a 2.4-second timer after "is the
 * list sorted?" is not patience, it is the interviewer appearing not to have
 * heard. A question is self-evidently a yielded floor — it needs no clock to
 * corroborate it.
 *
 * The mid-thought veto still applies above this, so a question that trails off
 * unfinished ("so is the list, um, so") is still held.
 */
const FLOOR_YIELDED_INTENTS: ReadonlySet<TurnIntent> = new Set<TurnIntent>([
  "EXPLICIT_QUESTION",
  "CLARIFICATION_REQUEST",
  "HINT_REQUEST",
]);

export interface TurnCompletionInput {
  transcript: string;
  intent: TurnIntent;
  /** What the classifier made of the words alone (M4-1). */
  textEndProbability: number;
  /**
   * Quiet time between VAD speech-stop and the finalized transcript.
   *
   * Undefined means *unknown*, never zero. Unknown timing must not be read as
   * "no silence has elapsed" — that would hold the floor forever on every
   * text-only path and turn the interviewer mute.
   */
  silenceMs?: number | undefined;
  policy: InterviewPolicy;
}

export interface TurnCompletion {
  /** The fused number. This is what the gate thresholds. */
  endProbability: number;
  /** Preserved so evidence can separate "model was sure" from "clock disagreed". */
  textEndProbability: number;
  silenceMs?: number | undefined;
  /**
   * Why the number is what it is, in one line.
   *
   * Persisted with the decision. "Why did it speak there?" has to be answerable
   * from the log alone, and after this change the answer is often about a
   * threshold the transcript gives no hint of.
   */
  reason: string;
}

/**
 * How much end-confidence the elapsed silence permits.
 *
 * Below the minimum: held, flat. Above the settled point: unconstrained. Between
 * them: linear. The ramp is not sophistication for its own sake — a hard step at
 * one threshold would make the interviewer's behavior discontinuous around a
 * single millisecond, so two nearly identical pauses could produce opposite
 * decisions. That is precisely the kind of unpredictability the candidate reads
 * as the thing not listening properly.
 */
export function silenceCeiling(silenceMs: number, policy: InterviewPolicy): number {
  const min = policy.minTurnEndSilenceMs;
  const settled = policy.settledTurnEndSilenceMs;

  if (silenceMs <= min) return HELD_FLOOR_CEILING;
  if (silenceMs >= settled) return 1;

  // A policy with settled <= min is a misconfiguration, not a shape to
  // interpolate over. Already handled by the two guards above, which between
  // them cover every input when the window is empty or inverted.
  const t = (silenceMs - min) / (settled - min);
  return HELD_FLOOR_CEILING + t * (1 - HELD_FLOOR_CEILING);
}

/**
 * The quiet time at which `silenceCeiling` first permits `threshold`.
 *
 * The inverse of the ramp, and it exists to keep the interviewer's patience
 * honest rather than merely long. When a turn is held for timing, the runtime
 * waits exactly this long before reconsidering — not until `settled`, which
 * would add ~400ms of dead air in MOCK for no benefit, and not a fixed guess.
 *
 * Returns `minTurnEndSilenceMs` when the threshold is at or under the held-floor
 * ceiling (nothing to wait for), and `Infinity` when no amount of silence can
 * satisfy it — a misconfigured policy should hold the floor forever rather than
 * silently round down into speech.
 */
export function silenceRequiredFor(threshold: number, policy: InterviewPolicy): number {
  if (threshold <= HELD_FLOOR_CEILING) return policy.minTurnEndSilenceMs;
  if (threshold > 1) return Number.POSITIVE_INFINITY;

  const span = policy.settledTurnEndSilenceMs - policy.minTurnEndSilenceMs;
  if (span <= 0) return policy.settledTurnEndSilenceMs;

  const t = (threshold - HELD_FLOOR_CEILING) / (1 - HELD_FLOOR_CEILING);
  return policy.minTurnEndSilenceMs + t * span;
}

export function estimateTurnCompletion(input: TurnCompletionInput): TurnCompletion {
  const text = clamp01(input.textEndProbability);
  const silenceMs = normalizeSilence(input.silenceMs);
  const carry = { textEndProbability: text, ...(silenceMs !== undefined ? { silenceMs } : {}) };

  let p = text;

  // ── 1. Mid-thought veto ────────────────────────────────────────────────────
  // Restated here rather than trusted from the classifier. `GeminiClassifier`
  // already applies it, but this estimator has to be correct for ANY
  // implementation of the interface — including a future one that forgets, or a
  // recorded classification replayed from a log written before the veto existed.
  // Applying a min twice is applying it once.
  if (endsMidThought(input.transcript) && p > MID_THOUGHT_CEILING) {
    return {
      ...carry,
      endProbability: MID_THOUGHT_CEILING,
      reason: `mid-thought veto: transcript ends on a connective (capped at ${MID_THOUGHT_CEILING})`,
    };
  }

  // ── 2. The floor was handed back explicitly ────────────────────────────────
  if (FLOOR_YIELDED_INTENTS.has(input.intent)) {
    return {
      ...carry,
      endProbability: p,
      reason: `${input.intent}: floor yielded explicitly, silence not required`,
    };
  }

  // ── 3. Timing ──────────────────────────────────────────────────────────────
  if (silenceMs === undefined) {
    return {
      ...carry,
      endProbability: p,
      reason: "no speech-stop timing available; judged on transcript alone",
    };
  }

  const ceiling = silenceCeiling(silenceMs, input.policy);
  if (p > ceiling) {
    p = ceiling;
    return {
      ...carry,
      endProbability: p,
      reason:
        `held: ${Math.round(silenceMs)}ms of silence permits at most ${ceiling.toFixed(2)} ` +
        `(text said ${text.toFixed(2)}; settles at ${input.policy.settledTurnEndSilenceMs}ms)`,
    };
  }

  return {
    ...carry,
    endProbability: p,
    reason: `transcript ${text.toFixed(2)} within what ${Math.round(silenceMs)}ms of silence permits`,
  };
}

/**
 * Clock skew and out-of-order events can produce a negative interval.
 *
 * Clamped to zero rather than discarded: a nonsensical duration still tells us a
 * speech-stop happened, and treating that as "unknown" would silently lift the
 * ceiling — the one direction this module must never fail in.
 */
function normalizeSilence(silenceMs: number | undefined): number | undefined {
  if (silenceMs === undefined || !Number.isFinite(silenceMs)) return undefined;
  return Math.max(0, silenceMs);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}
