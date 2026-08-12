import { describe, expect, it } from "vitest";
import {
  LIVE_INPUT_SAMPLE_RATE,
  LIVE_OUTPUT_SAMPLE_RATE,
  base64ToPcm16,
  encodeForLive,
  floatToPcm16,
  pcm16ToBase64,
  pcm16ToFloat,
  resample,
} from "./audio";
import { frameDb } from "./vad";

/**
 * Every bug this file can have produces audio that still plays.
 *
 * Nothing here throws on bad input — clipping wraps into a crack, a bad ratio
 * produces a chipmunk, wrong endianness produces static. So these tests assert
 * the arithmetic directly rather than that a call succeeded.
 */

/** A sine at `hz`, for aliasing and round-trip checks. */
function tone(hz: number, sampleRate: number, ms: number, amplitude = 0.5): Float32Array {
  const n = Math.floor((sampleRate * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

describe("float to PCM16", () => {
  /**
   * The bug worth the most: Web Audio does not guarantee samples within ±1.0,
   * and 1.2 * 32767 overflows Int16 into a large NEGATIVE number. The loudest
   * part of a word becomes a full-scale click in the opposite direction, and
   * nothing throws.
   */
  it("clamps overshoot instead of wrapping it into a click", () => {
    const pcm = floatToPcm16(new Float32Array([1.5, -1.5, 2, -2]));

    expect(pcm[0]).toBe(32767);
    expect(pcm[1]).toBe(-32768);
    expect(pcm[2]).toBe(32767);
    expect(pcm[3]).toBe(-32768);

    // The actual symptom: no positive input may produce a negative sample.
    for (const sample of pcm.slice(0, 1)) expect(sample).toBeGreaterThan(0);
  });

  it("uses the full asymmetric Int16 range without overflowing it", () => {
    const pcm = floatToPcm16(new Float32Array([1, -1, 0]));
    expect(pcm[0]).toBe(32767);
    expect(pcm[1]).toBe(-32768);
    expect(pcm[2]).toBe(0);
  });

  it("round-trips within a quantisation step", () => {
    const original = tone(440, LIVE_INPUT_SAMPLE_RATE, 50);
    const restored = pcm16ToFloat(floatToPcm16(original));

    for (let i = 0; i < original.length; i++) {
      expect(Math.abs((restored[i] ?? 0) - (original[i] ?? 0))).toBeLessThan(1 / 32000);
    }
  });
});

describe("base64 PCM16", () => {
  it("round-trips exactly", () => {
    const pcm = new Int16Array([0, 1, -1, 32767, -32768, 1234, -4321]);
    expect(Array.from(base64ToPcm16(pcm16ToBase64(pcm)))).toEqual(Array.from(pcm));
  });

  /**
   * Endianness is explicit rather than inherited from the platform. A typed
   * array's byte order is whatever the CPU uses, so handing over `.buffer`
   * works until it silently does not — and the failure is static, with no error.
   */
  it("writes little-endian regardless of platform byte order", () => {
    // 0x0102 little-endian is 0x02 0x01.
    const bytes = atob(pcm16ToBase64(new Int16Array([0x0102])));
    expect(bytes.charCodeAt(0)).toBe(0x02);
    expect(bytes.charCodeAt(1)).toBe(0x01);
  });

  it("survives a buffer far larger than the argument limit", () => {
    // String.fromCharCode(...bytes) throws RangeError past ~64KB. A 20ms frame
    // is nowhere near it; a buffered reconnect flush is.
    const big = new Int16Array(200_000);
    for (let i = 0; i < big.length; i++) big[i] = (i % 1000) - 500;

    expect(() => pcm16ToBase64(big)).not.toThrow();
    expect(base64ToPcm16(pcm16ToBase64(big)).length).toBe(big.length);
  });

  it("truncates an odd byte count rather than reading past the end", () => {
    // One trailing byte cannot be a whole sample.
    const odd = btoa("\x01\x02\x03");
    expect(base64ToPcm16(odd).length).toBe(1);
  });
});

describe("resampling", () => {
  it("is a no-op at the same rate", () => {
    const input = tone(300, 16_000, 20);
    expect(Array.from(resample(input, 16_000, 16_000))).toEqual(Array.from(input));
  });

  it("produces the expected length for the common 48k capture", () => {
    const input = tone(300, 48_000, 20); // 960 samples
    expect(resample(input, 48_000, LIVE_INPUT_SAMPLE_RATE).length).toBe(320);
  });

  it("handles the non-integer 44.1k ratio", () => {
    const input = tone(300, 44_100, 20); // 882 samples
    const out = resample(input, 44_100, LIVE_INPUT_SAMPLE_RATE);
    expect(out.length).toBe(320);
    expect(out.every((s) => Number.isFinite(s))).toBe(true);
  });

  it("upsamples for playback rates too", () => {
    expect(resample(tone(300, 16_000, 20), 16_000, LIVE_OUTPUT_SAMPLE_RATE).length).toBe(480);
  });

  /**
   * The reason this is not naive decimation.
   *
   * Taking every third sample folds everything above 8 kHz back into the speech
   * band. That raises the noise floor the VAD measures against and degrades the
   * transcript — and it presents as the classifier being bad at its job.
   */
  it("attenuates content above the new Nyquist instead of folding it down", () => {
    // 15 kHz at a 48k capture is far above the 8 kHz limit of a 16k stream.
    const ultrasonic = tone(15_000, 48_000, 100, 0.8);
    const downsampled = resample(ultrasonic, 48_000, LIVE_INPUT_SAMPLE_RATE);

    // Naive decimation would alias this to full amplitude. Averaging must leave
    // it markedly quieter than it started.
    expect(frameDb(downsampled)).toBeLessThan(frameDb(ultrasonic) - 6);
  });

  it("preserves speech-band content it is supposed to keep", () => {
    const speech = tone(300, 48_000, 100, 0.5);
    const downsampled = resample(speech, 48_000, LIVE_INPUT_SAMPLE_RATE);

    // A 300 Hz tone is well inside the passband; it must survive largely intact.
    expect(frameDb(downsampled)).toBeGreaterThan(frameDb(speech) - 2);
  });

  it("rejects a nonsensical rate rather than dividing by zero", () => {
    expect(() => resample(tone(300, 16_000, 20), 0, 16_000)).toThrow();
  });

  it("handles an empty frame", () => {
    expect(resample(new Float32Array(0), 48_000, 16_000).length).toBe(0);
  });
});

describe("encodeForLive", () => {
  it("produces decodable 16kHz audio from a 48kHz capture frame", () => {
    const captured = tone(440, 48_000, 20, 0.5);
    const decoded = base64ToPcm16(encodeForLive(captured, 48_000));

    expect(decoded.length).toBe(320);
    // Not silence — a mistake in the chain usually produces zeros or noise.
    expect(frameDb(pcm16ToFloat(decoded))).toBeGreaterThan(-30);
  });

  it("resamples before quantising, so precision is not thrown away first", () => {
    // Quantising then averaging loses a bit for no reason. Hard to assert
    // directly, so this pins the observable consequence: the result matches the
    // documented order of operations exactly.
    const captured = tone(440, 48_000, 20, 0.5);
    const expected = pcm16ToBase64(floatToPcm16(resample(captured, 48_000, LIVE_INPUT_SAMPLE_RATE)));

    expect(encodeForLive(captured, 48_000)).toBe(expected);
  });
});

describe("the two rates are not interchangeable", () => {
  it("keeps input and output rates distinct", () => {
    // A single SAMPLE_RATE constant would be wrong in one direction, and the
    // symptom is playback at the wrong pitch.
    expect(LIVE_INPUT_SAMPLE_RATE).not.toBe(LIVE_OUTPUT_SAMPLE_RATE);
  });
});
