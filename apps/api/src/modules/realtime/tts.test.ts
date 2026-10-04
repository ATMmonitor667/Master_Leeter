import { describe, expect, it } from "vitest";
import { FakeTts, GeminiTts, TTS_SAMPLE_RATE, TtsError, sampleRateFromMime, ttsFromEnv } from "./tts.js";

/**
 * What these assert, and what they deliberately do not.
 *
 * The interesting behaviour of a synthesizer is not "does it sound right" —
 * nothing in CI can judge that. It is the request shape (a wrong
 * `responseModalities` returns text and the interviewer plays nothing), the
 * response parsing across both JSON spellings, and the typed failures, because
 * every one of them has to degrade to the realtime model rather than to silence.
 */

const audioResponse = (data: string, mimeType = "audio/L16;codec=pcm;rate=24000") =>
  new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType, data } }] } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const pcmBase64 = Buffer.from(new Int16Array([0, 1000, -1000, 0]).buffer).toString("base64");

describe("GeminiTts", () => {
  it("asks for audio, in the configured voice", async () => {
    let body: Record<string, unknown> = {};

    const tts = new GeminiTts({
      apiKey: "k",
      voiceId: "Charon",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return audioResponse(pcmBase64);
      },
    });

    await tts.render("Walk me through your approach.");

    const config = (body["generationConfig"] ?? {}) as Record<string, unknown>;
    expect(config["responseModalities"]).toEqual(["AUDIO"]);
    expect(JSON.stringify(config["speechConfig"])).toContain("Charon");
  });

  it("sends the authored text verbatim for NORMAL tone, with no style instruction", async () => {
    // A synthesis-time prefix would be a second, unreviewed place where the
    // interviewer's tone is decided. NORMAL sends the text as-is.
    let body: Record<string, unknown> = {};
    const line = "What happens when the list is empty?";

    const tts = new GeminiTts({
      apiKey: "k",
      voiceId: "Charon",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return audioResponse(pcmBase64);
      },
    });

    await tts.render(line, { tone: "NORMAL" });

    const contents = body["contents"] as Array<{ parts: Array<{ text: string }> }>;
    expect(contents[0]?.parts[0]?.text).toBe(line);
  });

  it("prepends a style direction for EXTRA_NICE and MEAN, never for NORMAL", async () => {
    const captured: string[] = [];
    const tts = new GeminiTts({
      apiKey: "k",
      voiceId: "Charon",
      fetchImpl: async (_url, init) => {
        const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const contents = b["contents"] as Array<{ parts: Array<{ text: string }> }>;
        captured.push(contents[0]?.parts[0]?.text ?? "");
        return audioResponse(pcmBase64);
      },
    });

    const line = "Walk me through your approach.";
    await tts.render(line, { tone: "NORMAL" });
    await tts.render(line, { tone: "EXTRA_NICE" });
    await tts.render(line, { tone: "MEAN" });

    // NORMAL: text is the authored line exactly
    expect(captured[0]).toBe(line);
    // EXTRA_NICE: has a prefix, but the authored line is still inside
    expect(captured[1]).not.toBe(line);
    expect(captured[1]).toContain(line);
    // MEAN: same pattern
    expect(captured[2]).not.toBe(line);
    expect(captured[2]).toContain(line);
  });

  it("decodes the inline audio and reads the rate off the mime type", async () => {
    const tts = new GeminiTts({
      apiKey: "k",
      voiceId: "Charon",
      fetchImpl: async () => audioResponse(pcmBase64, "audio/L16;codec=pcm;rate=16000"),
    });

    const rendered = await tts.render("hello");
    expect(rendered.pcm.length).toBe(8);
    expect(rendered.sampleRate).toBe(16_000);
  });

  it("accepts the snake_case spelling of the audio part", async () => {
    const tts = new GeminiTts({
      apiKey: "k",
      voiceId: "Charon",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ inline_data: { mime_type: "audio/L16;rate=24000", data: pcmBase64 } }] } },
            ],
          }),
          { status: 200 },
        ),
    });

    await expect(tts.render("hello")).resolves.toMatchObject({ sampleRate: 24_000 });
  });

  it("types its failures so callers can fall back rather than guess", async () => {
    const rateLimited = new GeminiTts({
      apiKey: "k",
      voiceId: "Charon",
      fetchImpl: async () => new Response("", { status: 429 }),
    });
    await expect(rateLimited.render("x")).rejects.toMatchObject({ kind: "RATE_LIMITED" });

    const textOnly = new GeminiTts({
      apiKey: "k",
      voiceId: "Charon",
      fetchImpl: async () =>
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "no audio" }] } }] }), {
          status: 200,
        }),
    });
    await expect(textOnly.render("x")).rejects.toMatchObject({ kind: "MALFORMED" });

    const keyless = new GeminiTts({ voiceId: "Charon", fetchImpl: async () => audioResponse(pcmBase64) });
    await expect(keyless.render("x")).rejects.toBeInstanceOf(TtsError);
  });

  it("refuses empty text rather than caching zero bytes as a valid utterance", async () => {
    // ACKNOWLEDGE_BRIEFLY realizes to "". Rendering that would put a
    // zero-length buffer in the cache, and a zero-length buffer plays as the
    // interviewer having said nothing while the gate believes it spoke.
    const tts = new GeminiTts({ apiKey: "k", voiceId: "Charon", fetchImpl: async () => audioResponse(pcmBase64) });
    await expect(tts.render("   ")).rejects.toMatchObject({ kind: "MALFORMED" });
  });
});

describe("sampleRateFromMime", () => {
  it("falls back to the documented rate rather than guessing", () => {
    expect(sampleRateFromMime("audio/L16;codec=pcm;rate=24000")).toBe(24_000);
    expect(sampleRateFromMime("audio/pcm")).toBe(TTS_SAMPLE_RATE);
    expect(sampleRateFromMime("")).toBe(TTS_SAMPLE_RATE);
  });
});

describe("ttsFromEnv", () => {
  it("is null without a key, so voice degrades to the model instead of to silence", () => {
    expect(ttsFromEnv({}, undefined)).toBeNull();
  });

  it("is null when prerendering is switched off", () => {
    expect(ttsFromEnv({ TTS_PRERENDER: "off" }, "key")).toBeNull();
  });

  it("follows REALTIME_VOICE so cached and model audio are the same speaker", () => {
    const renderer = ttsFromEnv({ REALTIME_VOICE: "Kore" }, "key");
    expect(renderer?.voiceId).toBe("Kore");
  });
});

describe("FakeTts", () => {
  it("is deterministic, so cache tests assert on bytes rather than on a network", async () => {
    const fake = new FakeTts();
    const a = await fake.render("same");
    const b = await fake.render("same");
    expect(a.pcm.length).toBe(b.pcm.length);
    expect(a.sampleRate).toBe(TTS_SAMPLE_RATE);
  });
});
