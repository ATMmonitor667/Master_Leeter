/**
 * Speech synthesis for authored interviewer lines (V3).
 *
 * ── Why this exists at all ─────────────────────────────────────────────────
 *
 * The interviewer never improvises. `persona.ts` says it outright —
 * *"Everything substantive comes from a tool"* — and `runtime.realize()` proves
 * it: every branch of that switch reads a string out of the pinned scenario
 * version and returns it. The opening script, the reviewed repeat variants, the
 * canonical facts, the authored probe wordings, the four hint levels, the
 * follow-up deltas. That set is FINITE and it is KNOWN AT SESSION START,
 * because `002_session_storage.sql` makes the scenario pin immutable.
 *
 * Finite authored text does not need a realtime generative model to speak it.
 * On `main` it gets one anyway, and the bill is roughly 1.1–3.0 seconds per
 * utterance: a model turn to emit a tool call, three network hops to answer it
 * through a browser the candidate controls, and a second model turn to produce
 * audio (ADR-001 measured that last one alone at p50 1044 ms, p95 1638 ms).
 * Rendering the same words once, at session start, and playing them from a
 * buffer costs network latency and a scheduling lead — call it 50–150 ms.
 *
 * ── The part that is not about latency ─────────────────────────────────────
 *
 * A model that cannot generate output audio cannot speak out of turn, cannot
 * leak the problem statement, cannot praise, cannot teach, and cannot be talked
 * into any of it, because it is no longer in the output path. "No config exists
 * in which the model speaks without a gate decision" stops being a property
 * maintained by careful credential configuration and becomes a property of the
 * data flow. This module makes the invariants cheaper to hold, not more
 * expensive.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 *
 * An interface, one implementation, and a fake. No cache, no enumeration of
 * what to render, no HTTP surface — those are `utterance-audio.ts` and the
 * session module. A synthesizer that also knows what a scenario is would be a
 * second home for scenario knowledge.
 *
 * Not an SDK dependency, for the same reason `lib/gemini.ts` is not: this is one
 * POST with a timeout.
 */

import type { InterviewerTone } from "@master-leeter/contracts";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * The model Gemini's TTS endpoint speaks through.
 *
 * Separate from `REALTIME_MODEL` on purpose: that one is chosen for time to
 * first audio under ADR-001, and this one is chosen for voice quality, because
 * it runs before the interview starts and nobody is waiting on it.
 */
export const DEFAULT_TTS_MODEL = "gemini-2.5-flash-preview-tts";

/**
 * What Gemini's TTS endpoint returns, and what the Live API streams.
 *
 * Both are 24 kHz mono PCM16, which is also what `playback.ts` already
 * schedules — so cached audio and model audio go down the same pipe and the
 * client needs no second decoder.
 */
export const TTS_SAMPLE_RATE = 24_000;

/**
 * Style directions prepended to the text for non-default tones.
 *
 * These are NOT authored interviewer speech — they are synthesis instructions.
 * P3.3 render verification confirms they are not spoken literally. NORMAL
 * receives no direction: the voice and persona wording already carry the
 * register, and an added instruction would be a second, unreviewed place where
 * the interviewer's tone is decided.
 */
const TONE_DIRECTIONS: Partial<Record<InterviewerTone, string>> = {
  EXTRA_NICE: "(Speak in a warm, encouraging tone.)\n",
  MEAN: "(Speak in a cold, terse tone.)\n",
};

export class TtsError extends Error {
  constructor(
    message: string,
    readonly kind: "TIMEOUT" | "RATE_LIMITED" | "HTTP" | "MALFORMED" | "NO_KEY",
    readonly status?: number,
  ) {
    super(message);
    this.name = "TtsError";
  }
}

export interface RenderedSpeech {
  /** Mono PCM16 little-endian at `sampleRate`. Ready for `playback.enqueue`. */
  pcm: Buffer;
  sampleRate: number;
  voiceId: string;
  model: string;
}

/**
 * The seam a different vendor goes through.
 *
 * Deliberately shaped around "here is a line, give me samples" rather than
 * around Gemini's request body, so swapping in ElevenLabs or Cartesia later is
 * a new class in this file and nothing else.
 */
export interface TtsRenderer {
  /** Stable identifier for logs and for the cache key. */
  readonly id: string;
  readonly voiceId: string;
  configured(): boolean;
  render(text: string, opts?: { tone?: InterviewerTone }): Promise<RenderedSpeech>;
}

export interface GeminiTtsOptions {
  apiKey?: string | undefined;
  model?: string | undefined;
  voiceId: string;
  baseUrl?: string | undefined;
  requestTimeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: { mimeType?: string; data?: string };
        inline_data?: { mime_type?: string; data?: string };
      }>;
    };
  }>;
  promptFeedback?: { blockReason?: string };
}

export class GeminiTts implements TtsRenderer {
  readonly voiceId: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GeminiTtsOptions) {
    this.voiceId = opts.voiceId;
    this.model = opts.model ?? DEFAULT_TTS_MODEL;
    // Generous, unlike the classifier's. This runs during session setup, off
    // the critical path, and a slow render is far better than a missing one:
    // an uncached line falls back to the realtime model and costs a second
    // every time it is spoken.
    this.timeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get id(): string {
    return `gemini-tts:${this.model}:${this.voiceId}`;
  }

  configured(): boolean {
    return Boolean(this.opts.apiKey) && Boolean(this.model) && Boolean(this.voiceId);
  }

  async render(text: string, opts?: { tone?: InterviewerTone }): Promise<RenderedSpeech> {
    if (!this.opts.apiKey) throw new TtsError("no API key configured for TTS", "NO_KEY");
    if (text.trim() === "") throw new TtsError("refusing to synthesize empty text", "MALFORMED");

    const tone = opts?.tone ?? "NORMAL";
    const direction = TONE_DIRECTIONS[tone];
    // The direction is a synthesis instruction, NOT authored content. It is
    // prepended so the model produces the right register. Render verification
    // (P3.3) confirms the direction itself was not spoken.
    const promptText = direction ? `${direction}${text}` : text;

    const url = `${this.opts.baseUrl ?? DEFAULT_BASE_URL}/models/${encodeURIComponent(
      this.model,
    )}:generateContent`;

    const body = {
      contents: [{ role: "user", parts: [{ text: promptText }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voiceId } },
        },
      },
    };

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.opts.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new TtsError(`TTS request exceeded ${this.timeoutMs}ms`, "TIMEOUT");
      }
      throw new TtsError((err as Error).message, "HTTP");
    }

    if (res.status === 429) throw new TtsError("TTS rate limit exceeded", "RATE_LIMITED", 429);
    if (!res.ok) throw new TtsError(`TTS responded ${res.status}`, "HTTP", res.status);

    let parsed: GenerateContentResponse;
    try {
      parsed = (await res.json()) as GenerateContentResponse;
    } catch {
      throw new TtsError("TTS response was not JSON", "MALFORMED");
    }

    if (parsed.promptFeedback?.blockReason) {
      throw new TtsError(`TTS blocked the prompt: ${parsed.promptFeedback.blockReason}`, "MALFORMED");
    }

    const audio = extractInlineAudio(parsed);
    if (!audio) throw new TtsError("TTS returned no audio part", "MALFORMED");

    const pcm = Buffer.from(audio.data, "base64");
    if (pcm.length === 0) throw new TtsError("TTS returned an empty audio part", "MALFORMED");

    return {
      pcm,
      sampleRate: sampleRateFromMime(audio.mimeType),
      voiceId: this.voiceId,
      model: this.model,
    };
  }
}

/**
 * A deterministic fake for tests.
 *
 * Silence proportional to the text, so tests can assert cache keys, prewarm
 * behaviour, byte lengths and the HTTP surface without a key or a network. It
 * is NOT a fallback: a session that loses its renderer must fall back to the
 * realtime model, which still says the right words, rather than play silence
 * and look like a dropped call.
 */
export class FakeTts implements TtsRenderer {
  readonly id = "fake-tts";
  private readonly bytesPerChar: number;

  constructor(
    readonly voiceId = "fake-voice",
    bytesPerChar = 2,
  ) {
    this.bytesPerChar = bytesPerChar;
  }

  configured(): boolean {
    return true;
  }

  render(text: string, _opts?: { tone?: InterviewerTone }): Promise<RenderedSpeech> {
    return Promise.resolve({
      pcm: Buffer.alloc(Math.max(2, text.length * this.bytesPerChar)),
      sampleRate: TTS_SAMPLE_RATE,
      voiceId: this.voiceId,
      model: this.id,
    });
  }
}

function extractInlineAudio(
  parsed: GenerateContentResponse,
): { data: string; mimeType: string } | null {
  const parts = parsed.candidates?.[0]?.content?.parts ?? [];

  for (const part of parts) {
    // Both spellings appear on this API depending on the path, the same way
    // they do in `extractModelAudio` on the client.
    const camel = part.inlineData;
    const snake = part.inline_data;

    const data = camel?.data ?? snake?.data;
    if (typeof data !== "string" || data === "") continue;

    return { data, mimeType: camel?.mimeType ?? snake?.mime_type ?? "" };
  }

  return null;
}

/**
 * Read the rate out of `audio/L16;codec=pcm;rate=24000`.
 *
 * Falls back to the documented default rather than guessing from the byte
 * count. A wrong rate is not a crash — it is an interviewer who sounds slowed
 * down or sped up, which is the kind of bug that gets attributed to the voice.
 */
export function sampleRateFromMime(mimeType: string): number {
  const match = /rate=(\d+)/i.exec(mimeType);
  const parsed = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : TTS_SAMPLE_RATE;
}

/**
 * Build a renderer from the environment, or null when TTS is unconfigured.
 *
 * Null is a supported state, exactly like `minterFromEnv`. Without a renderer
 * every authored line falls back to the realtime model — which is what `main`
 * does today, so the product is slower rather than broken, and the boot log
 * says which one is running.
 */
export function ttsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  apiKey?: string | undefined,
  defaultVoice = "Charon",
): TtsRenderer | null {
  const enabled = (env["TTS_PRERENDER"] ?? "on").trim().toLowerCase();
  if (enabled === "off" || enabled === "false" || enabled === "0") return null;

  if (!apiKey) return null;

  // Same voice as the realtime credential by default, so a session that mixes
  // cached lines with a model-spoken acknowledgement does not change speaker
  // halfway through.
  const voiceId = set(env["REALTIME_VOICE"]) ?? defaultVoice;
  const renderer = new GeminiTts({
    apiKey,
    voiceId,
    ...(set(env["TTS_MODEL"]) ? { model: set(env["TTS_MODEL"]) } : {}),
  });

  return renderer.configured() ? renderer : null;
}

/** A variable set to the empty string is not set — same rule as `lib/gemini.ts`. */
function set(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
