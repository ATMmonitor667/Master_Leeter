/**
 * live-transcription-probe — latency from last audio byte to TRANSCRIPT_FINAL (V0)
 *
 * The latency study marks "time to final transcript" as *unmeasured* and
 * estimates a range of 250 ms–1200 ms. This script measures it directly so
 * the estimate can be replaced with a number.
 *
 * Usage (from repo root):
 *   pnpm --filter @master-leeter/api spike:transcription
 *
 * Required in apps/api/.env.local:
 *   REALTIME_API_KEY
 *   REALTIME_MODEL (e.g. gemini-live-2.5-flash-preview)
 *
 * Optional:
 *   PROBE_SAMPLES=10   number of utterances to stream (default: 10)
 *   PROBE_AUDIO_MS=3000  duration of each synthetic audio segment (default: 3000)
 *
 * Output: per-sample table + p50/p95 summary.
 *
 * ── What is being measured ─────────────────────────────────────────────────
 *
 * `lastAudioByteMs` — wall-clock time when we send activityEnd.
 * `firstFinalMs`    — wall-clock time when the first `inputTranscription`
 *                     message arrives with content (Gemini's proxy for a
 *                     final transcript event).
 *
 * The gap is bounded by:
 *   • provider VAD re-confirmation of the end we already declared
 *   • STT final pass over the full turn audio
 *   • network round-trip
 *
 * It is NOT affected by inference or tool calls — those have their own budget.
 * The measurement isolates the part the latency study could not attribute.
 */

import WebSocket from "ws";
import { loadEnv } from "../src/env.js";

loadEnv();

const API_KEY = process.env.REALTIME_API_KEY;
const MODEL = process.env.REALTIME_MODEL ?? "gemini-live-2.5-flash-preview";
const SAMPLES = Number(process.env.PROBE_SAMPLES ?? "10");
const AUDIO_DURATION_MS = Number(process.env.PROBE_AUDIO_MS ?? "3000");

if (!API_KEY) {
  console.error("REALTIME_API_KEY is required");
  process.exit(1);
}

const WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

/** Sine-wave at 440 Hz — recognisable as "a sound" so STT has something to work with. */
function toneFrames(durationMs: number, sampleRate = 16_000, hz = 440): Buffer {
  const samples = Math.floor((durationMs / 1_000) * sampleRate);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * hz * i) / sampleRate));
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2);
  }
  return buf;
}

function b64(buf: Buffer): string {
  return buf.toString("base64");
}

interface ProbeResult {
  sample: number;
  transcriptLatencyMs: number | null;
  transcriptText: string;
  timedOut: boolean;
}

async function runOneSample(sampleIndex: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    let lastByteMs = 0;
    let firstFinalMs: number | null = null;
    let transcriptText = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      resolve({
        sample: sampleIndex,
        transcriptLatencyMs: null,
        transcriptText: "",
        timedOut: true,
      });
    }, 15_000);

    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      resolve(result);
    };

    ws.on("error", (err) => {
      settle({
        sample: sampleIndex,
        transcriptLatencyMs: null,
        transcriptText: `ERROR: ${err.message}`,
        timedOut: false,
      });
    });

    ws.on("open", () => {
      // Setup: disable automatic activity detection, request input transcription.
      ws.send(
        JSON.stringify({
          setup: {
            model: `models/${MODEL}`,
            realtimeInputConfig: {
              automaticActivityDetection: { disabled: true },
            },
            inputAudioTranscription: {},
            systemInstruction: {
              parts: [{ text: "You are a transcription probe. Do not produce any output." }],
            },
          },
        }),
      );
    });

    ws.on("message", (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      } catch {
        return;
      }

      // Wait for SETUP_COMPLETE before streaming audio.
      if (msg["setupComplete"] !== undefined) {
        streamAudio();
        return;
      }

      // Gemini Live delivers input transcription in serverContent.
      const serverContent = msg["serverContent"] as Record<string, unknown> | undefined;
      if (!serverContent) return;

      const transcription = serverContent["inputTranscription"] as
        | { text?: string }
        | undefined;

      if (transcription?.text && firstFinalMs === null) {
        firstFinalMs = Date.now();
        transcriptText = transcription.text;
        settle({
          sample: sampleIndex,
          transcriptLatencyMs: firstFinalMs - lastByteMs,
          transcriptText,
          timedOut: false,
        });
      }
    });

    function streamAudio() {
      // Signal that the candidate started speaking.
      ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));

      const audio = toneFrames(AUDIO_DURATION_MS);
      const CHUNK_MS = 100;
      const CHUNK_BYTES = Math.floor((CHUNK_MS / 1_000) * 16_000 * 2);
      let offset = 0;

      const sendNextChunk = () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (offset >= audio.length) {
          // All audio sent — signal end of speech.
          lastByteMs = Date.now();
          ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
          return;
        }
        const chunk = audio.subarray(offset, Math.min(offset + CHUNK_BYTES, audio.length));
        offset += CHUNK_BYTES;
        ws.send(
          JSON.stringify({
            realtimeInput: {
              audio: { data: b64(Buffer.from(chunk)), mimeType: "audio/pcm;rate=16000" },
            },
          }),
        );
        setTimeout(sendNextChunk, CHUNK_MS);
      };

      sendNextChunk();
    }
  });
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, rank - 1)] ?? 0;
}

async function main() {
  console.log(`\nlive-transcription-probe V0`);
  console.log(`model: ${MODEL}  samples: ${SAMPLES}  audio: ${AUDIO_DURATION_MS}ms\n`);

  const results: ProbeResult[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    process.stdout.write(`  sample ${String(i + 1).padStart(2)}/${SAMPLES} … `);
    const result = await runOneSample(i + 1);
    results.push(result);
    if (result.timedOut) {
      process.stdout.write("TIMED_OUT\n");
    } else if (result.transcriptLatencyMs === null) {
      process.stdout.write(`FAILED: ${result.transcriptText}\n`);
    } else {
      process.stdout.write(`${result.transcriptLatencyMs} ms  "${result.transcriptText.slice(0, 40)}"\n`);
    }
    // Brief pause between samples to avoid rate-limiting.
    if (i < SAMPLES - 1) await new Promise((r) => setTimeout(r, 500));
  }

  const good = results
    .map((r) => r.transcriptLatencyMs)
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b);

  const timedOut = results.filter((r) => r.timedOut).length;
  const failed = results.filter((r) => !r.timedOut && r.transcriptLatencyMs === null).length;

  console.log(`\n── summary ──────────────────────────────────────────────`);
  console.log(`  measured:   ${good.length}/${SAMPLES}`);
  console.log(`  timed out:  ${timedOut}`);
  console.log(`  failed:     ${failed}`);

  if (good.length > 0) {
    console.log(`  min:        ${good[0]} ms`);
    console.log(`  p50:        ${percentile(good, 0.5)} ms`);
    console.log(`  p95:        ${percentile(good, 0.95)} ms`);
    console.log(`  max:        ${good[good.length - 1]} ms`);
  }
  console.log();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
