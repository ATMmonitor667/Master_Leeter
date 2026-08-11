/**
 * M0-1 — Realtime turn-detection spike
 *
 * Proves the product assumption that VAD can emit speech-start / speech-stop
 * with automatic response creation disabled, and that the app can still
 * trigger a response on demand.
 *
 * Usage (from repo root):
 *   pnpm --filter @master-leeter/api spike:realtime
 *
 * Requires in apps/api/.env.local:
 *   REALTIME_API_KEY, REALTIME_MODEL, REALTIME_VOICE
 *
 * Optional:
 *   SPIKE_SAMPLES=20   (default 20; latency samples for p50/p95)
 *
 * If create_response:false still produces unprompted audio, STOP — redesign.
 */

import { loadEnv } from "../src/env.js";

loadEnv();

const API_KEY = process.env.REALTIME_API_KEY;
const MODEL = process.env.REALTIME_MODEL ?? "gpt-realtime-2.1";
const VOICE = process.env.REALTIME_VOICE ?? "alloy";
const SAMPLES = Math.max(1, Number(process.env.SPIKE_SAMPLES ?? "20"));

if (!API_KEY) {
  console.error("REALTIME_API_KEY is missing. Set it in apps/api/.env.local.");
  process.exit(1);
}

const SAMPLE_RATE = 24_000;
const WS_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;

type Json = Record<string, unknown>;

interface SpikeResult {
  silenceOk: boolean;
  vadOk: boolean;
  manualResponseOk: boolean;
  unpromptedAudioEvents: number;
  speechStarted: number;
  speechStopped: number;
  latenciesMs: number[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function pcm16Base64(samples: Int16Array): string {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");
}

/** Quiet buffer — should not trip VAD. */
function silenceChunk(ms: number): string {
  const n = Math.floor((SAMPLE_RATE * ms) / 1000);
  return pcm16Base64(new Int16Array(n));
}

/**
 * Loud sine bursts look enough like speech energy for server_vad.
 * Not a substitute for real speech in product testing — only for the spike.
 */
function speechLikeChunk(ms: number, hz = 220): string {
  const n = Math.floor((SAMPLE_RATE * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    // Amplitude envelope so VAD sees start/stop edges cleanly.
    const env = Math.min(1, i / 400) * Math.min(1, (n - i) / 400);
    out[i] = Math.floor(Math.sin(2 * Math.PI * hz * t) * 0.55 * env * 32767);
  }
  return pcm16Base64(out);
}

function send(ws: WebSocket, event: Json): void {
  ws.send(JSON.stringify(event));
}

function sessionUpdateEvent(): Json {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      model: MODEL,
      output_modalities: ["audio"],
      instructions:
        "You are a silent interview observer. Say only the single word 'ready' when asked to speak.",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: SAMPLE_RATE },
          turn_detection: {
            type: "server_vad",
            threshold: 0.4,
            prefix_padding_ms: 200,
            silence_duration_ms: 400,
            // The whole product hangs on these two flags.
            create_response: false,
            interrupt_response: false,
          },
        },
        output: {
          format: { type: "audio/pcm", rate: SAMPLE_RATE },
          voice: VOICE,
        },
      },
    },
  };
}

function isAudioDelta(type: string): boolean {
  return (
    type === "response.output_audio.delta" ||
    type === "response.audio.delta" ||
    type === "response.output_audio_transcript.delta"
  );
}

function isSpeechStarted(type: string): boolean {
  return type === "input_audio_buffer.speech_started";
}

function isSpeechStopped(type: string): boolean {
  return (
    type === "input_audio_buffer.speech_stopped" ||
    type === "input_audio_buffer.committed"
  );
}

async function onceOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", (ev) => reject(ev), { once: true });
  });
}

async function waitFor(
  ws: WebSocket,
  predicate: (msg: Json) => boolean,
  timeoutMs: number,
  label: string,
): Promise<Json> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${label} (${timeoutMs}ms)`));
    }, timeoutMs);

    const onMessage = (ev: MessageEvent) => {
      let msg: Json;
      try {
        msg = JSON.parse(String(ev.data)) as Json;
      } catch {
        return;
      }
      if (predicate(msg)) {
        cleanup();
        resolve(msg);
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
    };

    ws.addEventListener("message", onMessage);
  });
}

function attachCounters(ws: WebSocket, result: SpikeResult, allowAudio: { value: boolean }): () => void {
  const onMessage = (ev: MessageEvent) => {
    let msg: Json;
    try {
      msg = JSON.parse(String(ev.data)) as Json;
    } catch {
      return;
    }
    const type = String(msg.type ?? "");
    if (isSpeechStarted(type)) result.speechStarted += 1;
    if (type === "input_audio_buffer.speech_stopped") result.speechStopped += 1;
    if (isAudioDelta(type) && !allowAudio.value) {
      result.unpromptedAudioEvents += 1;
      console.error(`FAIL: unprompted audio/transcript event: ${type}`);
    }
    if (type === "error") {
      console.error("server error event:", JSON.stringify(msg));
    }
  };
  ws.addEventListener("message", onMessage);
  return () => ws.removeEventListener("message", onMessage);
}

async function runSpike(): Promise<SpikeResult> {
  const result: SpikeResult = {
    silenceOk: false,
    vadOk: false,
    manualResponseOk: false,
    unpromptedAudioEvents: 0,
    speechStarted: 0,
    speechStopped: 0,
    latenciesMs: [],
  };

  console.log(`Connecting ${WS_URL}`);
  console.log(`model=${MODEL} voice=${VOICE} samples=${SAMPLES}`);

  // Node undici WebSocket: second arg may include `headers` (not in DOM typings).
  const ws = new (WebSocket as unknown as {
    new (
      url: string,
      options?: { headers?: Record<string, string> },
    ): WebSocket;
  })(WS_URL, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      // GA realtime — no OpenAI-Beta header.
    },
  });

  const allowAudio = { value: false };
  const detach = attachCounters(ws, result, allowAudio);

  try {
    await onceOpen(ws);
    await waitFor(ws, (m) => m.type === "session.created", 15_000, "session.created");

    send(ws, sessionUpdateEvent());
    const updated = await waitFor(ws, (m) => m.type === "session.updated", 15_000, "session.updated");
    const td = (((updated.session as Json | undefined)?.audio as Json | undefined)?.input as Json | undefined)
      ?.turn_detection as Json | undefined;
    console.log("effective turn_detection:", JSON.stringify(td ?? null));

    if (td?.create_response !== false) {
      console.error(
        "FAIL: session did not keep create_response=false. Effective value:",
        td?.create_response,
      );
      console.error("STOP — do not build M3/M4 on prompt-enforced silence.");
      process.exitCode = 2;
      return result;
    }

    // ── Phase A: silence must not produce audio ────────────────────────────
    console.log("\nPhase A — silence (expect no speech events, no audio)");
    for (let i = 0; i < 8; i++) {
      send(ws, { type: "input_audio_buffer.append", audio: silenceChunk(250) });
    }
    await new Promise((r) => setTimeout(r, 1500));
    result.silenceOk = result.speechStarted === 0 && result.unpromptedAudioEvents === 0;
    console.log(
      result.silenceOk
        ? "PASS: silence stayed silent"
        : `FAIL: silence saw speechStarted=${result.speechStarted} unpromptedAudio=${result.unpromptedAudioEvents}`,
    );

    // ── Phase B: VAD events with create_response:false ─────────────────────
    console.log("\nPhase B — speech-like audio (expect VAD, no auto response)");
    const beforeStarted = result.speechStarted;
    const beforeStopped = result.speechStopped;
    send(ws, { type: "input_audio_buffer.append", audio: speechLikeChunk(900) });
    send(ws, { type: "input_audio_buffer.append", audio: silenceChunk(700) });
    try {
      await waitFor(ws, (m) => isSpeechStarted(String(m.type)), 8_000, "speech_started");
      await waitFor(
        ws,
        (m) => String(m.type) === "input_audio_buffer.speech_stopped",
        8_000,
        "speech_stopped",
      );
    } catch (err) {
      console.error("VAD wait failed:", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, 800));
    result.vadOk =
      result.speechStarted > beforeStarted &&
      result.speechStopped > beforeStopped &&
      result.unpromptedAudioEvents === 0;
    console.log(
      result.vadOk
        ? `PASS: VAD fired (started=${result.speechStarted}, stopped=${result.speechStopped}) with no auto audio`
        : `FAIL: VAD/auto-response check (started=${result.speechStarted}, stopped=${result.speechStopped}, unprompted=${result.unpromptedAudioEvents})`,
    );

    // ── Phase C: app-triggered response + latency samples ──────────────────
    console.log(`\nPhase C — manual response.create × ${SAMPLES} (latency to first audio byte)`);
    for (let i = 0; i < SAMPLES; i++) {
      // Fresh user turn so the model has something to answer.
      send(ws, {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Please say the word ready." }],
        },
      });

      allowAudio.value = true;
      const t0 = performance.now();
      send(ws, {
        type: "response.create",
        response: {
          output_modalities: ["audio"],
          instructions: "Say only the word ready.",
        },
      });

      try {
        await waitFor(ws, (m) => isAudioDelta(String(m.type)), 20_000, "first audio delta");
        const ms = performance.now() - t0;
        result.latenciesMs.push(ms);
        process.stdout.write(`  sample ${i + 1}/${SAMPLES}: ${ms.toFixed(0)} ms\n`);
        result.manualResponseOk = true;
      } catch (err) {
        console.error(`  sample ${i + 1} failed:`, err instanceof Error ? err.message : err);
      } finally {
        allowAudio.value = false;
      }

      // Drain until response completes so samples don't overlap.
      try {
        await waitFor(
          ws,
          (m) =>
            m.type === "response.done" ||
            m.type === "response.completed" ||
            m.type === "response.output_item.done",
          20_000,
          "response done",
        );
      } catch {
        // Non-fatal; next sample still useful.
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    detach();
    ws.close();
  }

  return result;
}

function printSummary(result: SpikeResult): void {
  const sorted = [...result.latenciesMs].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);

  console.log("\n════════ M0-1 spike summary ════════");
  console.log(`model:                 ${MODEL}`);
  console.log(`voice:                 ${VOICE}`);
  console.log(`silence_ok:            ${result.silenceOk}`);
  console.log(`vad_no_auto_response:  ${result.vadOk}`);
  console.log(`manual_response_ok:    ${result.manualResponseOk}`);
  console.log(`unprompted_audio:      ${result.unpromptedAudioEvents}`);
  console.log(`speech_started:        ${result.speechStarted}`);
  console.log(`speech_stopped:        ${result.speechStopped}`);
  console.log(`latency_samples:       ${sorted.length}`);
  if (sorted.length > 0) {
    console.log(`latency_p50_ms:        ${p50.toFixed(1)}`);
    console.log(`latency_p95_ms:        ${p95.toFixed(1)}`);
    console.log(`latency_min_ms:        ${sorted[0]!.toFixed(1)}`);
    console.log(`latency_max_ms:        ${sorted[sorted.length - 1]!.toFixed(1)}`);
  }
  console.log("════════════════════════════════════");

  const pass =
    result.silenceOk &&
    result.vadOk &&
    result.manualResponseOk &&
    result.unpromptedAudioEvents === 0 &&
    sorted.length >= Math.min(SAMPLES, 20);

  if (!pass) {
    console.error("\nSPIKE FAILED. Paste this output into the chat and stop M3/M4 work.");
    process.exitCode = 1;
    return;
  }

  console.log("\nSPIKE PASSED. Paste this summary into the chat for ADR-001.");
}

const result = await runSpike();
printSummary(result);
