import type { UtteranceTranscriber } from "./utterance-audio.js";

const DEFAULT_MODEL = "gemini-3.5-transcribe";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** Verifies rendered speech off the live response path, without sending authored text. */
export function geminiUtteranceTranscriber(
  apiKey: string,
  opts: { model?: string; baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): UtteranceTranscriber {
  const model = opts.model ?? DEFAULT_MODEL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return async (pcm, sampleRate) => {
    const wav = pcmToWav(pcm, sampleRate);
    const response = await fetchImpl(
      `${opts.baseUrl ?? DEFAULT_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [
            { inlineData: { mimeType: "audio/wav", data: wav.toString("base64") } },
          ] }],
          generationConfig: { audioTranscriptionConfig: { mode: "VERBATIM" } },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) throw new Error(`TTS_VERIFICATION_HTTP_${response.status}`);
    const body = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const transcript = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
    if (!transcript) throw new Error("TTS_VERIFICATION_EMPTY_TRANSCRIPT");
    return transcript;
  };
}

function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 48_000 ||
      pcm.length === 0 || pcm.length % 2 !== 0 || pcm.length > 15_000_000) {
    throw new Error("INVALID_TTS_AUDIO_FOR_VERIFICATION");
  }
  const wav = Buffer.allocUnsafe(44 + pcm.length);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}
