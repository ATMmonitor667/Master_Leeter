/**
 * Measure provider final-transcript delay with speech rather than a sine wave.
 * Uses the same constrained credential and manual activity detection as live sessions.
 * Prints aggregate timing and word accuracy; never prints text, audio, or credentials.
 */
import WebSocket from "ws";
import { loadEnv } from "../src/env.js";
import { GeminiTokenMinter } from "../src/modules/realtime/token.js";
import { GeminiTts, TtsError } from "../src/modules/realtime/tts.js";

loadEnv();

const realtimeKey = process.env.REALTIME_API_KEY ?? process.env.GEMINI_API_KEY;
const ttsKey = process.env.GEMINI_API_KEY ?? realtimeKey;
const model = process.env.REALTIME_MODEL ?? "gemini-2.5-flash-native-audio-latest";
const voice = process.env.REALTIME_VOICE ?? "Charon";
const hangovers = [350, 500] as const;
const frameSamples = 320; // 20 ms at 16 kHz

const samples = [
  { id: "short-statement", text: "I would use a queue to process each item." },
  { id: "long-statement", text: "First I would scan the values, then keep a running count, and finally return the largest count." },
  { id: "question", text: "Can the input contain duplicate values?" },
  { id: "paused-statement", text: "I would sort the values first. Then I would compare adjacent values.", pauseAfter: "I would sort the values first." },
  { id: "trailing-connective", text: "I could use a set, but I need to consider memory." },
  { id: "complexity", text: "The time complexity is O of n log n." },
] as const;

type Sample = (typeof samples)[number];
type Result = {
  id: string;
  hangover: number;
  chunks: number;
  firstFinalMs: number | null;
  lastFinalMs: number | null;
  beforeEnd: boolean;
  exact: boolean;
  wordAccuracy: number;
  error?: string;
};

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
}

function accuracy(expected: string, actual: string): number {
  const a = words(expected);
  const b = words(actual);
  if (a.length === 0) return 0;
  // LCS gives partial credit when the provider splits or drops a phrase.
  let prior = new Array<number>(b.length + 1).fill(0);
  for (const word of a) {
    const next = new Array<number>(b.length + 1).fill(0);
    for (let i = 1; i <= b.length; i++) {
      next[i] = word === b[i - 1] ? (prior[i - 1] ?? 0) + 1
        : Math.max(prior[i] ?? 0, next[i - 1] ?? 0);
    }
    prior = next;
  }
  return (prior[b.length] ?? 0) / a.length;
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

function to16k(pcm: Buffer, fromRate: number): Buffer {
  const inputSamples = pcm.length >> 1;
  const outputSamples = Math.floor(inputSamples * 16_000 / fromRate);
  const out = Buffer.alloc(outputSamples * 2);
  for (let i = 0; i < outputSamples; i++) {
    const position = i * fromRate / 16_000;
    const left = Math.min(inputSamples - 1, Math.floor(position));
    const right = Math.min(inputSamples - 1, left + 1);
    const fraction = position - left;
    const value = Math.round(pcm.readInt16LE(left * 2) * (1 - fraction) + pcm.readInt16LE(right * 2) * fraction);
    out.writeInt16LE(value, i * 2);
  }
  return out;
}

async function renderSample(tts: GeminiTts, sample: Sample): Promise<Buffer> {
  if (!("pauseAfter" in sample)) {
    const rendered = await tts.render(sample.text);
    return to16k(rendered.pcm, rendered.sampleRate);
  }
  const rest = sample.text.slice(sample.pauseAfter.length).trim();
  const first = await tts.render(sample.pauseAfter);
  const second = await tts.render(rest);
  return Buffer.concat([
    to16k(first.pcm, first.sampleRate),
    Buffer.alloc(900 * 16_000 / 1_000 * 2),
    to16k(second.pcm, second.sampleRate),
  ]);
}

async function measure(minter: GeminiTokenMinter, sample: Sample, audio: Buffer, hangover: number): Promise<Result> {
  const credential = await minter.mint();
  return new Promise((resolve) => {
    const socket = new WebSocket(credential.wsUrl);
    const finals: string[] = [];
    let activityEndAt = Number.POSITIVE_INFINITY;
    let firstFinalAt: number | null = null;
    let lastFinalAt: number | null = null;
    let finished = false;
    let streaming = false;
    let nextFrame: ReturnType<typeof setTimeout> | null = null;

    const finish = (error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      if (nextFrame) clearTimeout(nextFrame);
      socket.close();
      const joined = finals.join(" ");
      const last = finals.at(-1) ?? "";
      const bestAccuracy = Math.max(accuracy(sample.text, joined), accuracy(sample.text, last));
      resolve({
        id: sample.id,
        hangover,
        chunks: finals.length,
        firstFinalMs: firstFinalAt === null ? null : Math.round(firstFinalAt - activityEndAt),
        lastFinalMs: lastFinalAt === null ? null : Math.round(lastFinalAt - activityEndAt),
        beforeEnd: firstFinalAt !== null && firstFinalAt < activityEndAt,
        exact: bestAccuracy === 1,
        wordAccuracy: bestAccuracy,
        ...(error ? { error } : {}),
      });
    };
    const deadline = setTimeout(() => finish("timeout"), 25_000);
    socket.on("error", () => finish("socket-error"));
    socket.on("close", () => finish("closed"));
    socket.on("open", () => socket.send(JSON.stringify({ setup: { model: credential.model } })));
    socket.on("message", (raw) => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(raw.toString()) as Record<string, unknown>; }
      catch { return; }
      if ((message["setupComplete"] !== undefined || message["setup_complete"] !== undefined) && !streaming) {
        streaming = true;
        socket.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
        let offset = 0;
        let quietFrames = Math.ceil(hangover / 20);
        const sendFrame = () => {
          if (socket.readyState !== WebSocket.OPEN) return;
          if (offset < audio.length) {
            const frame = audio.subarray(offset, offset + frameSamples * 2);
            offset += frame.length;
            socket.send(JSON.stringify({ realtimeInput: { audio: { data: frame.toString("base64"), mimeType: "audio/pcm;rate=16000" } } }));
          } else if (quietFrames-- > 0) {
            socket.send(JSON.stringify({ realtimeInput: { audio: { data: Buffer.alloc(frameSamples * 2).toString("base64"), mimeType: "audio/pcm;rate=16000" } } }));
          } else {
            activityEndAt = performance.now();
            socket.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
            setTimeout(() => finish(), 5_000);
            return;
          }
          nextFrame = setTimeout(sendFrame, 20);
        };
        sendFrame();
      }
      const content = (message["serverContent"] ?? message["server_content"]) as Record<string, unknown> | undefined;
      const final = (content?.["inputTranscription"] ?? content?.["input_transcription"]) as Record<string, unknown> | undefined;
      if (typeof final?.["text"] === "string" && final["text"].trim()) {
        finals.push(final["text"].trim());
        firstFinalAt ??= performance.now();
        lastFinalAt = performance.now();
      }
    });
  });
}

async function main(): Promise<void> {
  if (!realtimeKey || !ttsKey) throw new Error("REALTIME_API_KEY and GEMINI_API_KEY are required in apps/api/.env.local");
  const minter = new GeminiTokenMinter({ apiKey: realtimeKey, model, voice });
  const tts = new GeminiTts({ apiKey: ttsKey, model: process.env.TTS_MODEL, voiceId: voice });
  const results: Result[] = [];
  for (const sample of samples) {
    const audio = await renderSample(tts, sample);
    for (const hangover of hangovers) {
      const result = await measure(minter, sample, audio, hangover);
      results.push(result);
      console.log(`${result.id.padEnd(22)} H=${hangover} chunks=${result.chunks} first=${result.firstFinalMs ?? "-"}ms last=${result.lastFinalMs ?? "-"}ms exact=${result.exact} accuracy=${result.wordAccuracy.toFixed(2)}${result.error ? ` ${result.error}` : ""}`);
    }
  }
  for (const hangover of hangovers) {
    const group = results.filter((result) => result.hangover === hangover);
    const last = group.flatMap((result) => result.lastFinalMs === null ? [] : [result.lastFinalMs]);
    console.log(`H=${hangover}: chunks/segment=${(group.reduce((sum, result) => sum + result.chunks, 0) / group.length).toFixed(2)} T_f p50/p95=${percentile(last, 0.5) ?? "-"}/${percentile(last, 0.95) ?? "-"}ms finals-before-end=${group.filter((result) => result.beforeEnd).length}/${group.length} exact=${group.filter((result) => result.exact).length}/${group.length}`);
  }
}

main().catch((error: unknown) => {
  // Provider errors may contain URLs or credentials; never print their messages.
  const detail = error instanceof TtsError ? `${error.kind}${error.status ? ` HTTP ${error.status}` : ""}`
    : error instanceof Error ? error.name : "unknown";
  console.error(`voice probe failed (${detail})`);
  process.exitCode = 1;
});
