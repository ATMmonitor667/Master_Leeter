/**
 * Client-side voice activity detection (M3-2).
 *
 * ADR-001 established that Gemini Live has no equivalent of OpenAI's "VAD fires
 * but does not answer". Disabling `automaticActivityDetection` — which invariant
 * 1 requires, and which M3-1 now burns into the credential itself — means the
 * client sends `activityStart` / `activityEnd`, so **we own turn-boundary
 * detection**. This module is that.
 *
 * Deliberately pure: frames in, events out, no `AudioContext`, no clock of its
 * own. Every timestamp is supplied by the caller. That makes the thing which
 * most directly determines interruption quality testable in milliseconds rather
 * than by talking to it, which is the same reason the gate has a simulator.
 *
 * ── The asymmetry that shapes every parameter here ─────────────────────────
 *
 * The two errors this can make are not equally bad, and they are not even close.
 *
 * A **false speech-start** is nearly harmless. `SPEECH_STARTED` sets
 * `candidateSpeechStarted` and clears `lastSpeechStoppedAtMs` in the runtime, so
 * its only effect on the gate is to *hold the floor* — the interviewer stays
 * quiet. A cough that reads as speech costs a beat of silence nobody notices.
 *
 * A **premature speech-end** is the failure the whole product exists to avoid.
 * `SPEECH_STOPPED` starts the clock that M4-2 measures `silenceMs` from. Emit it
 * during a mid-sentence breath and the candidate is credited with silence they
 * never took; the ramp in `silenceCeiling` lifts, and the interviewer talks over
 * someone still speaking.
 *
 * So: quick to declare speech, slow to declare it finished. Every default below
 * leans that way, and `endHangoverMs` is the single most consequential number in
 * this file.
 *
 * ── Why the hangover is short anyway ───────────────────────────────────────
 *
 * There is a temptation to make `endHangoverMs` large — a second or more — since
 * late is safe. That would be a mistake, because it double-counts patience.
 * MOCK policy already refuses to treat anything under `minTurnEndSilenceMs`
 * (1500 ms) as a turn end, and ramps to `settledTurnEndSilenceMs` (2800 ms). If
 * this module also waited a second, the candidate would sit through ~3.5 s of
 * dead air before the interviewer could answer a direct question, and
 * missed-response rate is a tracked metric too.
 *
 * The division of labour: **this module answers "is there voice energy right
 * now", the policy answers "does that silence mean a finished turn".** Keep the
 * detector dumb and fast; let the gate be patient. Deterministic rules before
 * model reasoning, and cheap rules before expensive ones.
 */

/** Frame energy as dBFS. Silence is very negative; full scale is 0. */
export function frameDb(frame: Float32Array): number {
  if (frame.length === 0) return -Infinity;

  let sumSquares = 0;
  for (const sample of frame) sumSquares += sample * sample;

  const rms = Math.sqrt(sumSquares / frame.length);
  // Floor rather than -Infinity: a digital-silence frame is real input and the
  // noise-floor tracker has to be able to average it without poisoning itself.
  if (rms <= 1e-10) return -200;
  return 20 * Math.log10(rms);
}

export interface VadConfig {
  /**
   * How far above the noise floor counts as voice.
   *
   * Relative, not absolute, because a headset in a quiet room and a laptop mic
   * in a café differ by tens of dB and a fixed threshold works for exactly one
   * of them.
   */
  startMarginDb: number;
  /**
   * How far above the floor still counts as *continuing* to speak.
   *
   * Lower than `startMarginDb` on purpose — hysteresis. Without the gap, a
   * voice hovering near the threshold produces a burst of start/stop pairs, and
   * each spurious stop is a chance for the interviewer to interrupt.
   */
  continueMarginDb: number;
  /** Sustained voice required before declaring speech. Rejects clicks and taps. */
  minSpeechMs: number;
  /**
   * Quiet required before declaring the end of speech.
   *
   * Must comfortably exceed the gap between words and inside a stopped
   * consonant, and must stay well under the policy's `minTurnEndSilenceMs` so
   * the two do not stack into dead air. See the module comment.
   */
  endHangoverMs: number;
  /**
   * How fast the noise floor follows the room, per frame, 0–1.
   *
   * Slow on purpose. A fast tracker walks up into sustained speech and then
   * stops hearing it — the classic VAD failure, and it presents as the
   * interviewer interrupting someone who never stopped talking.
   */
  noiseAdaptRate: number;
  /**
   * Listen-only window at the start of a session.
   *
   * Not a nicety — without it a cold start in a room louder than
   * `initialNoiseFloorDb` is unrecoverable. The first frame reads as voice, the
   * detector latches to speaking, and adaptation is suppressed while speaking
   * precisely so that sustained speech cannot move the floor. The floor can then
   * never catch up to the room, and the session spends its entire length
   * believing the candidate is mid-sentence: no `SPEECH_STOPPED` is ever
   * emitted, so the gate holds the floor forever and the interviewer never
   * speaks again.
   *
   * Found by a test on a -40 dB room against a -55 dB initial estimate, which is
   * an ordinary laptop in an ordinary room.
   */
  calibrationMs: number;
  /**
   * Adaptation rate during calibration.
   *
   * Fast, because nothing can be declared during the window anyway, and a floor
   * that has not converged by the time the window closes reintroduces the bug it
   * exists to prevent.
   */
  calibrationAdaptRate: number;
  /** Starting estimate, used until the room has been heard. */
  initialNoiseFloorDb: number;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  startMarginDb: 9,
  continueMarginDb: 5,
  // Two 20ms frames of real voice. Long enough to reject a key press, short
  // enough that the first syllable is not swallowed.
  minSpeechMs: 40,
  // Comfortably longer than the ~200ms gap inside "…stop. Then…", comfortably
  // shorter than MOCK's 1500ms floor, which is what actually decides turn ends.
  endHangoverMs: 350,
  noiseAdaptRate: 0.02,
  // Half a second of listening before the detector is armed. The candidate is
  // reading the workspace at this point; nobody starts talking into a mic they
  // just granted permission to.
  calibrationMs: 500,
  calibrationAdaptRate: 0.25,
  initialNoiseFloorDb: -55,
};

export type VadEventType = "SPEECH_START" | "SPEECH_END";

export interface VadEvent {
  type: VadEventType;
  /**
   * When the event is judged to have happened, not when it was detected.
   *
   * A speech end is reported at the moment the quiet *began*, not one hangover
   * later. The distinction is the whole point: `silenceMs` is measured from this
   * timestamp, so reporting detection time would silently shorten every measured
   * pause by `endHangoverMs` and make the gate more willing to speak — in the
   * one direction it must never drift.
   */
  atMs: number;
}

export class Vad {
  private readonly config: VadConfig;
  private noiseFloorDb: number;

  private speaking = false;
  /** When the current run of above-threshold frames began. */
  private voiceRunStartedAtMs: number | null = null;
  /** When the current run of below-threshold frames began. */
  private quietRunStartedAtMs: number | null = null;
  /** Timestamp of the first frame, so the calibration window can be measured. */
  private firstFrameAtMs: number | null = null;

  constructor(config: Partial<VadConfig> = {}) {
    this.config = { ...DEFAULT_VAD_CONFIG, ...config };
    this.noiseFloorDb = this.config.initialNoiseFloorDb;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  get noiseFloor(): number {
    return this.noiseFloorDb;
  }

  /** True while still listening to the room. Nothing is declared during it. */
  calibrating(atMs: number): boolean {
    if (this.firstFrameAtMs === null) return true;
    return atMs - this.firstFrameAtMs < this.config.calibrationMs;
  }

  /**
   * Feed one frame. Returns any boundary it crossed.
   *
   * At most one event per frame — a frame cannot both start and end speech, and
   * returning an array only to hold zero or one item would invite callers to
   * write loops that hide that fact.
   */
  push(frame: Float32Array, atMs: number): VadEvent | null {
    return this.pushDb(frameDb(frame), atMs);
  }

  /** Energy-only entry point, so tests can drive levels directly. */
  pushDb(db: number, atMs: number): VadEvent | null {
    if (this.firstFrameAtMs === null) this.firstFrameAtMs = atMs;

    // Listen-only. Adapt hard and declare nothing — see `calibrationMs` for what
    // goes wrong without this.
    if (this.calibrating(atMs)) {
      this.noiseFloorDb += (db - this.noiseFloorDb) * this.config.calibrationAdaptRate;
      return null;
    }

    const margin = this.speaking ? this.config.continueMarginDb : this.config.startMarginDb;
    const isVoice = db > this.noiseFloorDb + margin;

    // Adapt only while silent. Adapting during speech is how a tracker climbs
    // into the voice it is supposed to be detecting and goes deaf mid-sentence.
    if (!isVoice && !this.speaking) {
      this.noiseFloorDb += (db - this.noiseFloorDb) * this.config.noiseAdaptRate;
    }

    return this.speaking ? this.whileSpeaking(isVoice, atMs) : this.whileSilent(isVoice, atMs);
  }

  private whileSilent(isVoice: boolean, atMs: number): VadEvent | null {
    if (!isVoice) {
      this.voiceRunStartedAtMs = null;
      return null;
    }

    if (this.voiceRunStartedAtMs === null) this.voiceRunStartedAtMs = atMs;

    if (atMs - this.voiceRunStartedAtMs >= this.config.minSpeechMs) {
      this.speaking = true;
      // Reported at the moment voice began, not when it was confirmed. The
      // confirmation delay is ours; it should not appear in the evidence log as
      // the candidate having started later than they did.
      const startedAt = this.voiceRunStartedAtMs;
      this.voiceRunStartedAtMs = null;
      this.quietRunStartedAtMs = null;
      return { type: "SPEECH_START", atMs: startedAt };
    }

    return null;
  }

  private whileSpeaking(isVoice: boolean, atMs: number): VadEvent | null {
    if (isVoice) {
      this.quietRunStartedAtMs = null;
      return null;
    }

    if (this.quietRunStartedAtMs === null) this.quietRunStartedAtMs = atMs;

    if (atMs - this.quietRunStartedAtMs >= this.config.endHangoverMs) {
      this.speaking = false;
      const endedAt = this.quietRunStartedAtMs;
      this.quietRunStartedAtMs = null;
      this.voiceRunStartedAtMs = null;
      return { type: "SPEECH_END", atMs: endedAt };
    }

    return null;
  }

  /**
   * Force the detector back to silence.
   *
   * For mute and for teardown. Returns an end event when it was mid-speech so
   * the caller can close the turn honestly rather than leaving a session that
   * believes the candidate is still talking forever.
   */
  reset(atMs: number): VadEvent | null {
    const wasSpeaking = this.speaking;
    this.speaking = false;
    this.voiceRunStartedAtMs = null;
    this.quietRunStartedAtMs = null;
    return wasSpeaking ? { type: "SPEECH_END", atMs } : null;
  }
}
