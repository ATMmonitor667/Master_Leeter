/**
 * One authorized interviewer utterance, from authorization to an honest ending.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * The voice shell used to track a turn with half a dozen booleans
 * (`speechInFlight`, `modelAudioStarted`, `providerTurnComplete`, ...). Each
 * failure path cleared a different subset, and two of them reported COMPLETED
 * for speech the candidate never fully heard: a cached tail whose fetch died
 * halfway, and a provider turn that ended after a prefix. A brief that was
 * authorized but never played looked, to the server, exactly like one that was.
 *
 * This is the replacement: a single state machine per utterance,
 *
 *   AUTHORIZED → REQUESTED → FIRST_AUDIO → PLAYING → COMPLETED
 *
 * with terminal outcomes INTERRUPTED, FAILED and CANCELLED. Pure — no timers,
 * no audio, no fetch — so every transition is testable without a browser.
 *
 * ── The rule that matters ──────────────────────────────────────────────────
 *
 * COMPLETED requires BOTH halves of delivery:
 *
 *   - the SOURCE finished honestly (provider `turnComplete`, or a cached stream
 *     whose byte count matched what the server said it would send), and
 *   - local PLAYBACK drained what was queued.
 *
 * Either one alone is not delivery. Generation can finish seconds before the
 * speaker does, and a drained queue in the middle of a stream is an underrun,
 * not an ending. This still measures application playback, not proof that a
 * listener heard the sound.
 *
 * Duplicate and out-of-order signals are expected (late provider frames, a
 * second `turnComplete`, an `onended` after barge-in) and are absorbed rather
 * than thrown: once terminal, an utterance ignores everything.
 */

export type UtterancePhase =
  | "AUTHORIZED"
  | "REQUESTED"
  | "FIRST_AUDIO"
  | "PLAYING"
  | "COMPLETED"
  | "INTERRUPTED"
  | "FAILED"
  | "CANCELLED";

export type UtteranceOutcome = "COMPLETED" | "INTERRUPTED" | "FAILED" | "CANCELLED";

export type UtteranceSource = "CACHED" | "MODEL";

export type UtteranceSignal =
  /** The model was asked to speak (or the cached stream was opened). */
  | { type: "REQUESTED" }
  /** Validated audio for this utterance arrived. `seconds` of PCM. */
  | { type: "AUDIO_RECEIVED"; seconds: number }
  /** A buffer for this utterance was scheduled on the output clock. */
  | { type: "PLAYBACK_STARTED" }
  /** No more audio will arrive, and what arrived is complete. */
  | { type: "SOURCE_COMPLETE" }
  /** Everything queued so far finished playing on its own. */
  | { type: "PLAYBACK_DRAINED" }
  /** The candidate confirmed a barge-in. `unplayedSeconds` were still queued. */
  | { type: "INTERRUPT"; unplayedSeconds?: number }
  | { type: "FAIL"; reason: string; unplayedSeconds?: number }
  | { type: "CANCEL"; reason: string };

/** What the server and the latency ledger are told when an utterance ends. */
export interface UtteranceReport {
  utteranceId: string;
  action: string;
  source: UtteranceSource;
  outcome: UtteranceOutcome;
  /** Machine-readable cause for every non-COMPLETED outcome. */
  reason?: string;
  /** True once any validated audio for this utterance reached playback. */
  firstAudio: boolean;
  receivedAudioMs: number;
  /** Best estimate of what local playback actually rendered. */
  playedAudioMs: number;
  /** Times the queue drained while the source was still streaming. */
  underruns: number;
  /** Monotonic duration from authorization to the terminal outcome. */
  durationMs: number;
}

const TERMINAL: ReadonlySet<UtterancePhase> = new Set([
  "COMPLETED",
  "INTERRUPTED",
  "FAILED",
  "CANCELLED",
]);

export function isTerminal(phase: UtterancePhase): boolean {
  return TERMINAL.has(phase);
}

export class UtteranceLifecycle {
  private current: UtterancePhase = "AUTHORIZED";
  private sourceComplete = false;
  private receivedSeconds = 0;
  private playbackActive = false;
  private underrunCount = 0;
  private report: UtteranceReport | null = null;

  constructor(
    readonly utteranceId: string,
    readonly action: string,
    private sourceKind: UtteranceSource,
    private readonly authorizedAtMs: number,
  ) {}

  get phase(): UtterancePhase {
    return this.current;
  }

  get source(): UtteranceSource {
    return this.sourceKind;
  }

  get terminal(): boolean {
    return isTerminal(this.current);
  }

  /** True once validated audio for this utterance has arrived. */
  get hasAudio(): boolean {
    return this.receivedSeconds > 0;
  }

  get isSourceComplete(): boolean {
    return this.sourceComplete;
  }

  get underruns(): number {
    return this.underrunCount;
  }

  /** The terminal report, once there is one. */
  get outcome(): UtteranceReport | null {
    return this.report;
  }

  /**
   * A cached head failed validation before any audio played, so the model is
   * asked instead. Only legal before audio exists; afterwards a switch would
   * repeat the sentence.
   */
  switchSource(source: UtteranceSource): boolean {
    if (this.terminal || this.hasAudio) return false;
    this.sourceKind = source;
    return true;
  }

  /**
   * Apply one signal. Returns the terminal report when this signal ended the
   * utterance, otherwise null. Signals after the end are ignored.
   */
  apply(signal: UtteranceSignal, atMs: number): UtteranceReport | null {
    if (this.terminal) return null;

    switch (signal.type) {
      case "REQUESTED":
        if (this.current === "AUTHORIZED") this.current = "REQUESTED";
        return null;

      case "AUDIO_RECEIVED":
        if (!(signal.seconds > 0)) return null;
        this.receivedSeconds += signal.seconds;
        if (this.current === "AUTHORIZED" || this.current === "REQUESTED") {
          this.current = "FIRST_AUDIO";
        }
        return null;

      case "PLAYBACK_STARTED":
        // Scheduling without a recorded AUDIO_RECEIVED is a caller bug; the
        // sample is still real, so move forward rather than lose it.
        this.playbackActive = true;
        if (this.current !== "PLAYING") this.current = "PLAYING";
        return null;

      case "SOURCE_COMPLETE":
        this.sourceComplete = true;
        // A provider that ends its turn without audio delivered nothing. That
        // was the silent-brief bug, and it is a failure, not a completion.
        if (!this.hasAudio) return this.finish("FAILED", atMs, "EMPTY_RESPONSE", 0);
        if (!this.playbackActive) return this.finish("COMPLETED", atMs, undefined, 0);
        return null;

      case "PLAYBACK_DRAINED":
        if (!this.playbackActive) return null;
        this.playbackActive = false;
        if (this.sourceComplete) return this.finish("COMPLETED", atMs, undefined, 0);
        // The queue ran dry while more audio was still owed: an underrun.
        // Whether that becomes a stall is the caller's timer to decide.
        this.underrunCount += 1;
        return null;

      case "INTERRUPT":
        return this.hasAudio
          ? this.finish("INTERRUPTED", atMs, "CANDIDATE_BARGE_IN", signal.unplayedSeconds ?? 0)
          : this.finish("CANCELLED", atMs, "CANDIDATE_SPOKE_BEFORE_AUDIO", 0);

      case "FAIL":
        return this.finish("FAILED", atMs, signal.reason, signal.unplayedSeconds ?? 0);

      case "CANCEL":
        return this.finish("CANCELLED", atMs, signal.reason, 0);
    }
  }

  private finish(
    outcome: UtteranceOutcome,
    atMs: number,
    reason: string | undefined,
    unplayedSeconds: number,
  ): UtteranceReport {
    this.current = outcome;
    this.playbackActive = false;
    const receivedAudioMs = Math.round(this.receivedSeconds * 1000);
    const unplayedMs = Math.round(Math.max(0, unplayedSeconds) * 1000);
    this.report = {
      utteranceId: this.utteranceId,
      action: this.action,
      source: this.sourceKind,
      outcome,
      ...(reason ? { reason } : {}),
      firstAudio: this.hasAudio,
      receivedAudioMs,
      playedAudioMs: Math.max(0, receivedAudioMs - unplayedMs),
      underruns: this.underrunCount,
      durationMs: Math.max(0, Math.round(atMs - this.authorizedAtMs)),
    };
    return this.report;
  }
}
