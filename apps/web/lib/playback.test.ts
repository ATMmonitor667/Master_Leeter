import { describe, expect, it } from "vitest";
import { LIVE_OUTPUT_SAMPLE_RATE } from "./audio";
import { PlaybackScheduler, type AudioSink, type ScheduledSource } from "./playback";

/** A sink that records scheduling decisions instead of making sound. */
function fakeSink() {
  const scheduled: Array<{ atTime: number; seconds: number; stopped: boolean }> = [];
  let currentTime = 0;

  const sink: AudioSink = {
    get currentTime() {
      return currentTime;
    },
    play(samples, sampleRate, atTime) {
      const entry = { atTime, seconds: samples.length / sampleRate, stopped: false };
      scheduled.push(entry);
      const source: ScheduledSource = {
        stop() {
          entry.stopped = true;
        },
      };
      return source;
    },
  };

  return {
    sink,
    scheduled,
    advance: (seconds: number) => {
      currentTime += seconds;
    },
    setTime: (t: number) => {
      currentTime = t;
    },
  };
}

/** 100ms of 24kHz audio. */
const chunk = (ms = 100) => new Int16Array(Math.floor((LIVE_OUTPUT_SAMPLE_RATE * ms) / 1000));

describe("gapless scheduling", () => {
  /**
   * Chunks arrive faster than real time. Playing each one at `currentTime`
   * overlaps them, because the clock has barely moved between arrivals.
   */
  it("queues consecutive chunks end to end, not on top of each other", () => {
    const f = fakeSink();
    const scheduler = new PlaybackScheduler({ sink: f.sink, leadSeconds: 0.05 });

    scheduler.enqueue(chunk(100));
    scheduler.enqueue(chunk(100));
    scheduler.enqueue(chunk(100));

    const [a, b, c] = f.scheduled;
    expect(a?.atTime).toBeCloseTo(0.05, 6);
    expect(b?.atTime).toBeCloseTo(0.15, 6);
    expect(c?.atTime).toBeCloseTo(0.25, 6);
  });

  it("leaves no gap between chunks", () => {
    const f = fakeSink();
    const scheduler = new PlaybackScheduler({ sink: f.sink });

    for (let i = 0; i < 5; i++) scheduler.enqueue(chunk(80));

    for (let i = 1; i < f.scheduled.length; i++) {
      const previous = f.scheduled[i - 1]!;
      const current = f.scheduled[i]!;
      expect(current.atTime).toBeCloseTo(previous.atTime + previous.seconds, 6);
    }
  });

  /**
   * Scheduling at exactly currentTime is a race: hand the buffer over a
   * millisecond late and the context has passed it, so Web Audio plays it
   * immediately with the attack clipped.
   */
  it("schedules the first chunk slightly ahead of the clock", () => {
    const f = fakeSink();
    const scheduler = new PlaybackScheduler({ sink: f.sink, leadSeconds: 0.06 });

    scheduler.enqueue(chunk());
    expect(f.scheduled[0]?.atTime).toBeGreaterThan(f.sink.currentTime);
  });

  it("takes the lead again for a new burst after the queue drains", () => {
    const f = fakeSink();
    const scheduler = new PlaybackScheduler({ sink: f.sink, leadSeconds: 0.05 });

    const first = f.scheduled;
    scheduler.enqueue(chunk(100));
    const source = { stop: () => {} };
    void source;

    // The first burst finishes and the sink reports it ended.
    f.advance(1);
    scheduler.stop();

    scheduler.enqueue(chunk(100));
    expect(first.at(-1)?.atTime).toBeCloseTo(1.05, 6);
  });

  it("does not schedule an empty chunk", () => {
    const f = fakeSink();
    const scheduler = new PlaybackScheduler({ sink: f.sink });

    scheduler.enqueue(new Int16Array(0));
    expect(f.scheduled).toHaveLength(0);
  });
});

describe("barge-in", () => {
  /**
   * The most visible failure this product can produce.
   *
   * Chunks arrive faster than real time, so by the time the candidate speaks
   * there can be seconds of audio already scheduled. Merely stopping the queue
   * would let the interviewer keep talking over them.
   */
  it("cancels audio that is already scheduled, not just future audio", () => {
    const f = fakeSink();
    const scheduler = new PlaybackScheduler({ sink: f.sink });

    for (let i = 0; i < 10; i++) scheduler.enqueue(chunk(200));
    expect(scheduler.queuedSeconds).toBeGreaterThan(1.5);

    scheduler.stop();

    expect(f.scheduled.every((s) => s.stopped)).toBe(true);
    expect(scheduler.queuedSeconds).toBe(0);
    expect(scheduler.isPlaying).toBe(false);
  });

  it("survives a source that has already ended", () => {
    const f = fakeSink();
    const scheduler = new PlaybackScheduler({
      sink: {
        get currentTime() {
          return f.sink.currentTime;
        },
        play: () => ({
          stop() {
            // Some engines throw on double-stop. A barge-in must not fail
            // because one buffer finished a tick early.
            throw new Error("InvalidStateError");
          },
        }),
      },
    });

    scheduler.enqueue(chunk());
    expect(() => scheduler.stop()).not.toThrow();
    expect(scheduler.isPlaying).toBe(false);
  });

  it("starts cleanly after a barge-in", () => {
    const f = fakeSink();
    const scheduler = new PlaybackScheduler({ sink: f.sink, leadSeconds: 0.05 });

    scheduler.enqueue(chunk(500));
    scheduler.stop();

    f.setTime(2);
    scheduler.enqueue(chunk(100));

    // Not scheduled relative to the cancelled burst's cursor.
    expect(f.scheduled.at(-1)?.atTime).toBeCloseTo(2.05, 6);
  });
});

describe("playing state", () => {
  it("reports playing while audio is queued", () => {
    const f = fakeSink();
    const scheduler = new PlaybackScheduler({ sink: f.sink });

    expect(scheduler.isPlaying).toBe(false);
    scheduler.enqueue(chunk());
    expect(scheduler.isPlaying).toBe(true);
  });

  /**
   * Without release the indicator would say Speaking for the rest of the
   * session, and gate rule 1 reads the same flag server-side.
   */
  it("stops reporting playing once every buffer has ended", () => {
    const f = fakeSink();
    const scheduler = new PlaybackScheduler({ sink: f.sink });

    const sources: ScheduledSource[] = [];
    const recording: AudioSink = {
      get currentTime() {
        return f.sink.currentTime;
      },
      play: (samples, rate, at) => {
        const s = f.sink.play(samples, rate, at);
        sources.push(s);
        return s;
      },
    };

    const s2 = new PlaybackScheduler({ sink: recording });
    s2.enqueue(chunk());
    s2.enqueue(chunk());
    expect(s2.isPlaying).toBe(true);

    for (const source of sources) s2.release(source);
    expect(s2.isPlaying).toBe(false);
    expect(s2.queuedSeconds).toBe(0);
    void scheduler;
  });
});

describe("rate", () => {
  it("plays at the Live output rate, not the input rate", () => {
    const f = fakeSink();
    const scheduler = new PlaybackScheduler({ sink: f.sink });

    // 24000 samples is one second at the output rate. At 16k it would be 1.5s,
    // and the interviewer would sound slow and deep.
    scheduler.enqueue(new Int16Array(LIVE_OUTPUT_SAMPLE_RATE));
    expect(f.scheduled[0]?.seconds).toBeCloseTo(1, 6);
  });
});
