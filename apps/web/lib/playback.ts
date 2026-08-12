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
  /** Schedules `samples` to begin at `atTime`, returning a handle to cancel it. */
  play(samples: Float32Array, sampleRate: number, atTime: number): ScheduledSource;
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
}

export class PlaybackScheduler {
  private readonly sink: AudioSink;
  private readonly sampleRate: number;
  private readonly leadSeconds: number;

  /** When the next buffer should start. Null when nothing is queued. */
  private cursor: number | null = null;
  private readonly active = new Set<ScheduledSource>();

  constructor(opts: PlaybackSchedulerOptions) {
    this.sink = opts.sink;
    this.sampleRate = opts.sampleRate ?? LIVE_OUTPUT_SAMPLE_RATE;
    this.leadSeconds = opts.leadSeconds ?? 0.06;
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

  enqueue(pcm: Int16Array): void {
    if (pcm.length === 0) return;

    const samples = pcm16ToFloat(pcm);
    const now = this.sink.currentTime;

    // Resume from the cursor when it is still ahead of the clock; otherwise the
    // queue has drained and this is a fresh burst, which needs the lead again.
    const startAt = this.cursor !== null && this.cursor > now ? this.cursor : now + this.leadSeconds;

    const source = this.sink.play(samples, this.sampleRate, startAt);
    this.active.add(source);
    this.cursor = startAt + samples.length / this.sampleRate;
  }

  /**
   * Called when a scheduled buffer finishes on its own.
   *
   * The sink drives this — Web Audio's `onended`. Without it `isPlaying` would
   * stay true forever and the interviewer would appear to be speaking for the
   * rest of the session.
   */
  release(source: ScheduledSource): void {
    this.active.delete(source);
    if (this.active.size === 0) this.cursor = null;
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
