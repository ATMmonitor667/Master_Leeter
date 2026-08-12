import { describe, expect, it } from "vitest";
import { DEFAULT_VAD_CONFIG, Vad, type VadEvent, frameDb } from "./vad";

/**
 * These are silence-quality tests, not signal-processing tests.
 *
 * Every case below is phrased as a moment in an interview, because that is what
 * the numbers are for: a premature SPEECH_END starts the clock M4-2 measures
 * `silenceMs` from, and the interviewer speaks over someone who was still
 * talking.
 */

const FRAME_MS = 20;

/**
 * Drives frames at a fixed level and collects boundaries.
 *
 * The clock is per-VAD and monotonic across calls. An earlier version restarted
 * at zero each call, which walked time backwards for any instance fed twice and
 * produced failures that looked like detector bugs.
 */
const clocks = new WeakMap<Vad, number>();

function feed(
  vad: Vad,
  segments: Array<{ db: number; ms: number }>,
): { events: VadEvent[]; startedAtMs: number; endedAtMs: number } {
  const events: VadEvent[] = [];
  const startedAtMs = clocks.get(vad) ?? 0;
  let t = startedAtMs;

  for (const segment of segments) {
    for (let elapsed = 0; elapsed < segment.ms; elapsed += FRAME_MS) {
      const event = vad.pushDb(segment.db, t);
      if (event) events.push(event);
      t += FRAME_MS;
    }
  }

  clocks.set(vad, t);
  return { events, startedAtMs, endedAtMs: t };
}

const QUIET = -60;
const VOICE = -25;

/** Settles the noise floor against room tone, as a real session would. */
function settled(config = {}): Vad {
  const vad = new Vad(config);
  feed(vad, [{ db: QUIET, ms: 2_000 }]);
  return vad;
}

describe("frameDb", () => {
  it("reports digital silence as a floor, not -Infinity", () => {
    // -Infinity would poison the noise-floor average on the first quiet frame.
    expect(frameDb(new Float32Array(128))).toBe(-200);
  });

  it("reports full-scale as roughly 0 dBFS", () => {
    expect(frameDb(new Float32Array(128).fill(1))).toBeCloseTo(0, 5);
  });

  it("is monotonic in amplitude", () => {
    const quiet = frameDb(new Float32Array(128).fill(0.01));
    const loud = frameDb(new Float32Array(128).fill(0.5));
    expect(loud).toBeGreaterThan(quiet);
  });
});

describe("declaring speech", () => {
  it("detects sustained voice", () => {
    const { events } = feed(settled(), [{ db: VOICE, ms: 500 }]);
    expect(events.map((e) => e.type)).toEqual(["SPEECH_START"]);
  });

  it("ignores a click too short to be a syllable", () => {
    // A key press or a chair creak. One frame of energy is not a turn.
    const { events } = feed(settled(), [
      { db: VOICE, ms: 20 },
      { db: QUIET, ms: 400 },
    ]);
    expect(events).toEqual([]);
  });

  it("reports the moment voice began, not the moment it was confirmed", () => {
    // The confirmation delay is ours. Logging it as a later start would misplace
    // the candidate's turn in the evidence log.
    const { events, startedAtMs } = feed(settled(), [
      { db: QUIET, ms: 100 },
      { db: VOICE, ms: 300 },
    ]);
    expect(events[0]?.atMs).toBe(startedAtMs + 100);
  });
});

describe("declaring the end of speech — the dangerous direction", () => {
  it("does NOT end on the gap between two words", () => {
    // ~120ms of quiet inside "…hash map. Then…". Ending here would credit the
    // candidate with silence they never took.
    const { events } = feed(settled(), [
      { db: VOICE, ms: 400 },
      { db: QUIET, ms: 120 },
      { db: VOICE, ms: 400 },
    ]);
    expect(events.map((e) => e.type)).toEqual(["SPEECH_START"]);
  });

  it("does not end on a stopped consonant", () => {
    const { events } = feed(settled(), [
      { db: VOICE, ms: 300 },
      { db: QUIET, ms: 60 },
      { db: VOICE, ms: 300 },
      { db: QUIET, ms: 80 },
      { db: VOICE, ms: 300 },
    ]);
    expect(events.filter((e) => e.type === "SPEECH_END")).toEqual([]);
  });

  it("ends once the candidate has genuinely stopped", () => {
    const { events } = feed(settled(), [
      { db: VOICE, ms: 400 },
      { db: QUIET, ms: 600 },
    ]);
    expect(events.map((e) => e.type)).toEqual(["SPEECH_START", "SPEECH_END"]);
  });

  /**
   * The one that protects M4-2.
   *
   * `silenceMs` is measured from this timestamp. Reporting detection time
   * instead of onset would shorten every measured pause by the hangover, lifting
   * `silenceCeiling` and making the gate more willing to speak — the single
   * direction this must never drift in.
   */
  it("reports the moment quiet began, not one hangover later", () => {
    const { events, startedAtMs } = feed(settled(), [
      { db: VOICE, ms: 400 },
      { db: QUIET, ms: 600 },
    ]);

    const end = events.find((e) => e.type === "SPEECH_END");
    // Onset of quiet, not onset + hangover.
    expect(end?.atMs).toBe(startedAtMs + 400);
  });

  it("keeps the hangover well under MOCK's turn-end floor", () => {
    // The two must not stack. MOCK refuses to treat anything under 1500ms as a
    // turn end; if this module also waited a second, a direct question would sit
    // unanswered for ~3.5s and missed-response rate is tracked too.
    expect(DEFAULT_VAD_CONFIG.endHangoverMs).toBeLessThan(1_500 / 3);
  });
});

describe("hysteresis", () => {
  it("does not flutter when a voice hovers near the threshold", () => {
    const vad = settled();
    const floor = vad.noiseFloor;

    // Between the continue and start margins: enough to keep speaking, not
    // enough to have started. Without hysteresis this alternates start/stop.
    const marginal = floor + (DEFAULT_VAD_CONFIG.startMarginDb + DEFAULT_VAD_CONFIG.continueMarginDb) / 2;

    const { events } = feed(vad, [
      { db: VOICE, ms: 200 },
      { db: marginal, ms: 600 },
    ]);

    expect(events.map((e) => e.type)).toEqual(["SPEECH_START"]);
  });
});

describe("noise floor adaptation", () => {
  /**
   * The cold-start latch, which this test found.
   *
   * A -40 dB room against a -55 dB initial estimate is an ordinary laptop in an
   * ordinary room. Without a calibration window the first frame reads as voice,
   * the detector latches to speaking, and adaptation is suppressed while
   * speaking — deliberately, so sustained speech cannot move the floor. The
   * floor can then never catch up: no SPEECH_STOPPED is ever emitted, the gate
   * holds the floor forever, and the interviewer goes mute for the session.
   */
  it("adapts to a loud room instead of latching to speech forever", () => {
    const noisy = new Vad();
    const { events } = feed(noisy, [{ db: -40, ms: 4_000 }]);

    expect(events).toEqual([]);
    expect(noisy.isSpeaking, "latched into speaking on a loud room").toBe(false);
    expect(noisy.noiseFloor).toBeGreaterThan(-50);
  });

  it("still hears speech over that louder room", () => {
    const noisy = new Vad();
    feed(noisy, [{ db: -40, ms: 4_000 }]);

    const { events } = feed(noisy, [{ db: -20, ms: 400 }]);
    expect(events.map((e) => e.type)).toEqual(["SPEECH_START"]);
  });

  /**
   * The classic VAD failure, and it presents exactly as the product's worst bug.
   *
   * A tracker that adapts during speech climbs into the voice, stops hearing it,
   * and emits SPEECH_END mid-sentence — so the interviewer interrupts someone
   * who never paused.
   */
  it("does not climb into sustained speech and go deaf", () => {
    const vad = settled();
    const floorBefore = vad.noiseFloor;

    const { events } = feed(vad, [{ db: VOICE, ms: 8_000 }]);

    expect(events.map((e) => e.type)).toEqual(["SPEECH_START"]);
    expect(vad.noiseFloor).toBeCloseTo(floorBefore, 5);
  });
});

describe("reset", () => {
  it("closes an open turn so a muted session does not believe it is still talking", () => {
    const vad = settled();
    feed(vad, [{ db: VOICE, ms: 300 }]);
    expect(vad.isSpeaking).toBe(true);

    const event = vad.reset(9_999);
    expect(event).toEqual({ type: "SPEECH_END", atMs: 9_999 });
    expect(vad.isSpeaking).toBe(false);
  });

  it("emits nothing when it was already silent", () => {
    expect(settled().reset(1_000)).toBeNull();
  });
});

describe("the asymmetry is real", () => {
  /**
   * Stated as an executable claim rather than a comment, because it is the
   * reasoning every default in the module depends on.
   */
  it("takes longer to declare speech over than to declare it started", () => {
    expect(DEFAULT_VAD_CONFIG.endHangoverMs).toBeGreaterThan(DEFAULT_VAD_CONFIG.minSpeechMs * 4);
  });

  it("requires more energy to start speaking than to continue", () => {
    expect(DEFAULT_VAD_CONFIG.startMarginDb).toBeGreaterThan(DEFAULT_VAD_CONFIG.continueMarginDb);
  });
});
