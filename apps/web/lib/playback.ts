import { LIVE_OUTPUT_SAMPLE_RATE, pcm16ToFloat } from "./audio";

/**
 * Gapless playback of model audio (M3-2).
 *
 * The Live API streams 24 kHz PCM16 in chunks that arrive faster than real time
 * and are not aligned to anything. Playing each one "now" as it lands produces
 * overlapping or gapped audio, because `currentTime` has moved on by the time
 * the next chunk is scheduled. The fix is a running cursor: each buffer starts
 * where the previous one ended, and the cursor only resets to the clock when
 * playback has actually drained.
 *
 * ── Why this is separated from the socket ──────────────────────────────────
 *
 * Two reasons, and the second is the important one.
 *
 * The scheduling arithmetic is where clicks and drift come from, and it is
 * ordinary arithmetic — testable against a fake sink, which is what
 * `playback.test.ts` does. No `AudioContext` appears here.
 *
 * And `stop()` has to be *immediate and total*. It is what barge-in calls: the
 * candidate has started speaking over the interviewer, and every buffer already
 * queued must be cancelled, not allowed to finish. A scheduler that merely stops
 * enqueueing would keep talking for however much audio was already scheduled —
 * which, since chunks arrive faster than real time, can be seconds. That is the
 * single most visible failure this product can produce, so it gets its own
 * object with its own tests.
 */

/** One scheduled buffer, so it can be cancelled. */
export interface ScheduledSource {
  stop(): void;
}

/**
 * The bits of Web Audio this needs.
 *
 * Declared structurally rather than imported so the scheduler runs in a test
 * with no DOM, and so a future swap (an OfflineAudioContext for rendering, say)
 * does not touch this file.
 */
export interface AudioSink {
  /** Seconds, monotonically increasing. `AudioContext.currentTime`. */
  readonly currentTime: number;
  /** True only after the output context has resumed. */
  readonly running?: boolean;
  /** Schedules `samples` to begin at `atTime`, returning a handle to cancel it. */
  play(samples: Float32Array, sampleRate: number, atTime: number): ScheduledSource;
  /** Optional shared gain stage for provisional barge-in. */
  setGain?(value: number, seconds: number): void;
}

export interface PlaybackSchedulerOptions {
  sink: AudioSink;
  sampleRate?: number;
  /**
   * Lead time before the first chunk of a burst.
   *
   * Scheduling at exactly `currentTime` is a race: if the buffer is handed over
   * a millisecond late the context has already passed it, and Web Audio plays it
   * immediately with the start clipped. A small lead absorbs that without being
   * audible as latency.
   */
  leadSeconds?: number;
  /** Shorter lead for an already-running output context. */
  runningLeadSeconds?: number;
  /**
   * Fired once, on natural drain only.
   *
   * Triggered when the last buffer finishes playing on its own — via `release()`.
   * Never fired by `stop()`, because barge-in ending playback is not the same
   * event as the interviewer finishing a sentence. The caller uses this to report
   * a COMPLETED speech outcome.
   */
  onDrained?: () => void;
}

export class PlaybackScheduler {
  private readonly sink: AudioSink;
  private readonly sampleRate: number;
  private readonly leadSeconds: number;
  private readonly runningLeadSeconds: number;
  private readonly onDrained: (() => void) | undefined;

  /** When the next buffer should start. Null when nothing is queued. */
  private cursor: number | null = null;
  private readonly active = new Set<ScheduledSource>();
  private ducked = false;

  constructor(opts: PlaybackSchedulerOptions) {
    this.sink = opts.sink;
    this.sampleRate = opts.sampleRate ?? LIVE_OUTPUT_SAMPLE_RATE;
    this.leadSeconds = opts.leadSeconds ?? 0.06;
    this.runningLeadSeconds = opts.runningLeadSeconds ?? 0.03;
    this.onDrained = opts.onDrained;
  }

  /** True while audio is scheduled or playing. Drives the Speaking indicator. */
  get isPlaying(): boolean {
    return this.active.size > 0;
  }

  /** Seconds of audio still queued ahead of the clock. */
  get queuedSeconds(): number {
    if (this.cursor === null) return 0;
    return Math.max(0, this.cursor - this.sink.currentTime);
  }

  /**
   * Schedule the next chunk of model audio using the default sample rate.
   *
   * Returns the scheduled start time (seconds, AudioContext clock) so the
   * caller can record when audio actually begins. A return of `null` means the
   * chunk was empty and nothing was scheduled.
   */
  enqueue(pcm: Int16Array): number | null {
    return this.enqueueAt(pcm, this.sampleRate);
  }

  /**
   * Schedule a PCM16 chunk at an explicit sample rate.
   *
   * Used for cached TTS audio, which may have a different rate from the Live
   * API's 24 kHz stream. Returns the scheduled start time in seconds, or null
   * when the chunk is empty.
   */
  enqueueAt(pcm: Int16Array, sampleRate: number): number | null {
    if (pcm.length === 0) return null;

    const samples = pcm16ToFloat(pcm);
    const now = this.sink.currentTime;

    // Resume from the cursor when it is still ahead of the clock; otherwise the
    // queue has drained and this is a fresh burst, which needs the lead again.
    const lead = this.sink.running ? this.runningLeadSeconds : this.leadSeconds;
    const startAt = this.cursor !== null && this.cursor > now ? this.cursor : now + lead;

    const source = this.sink.play(samples, sampleRate, startAt);
    this.active.add(source);
    this.cursor = startAt + samples.length / sampleRate;
    return startAt;
  }

  /**
   * Called when a scheduled buffer finishes on its own.
   *
   * The sink drives this — Web Audio's `onended`. Without it `isPlaying` would
   * stay true forever and the interviewer would appear to be speaking for the
   * rest of the session.
   */
  release(source: ScheduledSource): void {
    if (!this.active.delete(source)) return;
    if (this.active.size === 0) {
      this.cursor = null;
      // Natural drain: the last buffer finished on its own. Report completion.
      // stop() clears active directly without going through release, so this
      // fires only for natural endings — never for barge-in.
      this.onDrained?.();
    }
  }

  /** Make cached speech inaudible while deciding whether a vocalization is a barge-in. */
  duck(): void {
    if (!this.sink.setGain) { this.stop(); return; }
    if (this.ducked) return;
    this.ducked = true;
    this.sink.setGain(0.025, 0.03);
  }

  restore(): void {
    if (!this.ducked) return;
    this.ducked = false;
    this.sink.setGain?.(1, 0.03);
  }

  /**
   * Cancel everything, immediately. This is barge-in.
   *
   * Stops each already-scheduled source rather than just clearing the queue.
   * Chunks arrive faster than real time, so "stop enqueueing" can leave seconds
   * of audio still scheduled — the interviewer talking over a candidate who has
   * started answering, which is the failure this product exists to avoid.
   */
  stop(): void {
    if (this.ducked) {
      this.ducked = false;
      this.sink.setGain?.(1, 0);
    }
    for (const source of this.active) {
      try {
        source.stop();
      } catch {
        // Already ended. Web Audio throws on double-stop in some engines and a
        // barge-in must never fail because one buffer finished a tick early.
      }
    }

    this.active.clear();
    this.cursor = null;
  }
}
