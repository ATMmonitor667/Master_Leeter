/**
 * Audio format conversion for the realtime voice path (M3-2).
 *
 * Pure functions over sample buffers. No `AudioContext`, no `navigator`, no
 * network — the capture graph is a thin shell over this, so the arithmetic that
 * is easy to get quietly wrong is testable without a microphone.
 *
 * "Quietly wrong" is the operative phrase. Every bug in this file produces audio
 * that still plays: clipping wraps into a crack, a bad resample ratio produces a
 * chipmunk, wrong endianness produces static. None of them throw, and all of
 * them would reach the model as a transcript that is subtly worse — which then
 * looks like the classifier being bad at its job.
 *
 * ── Rates ──────────────────────────────────────────────────────────────────
 *
 * Gemini Live takes 16 kHz mono PCM16 in and returns 24 kHz PCM16 out. Neither
 * is negotiable and they are deliberately different, so a single constant would
 * be wrong in one direction. Browser microphones are typically 48 kHz and
 * sometimes 44.1 kHz, so resampling is mandatory rather than an optimisation.
 */

/** What the Live API accepts. Mono, little-endian, signed 16-bit. */
export const LIVE_INPUT_SAMPLE_RATE = 16_000;

/** What the Live API returns. Not the same as the input rate — playback differs. */
export const LIVE_OUTPUT_SAMPLE_RATE = 24_000;

/** MIME the Live API expects alongside base64 input audio. */
export const LIVE_INPUT_MIME = `audio/pcm;rate=${LIVE_INPUT_SAMPLE_RATE}`;

/**
 * Convert float samples to signed 16-bit.
 *
 * Two details that are wrong in most snippets of this function:
 *
 * 1. **Clamping is mandatory.** Web Audio does not guarantee samples within
 *    ±1.0 — gain, mixing, and some drivers overshoot. `1.2 * 32767` overflows
 *    `Int16Array`, which wraps to a large *negative* number, so the loudest part
 *    of a word becomes a full-scale click in the opposite direction. It is
 *    audible, it is worst on exactly the syllables the VAD cares about, and it
 *    does not throw.
 *
 * 2. **The range is asymmetric.** Int16 spans -32768…32767, so scaling both
 *    directions by 32768 overflows every positive full-scale sample by one.
 *    Scaling both by 32767 instead loses a quantisation step at the bottom.
 *    Each side gets its own factor.
 */
export function floatToPcm16(frame: Float32Array): Int16Array {
  const out = new Int16Array(frame.length);

  for (let i = 0; i < frame.length; i++) {
    const clamped = Math.max(-1, Math.min(1, frame[i] ?? 0));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  return out;
}

/** Inverse, for playback and for round-trip tests. */
export function pcm16ToFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);

  for (let i = 0; i < pcm.length; i++) {
    const sample = pcm[i] ?? 0;
    out[i] = sample < 0 ? sample / 0x8000 : sample / 0x7fff;
  }

  return out;
}

/**
 * Resample to a different rate.
 *
 * Linear interpolation with box-filter averaging when downsampling. Stated
 * plainly: this is not a proper polyphase FIR, and for music it would be
 * audibly poor.
 *
 * It is the right trade here. The consumers are a speech model and an energy
 * detector, neither of which is sensitive to the passband ripple a real filter
 * would fix, and this runs on every 20 ms frame on the UI thread's audio worklet
 * budget. What it must not do is *naive decimation* — taking every third sample
 * and discarding the rest aliases everything above 8 kHz back down into the
 * speech band as intermodulation noise, which raises the noise floor the VAD
 * measures against and degrades transcription. Averaging across the window is a
 * crude low-pass, and crude is the difference that matters; the step from box
 * filter to FIR is much smaller than the step from nothing to box filter.
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input.slice();
  if (input.length === 0) return new Float32Array(0);
  if (fromRate <= 0 || toRate <= 0) throw new Error("sample rates must be positive");

  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);

  if (ratio > 1) {
    // Downsampling: average the source window each output sample covers.
    for (let i = 0; i < outLength; i++) {
      const start = i * ratio;
      const end = Math.min(input.length, start + ratio);
      const first = Math.floor(start);
      const last = Math.min(input.length, Math.ceil(end));

      let sum = 0;
      let count = 0;
      for (let j = first; j < last; j++) {
        sum += input[j] ?? 0;
        count++;
      }
      out[i] = count > 0 ? sum / count : 0;
    }
    return out;
  }

  // Upsampling: linear interpolation between neighbours.
  for (let i = 0; i < outLength; i++) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const weight = position - left;
    out[i] = (input[left] ?? 0) * (1 - weight) + (input[right] ?? 0) * weight;
  }

  return out;
}

/**
 * Encode PCM16 as base64, little-endian.
 *
 * Endianness is written explicitly through a `DataView` rather than handing over
 * `Int16Array.buffer`. A typed array uses *platform* byte order, which is
 * little-endian everywhere this will realistically run — so the shortcut works
 * until it silently does not, and the failure mode is audio that arrives as
 * static with no error anywhere.
 *
 * The chunking is not premature either: `String.fromCharCode(...bytes)` spreads
 * every byte as an argument and throws `RangeError: Maximum call stack size
 * exceeded` on buffers larger than roughly 64 KB. A 20 ms frame is far below
 * that, but a buffered reconnect flush is not.
 */
export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);

  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(i * 2, pcm[i] ?? 0, true);
  }

  const CHUNK = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }

  return btoa(binary);
}

/** Decode base64 PCM16 back to samples. Used for model audio on the way to playback. */
export function base64ToPcm16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  // An odd byte count cannot be whole samples. Truncate rather than read past
  // the end, which would produce one garbage sample per malformed chunk.
  const sampleCount = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer);
  const out = new Int16Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) out[i] = view.getInt16(i * 2, true);

  return out;
}

/**
 * Capture-rate float frame to what the wire wants.
 *
 * The single call the capture graph makes. Resample first, then quantise: the
 * other order quantises samples that are about to be averaged away, which
 * throws away precision for no reason.
 */
export function encodeForLive(frame: Float32Array, captureRate: number): string {
  const resampled = resample(frame, captureRate, LIVE_INPUT_SAMPLE_RATE);
  return pcm16ToBase64(floatToPcm16(resampled));
}
