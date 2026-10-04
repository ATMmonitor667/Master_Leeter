/**
 * Room tone (V5).
 *
 * ── The half of the complaint that is not milliseconds ─────────────────────
 *
 * `persona.ts` is right that silence is the product: *"Silence is the normal
 * state of this role and it is not awkward — the candidate is working."* As
 * interview design that is correct and nothing here changes it.
 *
 * As AUDIO design it produces something no interview room has ever contained. A
 * real interviewer sitting across the table is, acoustically, never nothing —
 * there is breath, a chair, the room itself. This product's channel is
 * bit-exact digital silence for minutes at a time and then a complete, fluent,
 * two-sentence utterance out of nowhere. Long silence with a zero noise floor
 * does not read as patience. It reads as a dropped call, and the candidate's
 * next move is to say "hello? are you there?" — which is the exact opposite of
 * the composure the persona is trying to project.
 *
 * So: a continuous, very quiet bed, present from the moment voice connects.
 * This is the cheapest change in the whole latency programme and plausibly one
 * of the most effective, because it costs no latency at all and fixes a
 * complaint that no amount of speed would have touched.
 *
 * ── Why it is synthesized rather than a recording ──────────────────────────
 *
 * A recorded room is someone's actual room, with their actual air conditioning
 * and their actual street outside, looping every few seconds — and a loop is
 * audible the moment anyone notices it. Filtered noise has no period to notice.
 * It is also a few lines instead of an asset in the build, a cache entry, and a
 * licence question.
 *
 * ── What this is NOT ───────────────────────────────────────────────────────
 *
 * Not a backchannel, not an acknowledgement, and not anything the persona
 * forbids. It carries no information about the candidate and says nothing. It
 * is the difference between a line that is open and a line that is dead.
 */

/**
 * Level of the bed, as a linear gain.
 *
 * −54dB. Audible as presence on headphones, inaudible as a sound — if a
 * listener can tell you what it sounds like, it is too loud. Well under the
 * noise floor of any real microphone, so it never competes with speech and
 * never triggers anything.
 */
export const DEFAULT_ROOM_TONE_GAIN = 0.002;

/** Seconds of noise generated. Long enough that the loop has no audible period. */
const BUFFER_SECONDS = 8;

/** Fade in, so connecting does not click. */
const FADE_SECONDS = 1.5;

export interface RoomToneOptions {
  gain?: number;
}

/**
 * A quiet, continuous bed on the interviewer's channel.
 *
 * Owns its own nodes and nothing else's. `stop()` is idempotent and safe to
 * call on a closed context, because teardown happens on unmount and on error
 * paths where the context may already be gone.
 */
export class RoomTone {
  private source: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;

  constructor(
    private readonly context: AudioContext,
    private readonly opts: RoomToneOptions = {},
  ) {}

  get isRunning(): boolean {
    return this.source !== null;
  }

  start(): void {
    if (this.source) return;

    const target = this.opts.gain ?? DEFAULT_ROOM_TONE_GAIN;
    const buffer = this.context.createBuffer(
      1,
      Math.floor(this.context.sampleRate * BUFFER_SECONDS),
      this.context.sampleRate,
    );
    fillWithFilteredNoise(buffer.getChannelData(0));

    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0, this.context.currentTime);
    gain.gain.linearRampToValueAtTime(target, this.context.currentTime + FADE_SECONDS);
    gain.connect(this.context.destination);

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    source.start();

    this.source = source;
    this.gainNode = gain;
  }

  stop(): void {
    try {
      this.source?.stop();
    } catch {
      // Already stopped, or the context is closing. Teardown must not throw on
      // a path that is usually itself an error path.
    }
    this.source?.disconnect();
    this.gainNode?.disconnect();
    this.source = null;
    this.gainNode = null;
  }
}

/**
 * Pink-ish noise: white noise through a one-pole lowpass, twice.
 *
 * Exported for the test, and because the shape is the whole point. Raw white
 * noise is hiss — it sounds like a fault, which is precisely the impression
 * this exists to remove. Rolling off the top makes it read as air in a room
 * rather than as a broken channel.
 *
 * Two cascaded poles rather than a real pinking filter: the difference is
 * inaudible at −54dB and this is a dozen operations per sample with no
 * coefficients to get wrong.
 */
export function fillWithFilteredNoise(out: Float32Array, alpha = 0.06): void {
  let a = 0;
  let b = 0;

  for (let i = 0; i < out.length; i += 1) {
    const white = Math.random() * 2 - 1;
    a += alpha * (white - a);
    b += alpha * (a - b);
    // Compensating gain — two lowpass stages take most of the energy out, and
    // the caller's gain should mean the same thing regardless of the filter.
    out[i] = b * 12;
  }

  // Fade the seam. A loop point in noise is a click, and a click every eight
  // seconds is far more noticeable than the noise it interrupts.
  const ramp = Math.min(1_000, Math.floor(out.length / 8));
  for (let i = 0; i < ramp; i += 1) {
    const t = i / ramp;
    const head = out[i] ?? 0;
    const tail = out[out.length - ramp + i] ?? 0;
    out[i] = head * t + tail * (1 - t);
  }
}
