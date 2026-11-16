import type { LiveCredential } from "@master-leeter/contracts";

/**
 * Live voice credential.
 *
 * The browser talks straight to the realtime model. This module mints the
 * short-lived, single-use token that lets it, with the whole session setup
 * (prompt, voice, turn detection) locked inside the token. The API key and the
 * prompt therefore never reach the browser, and the browser cannot change them.
 *
 * Rules for the speaking path (LIVE_INTERVIEW_REBUILD_PLAN.txt, section 6.2):
 *   R1 nothing between the microphone and the model except the provider connection
 *   R2 no tool calls: context is pushed as text, never pulled
 *   R7 server silence stays at or above 500 ms; shorter fragments the audio
 */

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const WS_URL =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

export const DEFAULT_LIVE_MODEL = "gemini-3.8-live";
export const DEFAULT_LIVE_VOICE = "Charon";

export class LiveCredentialError extends Error {
  constructor(readonly kind: "NOT_CONFIGURED" | "RATE_LIMITED" | "PROVIDER" | "TIMEOUT", readonly status?: number) {
    super(`live credential: ${kind}`);
    this.name = "LiveCredentialError";
  }
}

export interface LiveMinterOptions {
  apiKey: string;
  model?: string | undefined;
  voice?: string | undefined;
  silenceMs?: number | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function liveSetup(opts: { model: string; voice: string; silenceMs: number; prompt: string; resumptionHandle?: string | undefined }) {
  return {
    model: `models/${opts.model}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice } } },
    },
    systemInstruction: { parts: [{ text: opts.prompt }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // A 45-minute interview outlives one context window and one connection.
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: opts.resumptionHandle ? { handle: opts.resumptionHandle } : {},
    realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: opts.silenceMs } },
  };
}

export class LiveMinter {
  readonly model: string;
  private readonly voice: string;
  private readonly silenceMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: LiveMinterOptions) {
    this.model = opts.model || DEFAULT_LIVE_MODEL;
    this.voice = opts.voice || DEFAULT_LIVE_VOICE;
    this.silenceMs = Math.max(500, opts.silenceMs ?? 600);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  async mint(prompt: string, resumptionHandle?: string): Promise<LiveCredential> {
    const now = this.now();
    const expiresAt = new Date(now + 30 * 60_000).toISOString();
    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE_URL}/auth_tokens`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.opts.apiKey },
        body: JSON.stringify({
          uses: 1,
          expireTime: expiresAt,
          // The window to OPEN the connection. Short: the page connects at once.
          newSessionExpireTime: new Date(now + 90_000).toISOString(),
          bidiGenerateContentSetup: liveSetup({ model: this.model, voice: this.voice, silenceMs: this.silenceMs, prompt, resumptionHandle }),
        }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      const name = (error as Error)?.name;
      throw new LiveCredentialError(name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "PROVIDER");
    }
    if (res.status === 429) throw new LiveCredentialError("RATE_LIMITED", 429);
    if (!res.ok) throw new LiveCredentialError("PROVIDER", res.status);
    const token = ((await res.json().catch(() => ({}))) as { name?: string }).name;
    if (!token) throw new LiveCredentialError("PROVIDER");
    return {
      provider: "gemini",
      wsUrl: `${WS_URL}?access_token=${encodeURIComponent(token)}`,
      model: `models/${this.model}`,
      expiresAt,
    };
  }
}

export function liveMinterFromEnv(env: NodeJS.ProcessEnv = process.env): LiveMinter | null {
  const apiKey = env["REALTIME_API_KEY"]?.trim() || env["GEMINI_API_KEY"]?.trim();
  if (!apiKey) return null;
  const silence = Number(env["LIVE_SILENCE_MS"]);
  return new LiveMinter({
    apiKey,
    model: env["LIVE_MODEL"]?.trim(),
    voice: env["LIVE_VOICE"]?.trim(),
    ...(Number.isFinite(silence) && silence > 0 ? { silenceMs: silence } : {}),
  });
}
