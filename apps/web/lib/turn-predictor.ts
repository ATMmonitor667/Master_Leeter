/**
 * Prosodic turn-end prediction (V2).
 *
 * ── The problem this exists to fix ─────────────────────────────────────────
 *
 * `turn-completion.ts` names its own limitation precisely: "I'll use a hash
 * map" is a grammatically complete sentence and also the first half of "I'll
 * use a hash map... but that doesn't handle duplicates", and at the moment of
 * the pause they are the same string. Its answer was to wait — 2400 ms in MOCK
 * before a non-question turn can be answered at all.
 *
 * But the two are NOT the same at the moment of the pause. They differ in the
 * audio, and they differ in ways that are measurable in a few hundred
 * milliseconds: the finished sentence falls in pitch, lengthens its last
 * syllable, and trails off in energy. The unfinished one holds its pitch level,
 * keeps its energy up, and stops abruptly. That is what a person hears, and it
 * is why a human can answer in 200 ms without having waited to find out.
 *
 * So this module supplies the evidence the clock was standing in for. The clock
 * does not go away — it still carries the whole burden whenever this returns no
 * confidence, which is the correct default for a room, a microphone, or a
 * speaker it cannot read.
 *
 * ── What this is NOT ───────────────────────────────────────────────────────
 *
 * Not a decision. It produces one number and a confidence, both of which are
 * inputs to `estimateTurnCompletion`, which is an input to the gate, which is
 * the only thing that decides whether the interviewer speaks. Nothing here can
 * cause speech; it can only change how long the gate is willing to wait before
 * it rules on a turn it was already going to rule on.
 *
 * ── Why in-house rather than smart-turn-v3 ─────────────────────────────────
 *
 * The 8 MB int8 Whisper-encoder classifier is the better estimator and it is
 * the right eventual answer. It is also an npm dependency and an 8 MB asset the
 * browser downloads before voice works, on a change that has not yet been heard
 * in one real session. `TurnEndPredictor` below is the seam it drops into —
 * same `push`/`estimate` shape, same units — so adopting it later is a new
 * class in a new file and no change to the VAD, the policy, or the gate.
 *
 * Honest limit, stated the way the rest of this repository states them: the
 * weights below are reasoned from the phonetics literature on pre-boundary
 * lengthening and terminal contours, not fitted to recorded sessions. Candidates
 * thinking aloud mid-problem produce long, hesitant, technically dense speech
 * with many mid-thought pauses, which is close to the hardest case for any
 * endpointer. Expect to tune `PROSODY_WEIGHTS` against the first real session,
 * and expect the ledger from V0 to be how you tell whether it helped.
 */

/** How much of the tail informs the estimate. Roughly one phrase-final foot. */
const TAIL_MS = 800;

/** Below this, the estimate is not worth having and confidence collapses to 0. */
const MIN_VOICED_TAIL_FRAMES = 8;

/** Human speech, generously bracketed. Below 70 Hz is rumble, above 400 is noise. */
const MIN_F0_HZ = 70;
const MAX_F0_HZ = 400;

/** Autocorrelation peak below this is not a pitch, it is a coincidence. */
const VOICING_THRESHOLD = 0.32;

/** Pitch analysis runs on a decimated copy; 8 kHz is plenty for an F0 this low. */
const ANALYSIS_RATE_HZ = 8_000;

/**
 * How each cue moves the score, before the logistic.
 *
 * Exported because these are the tuning surface, and a number you have to
 * recompile to change is a number nobody tunes. Every one is a guess with a
 * rationale, in the style `policy.ts` uses for its own thresholds.
 */
export interface ProsodyWeights {
  /**
   * A falling terminal contour is the classic English statement boundary.
   * Measured in semitones per second over the voiced tail.
   */
  fallingPitch: number;
  /**
   * A sharply RISING contour is also a completion — it is a question, and a
   * question is the most explicitly yielded floor there is. Both tails of the
   * pitch distribution mean "your turn"; it is the middle that means "wait".
   */
  risingPitch: number;
  /**
   * Level pitch held through the pause. The single best continuation cue, and
   * the one that distinguishes a thinking pause from a finished thought.
   */
  levelPitch: number;
  /**
   * Pre-boundary lengthening: speakers stretch the last syllable before a
   * boundary. Ratio of the final voiced run to the median run.
   */
  finalLengthening: number;
  /** Trailing off in energy. A finished sentence decays; a cut-off one does not. */
  energyDecay: number;
  /**
   * Stopping at full energy. Someone interrupted mid-thought by their own
   * thinking does not fade out, they just stop.
   */
  abruptStop: number;
  /** Slope of the logistic. Higher is more decisive, and more wrong when wrong. */
  sharpness: number;
}

export const PROSODY_WEIGHTS: ProsodyWeights = {
  fallingPitch: 0.9,
  risingPitch: 0.7,
  levelPitch: -1.0,
  finalLengthening: 0.8,
  energyDecay: 0.6,
  abruptStop: -0.7,
  sharpness: 1.6,
};

export interface ProsodyFeatures {
  /** Semitones per second across the voiced tail. Negative falls. Null if unvoiced. */
  terminalPitchSlopeSemitonesPerSec: number | null;
  /** Final voiced run divided by the median voiced run. >1 is lengthening. */
  finalLengtheningRatio: number | null;
  /** dB per second across the tail. Negative trails off. */
  terminalEnergySlopeDbPerSec: number | null;
  /** How many voiced frames the estimate rests on. Drives confidence. */
  voicedTailFrames: number;
}

export interface TurnEndEstimate {
  /**
   * Probability the candidate yielded the floor, 0–1.
   *
   * Only meaningful in proportion to `confidence`. At confidence 0 this is 0.5
   * and carries no information, which is deliberately the value that leaves the
   * existing silence ramp untouched.
   */
  probability: number;
  /**
   * How much evidence is behind the probability, 0–1.
   *
   * The most important field in this file. Everything downstream multiplies by
   * it, so a quiet room, a clipped microphone, a whispered turn or a half-second
   * of speech all degrade to exactly the behaviour this repository had before
   * V2 rather than to a confident guess.
   */
  confidence: number;
  features: ProsodyFeatures;
  /** One line, persisted with the decision. "Why did it speak there?" */
  reason: string;
}

/**
 * The seam. `ProsodicTurnEndPredictor` is one implementation; smart-turn-v3
 * behind onnxruntime-web would be another, with the same shape.
 */
export interface TurnEndPredictor {
  readonly id: string;
  /** Feed the same frames the VAD sees, so a boundary and its prosody agree. */
  push(frame: Float32Array, sampleRate: number, atMs: number): void;
  /** What the audio says right now. Cheap — all the work happened in `push`. */
  estimate(atMs: number): TurnEndEstimate;
  reset(): void;
}

/** No evidence, ever. Exactly the pre-V2 behaviour, as a first-class option. */
export class NullTurnEndPredictor implements TurnEndPredictor {
  readonly id = "null";
  push(): void {}
  estimate(): TurnEndEstimate {
    return { ...NO_EVIDENCE, reason: "turn-end prediction disabled" };
  }
  reset(): void {}
}

export const NO_EVIDENCE: TurnEndEstimate = {
  probability: 0.5,
  confidence: 0,
  features: {
    terminalPitchSlopeSemitonesPerSec: null,
    finalLengtheningRatio: null,
    terminalEnergySlopeDbPerSec: null,
    voicedTailFrames: 0,
  },
  reason: "no usable prosody",
};

interface FrameFeature {
  atMs: number;
  db: number;
  /** Hz, or null when the frame is unvoiced. */
  f0: number | null;
}

export interface ProsodicTurnEndPredictorOptions {
  weights?: Partial<ProsodyWeights>;
  tailMs?: number;
}

/**
 * Pitch, energy and timing off the frames the capture worklet already produces.
 *
 * Deliberately pure — frames in, numbers out, no `AudioContext`, no clock of its
 * own, every timestamp supplied by the caller. Same discipline as `vad.ts`, and
 * for the same reason: this is the module that most directly decides whether the
 * interviewer interrupts someone, so it has to be testable in milliseconds
 * rather than by talking to it.
 */
export class ProsodicTurnEndPredictor implements TurnEndPredictor {
  readonly id = "prosodic-v1";

  private readonly weights: ProsodyWeights;
  private readonly tailMs: number;
  private readonly frames: FrameFeature[] = [];

  /** Scratch for the decimated frame, reused so `push` allocates nothing. */
  private analysis = new Float32Array(0);

  constructor(opts: ProsodicTurnEndPredictorOptions = {}) {
    this.weights = { ...PROSODY_WEIGHTS, ...opts.weights };
    this.tailMs = opts.tailMs ?? TAIL_MS;
  }

  push(frame: Float32Array, sampleRate: number, atMs: number): void {
    if (frame.length === 0) return;

    this.frames.push({ atMs, db: frameDb(frame), f0: this.pitchOf(frame, sampleRate) });

    // Keep a little more than the tail, so a boundary reported slightly in the
    // past still has its own tail available rather than one that has aged out.
    const horizon = atMs - this.tailMs * 3;
    while (this.frames.length > 0 && (this.frames[0] as FrameFeature).atMs < horizon) {
      this.frames.shift();
    }
  }

  reset(): void {
    this.frames.length = 0;
  }

  /**
   * Read the tail that ENDED at `atMs`.
   *
   * `atMs` is the VAD's backdated quiet onset, not the moment of the call, so
   * the window analysed is the speech immediately before the pause — not the
   * pause itself, which contains nothing to measure.
   */
  estimate(atMs: number): TurnEndEstimate {
    const tail = this.frames.filter((f) => f.atMs <= atMs && f.atMs >= atMs - this.tailMs);
    const voiced = tail.filter((f): f is FrameFeature & { f0: number } => f.f0 !== null);

    const features: ProsodyFeatures = {
      terminalPitchSlopeSemitonesPerSec: pitchSlope(voiced),
      finalLengtheningRatio: lengthening(tail),
      terminalEnergySlopeDbPerSec: energySlope(tail),
      voicedTailFrames: voiced.length,
    };

    // Not enough voice to read. This is the common case for a cough, a keyboard,
    // or a turn that was one word long, and it must cost nothing — the ramp
    // behaves exactly as it did before V2.
    if (voiced.length < MIN_VOICED_TAIL_FRAMES) {
      return {
        ...NO_EVIDENCE,
        features,
        reason: `only ${voiced.length} voiced frames in the tail; prosody not used`,
      };
    }

    const { score, reason } = this.score(features);

    // Confidence ramps with evidence rather than switching on. A tail with the
    // bare minimum of voice should nudge the ramp, not replace it.
    const confidence = clamp01((voiced.length - MIN_VOICED_TAIL_FRAMES) / MIN_VOICED_TAIL_FRAMES);

    return {
      probability: sigmoid(this.weights.sharpness * score),
      confidence,
      features,
      reason,
    };
  }

  /**
   * Turn features into one signed score. Positive means the floor was yielded.
   *
   * Written as explicit named terms rather than a dot product because the terms
   * are the whole argument, and the first thing anyone tuning this will want to
   * know is which one fired.
   */
  private score(f: ProsodyFeatures): { score: number; reason: string } {
    const w = this.weights;
    let score = 0;
    const said: string[] = [];

    const slope = f.terminalPitchSlopeSemitonesPerSec;
    if (slope !== null) {
      if (slope <= -2) {
        // Falling terminal contour — a statement ending.
        const strength = Math.min(1, -slope / 6);
        score += w.fallingPitch * strength;
        said.push(`falling pitch ${slope.toFixed(1)} st/s`);
      } else if (slope >= 3) {
        // Rising terminal contour — a question, which yields the floor hardest.
        const strength = Math.min(1, slope / 8);
        score += w.risingPitch * strength;
        said.push(`rising pitch ${slope.toFixed(1)} st/s`);
      } else {
        // Level. The continuation cue, and the reason this module exists.
        const flatness = 1 - Math.min(1, Math.abs(slope) / 3);
        score += w.levelPitch * flatness;
        said.push(`level pitch ${slope.toFixed(1)} st/s`);
      }
    }

    const ratio = f.finalLengtheningRatio;
    if (ratio !== null && ratio > 1.15) {
      const strength = Math.min(1, (ratio - 1.15) / 0.85);
      score += w.finalLengthening * strength;
      said.push(`final lengthening ×${ratio.toFixed(2)}`);
    }

    const decay = f.terminalEnergySlopeDbPerSec;
    if (decay !== null) {
      if (decay <= -6) {
        const strength = Math.min(1, -decay / 25);
        score += w.energyDecay * strength;
        said.push(`trailing off ${decay.toFixed(0)} dB/s`);
      } else if (decay >= -1) {
        // Still at full volume when the voice stopped: cut off, not finished.
        score += w.abruptStop;
        said.push(`stopped at full energy (${decay.toFixed(0)} dB/s)`);
      }
    }

    return { score, reason: said.join(", ") || "no distinguishing prosody" };
  }

  /**
   * Fundamental frequency by normalized autocorrelation on a decimated frame.
   *
   * Decimated because the arithmetic matters: at 48 kHz the lag range for
   * 70–400 Hz is ~566 lags over 960 samples, which is half a million multiplies
   * per 20 ms frame — 27 million a second, on the audio path, in a browser. At
   * 8 kHz it is ~94 lags over 160 samples, about fifteen thousand, which is free.
   *
   * A box-filter decimation rather than a proper anti-aliasing filter: the
   * aliased content is above 4 kHz and this is looking for a peak below 400 Hz,
   * so the cheap version costs accuracy on nothing that is being measured.
   */
  private pitchOf(frame: Float32Array, sampleRate: number): number | null {
    const factor = Math.max(1, Math.round(sampleRate / ANALYSIS_RATE_HZ));
    const rate = sampleRate / factor;
    const n = Math.floor(frame.length / factor);
    if (n < 64) return null;

    if (this.analysis.length !== n) this.analysis = new Float32Array(n);
    const x = this.analysis;

    for (let i = 0; i < n; i += 1) {
      let sum = 0;
      const base = i * factor;
      for (let k = 0; k < factor; k += 1) sum += frame[base + k] ?? 0;
      x[i] = sum / factor;
    }

    // Remove DC. A biased frame produces a monotonically decaying
    // autocorrelation whose peak is always at lag 0, which reads as voiced
    // everywhere — the classic false-pitch bug.
    let mean = 0;
    for (let i = 0; i < n; i += 1) mean += x[i] ?? 0;
    mean /= n;

    let energy = 0;
    for (let i = 0; i < n; i += 1) {
      const v = (x[i] ?? 0) - mean;
      x[i] = v;
      energy += v * v;
    }
    if (energy <= 1e-9) return null;

    const minLag = Math.max(2, Math.floor(rate / MAX_F0_HZ));
    const maxLag = Math.min(n - 1, Math.ceil(rate / MIN_F0_HZ));
    if (maxLag <= minLag) return null;

    let bestLag = -1;
    let bestScore = 0;

    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let corr = 0;
      let tailEnergy = 0;
      for (let i = 0; i + lag < n; i += 1) {
        const a = x[i] ?? 0;
        const b = x[i + lag] ?? 0;
        corr += a * b;
        tailEnergy += b * b;
      }
      if (tailEnergy <= 1e-9) continue;

      // Normalized so a quiet frame and a loud frame at the same pitch score
      // alike — otherwise voicing detection becomes a volume threshold.
      const score = corr / Math.sqrt(energy * tailEnergy);
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }

    if (bestLag < 0 || bestScore < VOICING_THRESHOLD) return null;
    return rate / bestLag;
  }
}

// ── Feature extraction ──────────────────────────────────────────────────────

/**
 * Least-squares slope of pitch in semitones per second.
 *
 * Semitones rather than Hz because pitch is perceived logarithmically: a 20 Hz
 * fall is a shrug for a low voice and a plunge for a high one, and a detector
 * that treated them alike would read every speaker's gender as turn-taking
 * behaviour.
 */
export function pitchSlope(voiced: ReadonlyArray<{ atMs: number; f0: number }>): number | null {
  if (voiced.length < 3) return null;
  const points = voiced.map((f) => ({ x: f.atMs / 1000, y: 12 * Math.log2(f.f0) }));
  return leastSquaresSlope(points);
}

/** dB per second across the tail. */
export function energySlope(tail: ReadonlyArray<{ atMs: number; db: number }>): number | null {
  if (tail.length < 3) return null;
  const points = tail
    .filter((f) => Number.isFinite(f.db))
    .map((f) => ({ x: f.atMs / 1000, y: f.db }));
  return points.length < 3 ? null : leastSquaresSlope(points);
}

/**
 * Final voiced run over the median voiced run.
 *
 * Pre-boundary lengthening is one of the most robust boundary cues there is and
 * one of the cheapest to measure: the last thing said before a real boundary is
 * held longer than the things before it. Measured against the median rather than
 * the mean so one long run does not define its own baseline.
 */
export function lengthening(tail: ReadonlyArray<{ atMs: number; f0: number | null }>): number | null {
  const runs: number[] = [];
  let runStart: number | null = null;
  let lastAt = 0;

  for (const frame of tail) {
    if (frame.f0 !== null) {
      if (runStart === null) runStart = frame.atMs;
      lastAt = frame.atMs;
    } else if (runStart !== null) {
      runs.push(lastAt - runStart);
      runStart = null;
    }
  }
  if (runStart !== null) runs.push(lastAt - runStart);

  const nonTrivial = runs.filter((r) => r > 0);
  if (nonTrivial.length < 2) return null;

  const final = nonTrivial[nonTrivial.length - 1] ?? 0;
  const sorted = [...nonTrivial].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  if (median <= 0) return null;

  return final / median;
}

function leastSquaresSlope(points: ReadonlyArray<{ x: number; y: number }>): number | null {
  const n = points.length;
  if (n < 2) return null;

  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const mx = sx / n;
  const my = sy / n;

  let num = 0;
  let den = 0;
  for (const p of points) {
    const dx = p.x - mx;
    num += dx * (p.y - my);
    den += dx * dx;
  }

  // Every sample at one instant. Not a slope of zero — no slope at all.
  if (den <= 1e-9) return null;
  return num / den;
}

/** Frame energy as dBFS. Mirrors `vad.ts`, deliberately, rather than importing it. */
function frameDb(frame: Float32Array): number {
  let sumSquares = 0;
  for (const sample of frame) sumSquares += sample * sample;
  const rms = Math.sqrt(sumSquares / frame.length);
  if (rms <= 1e-10) return -200;
  return 20 * Math.log10(rms);
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}
