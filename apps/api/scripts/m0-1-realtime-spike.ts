/**
 * M0-1 — Realtime turn-detection spike
 *
 * Proves the product assumption that turn boundaries can be observed without
 * automatic speech, and that the application can still trigger audio on demand.
 *
 * Usage (from repo root):
 *   pnpm --filter @master-leeter/api spike:realtime
 *
 * Requires in apps/api/.env.local:
 *   REALTIME_API_KEY, REALTIME_MODEL
 *
 * OpenAI also needs REALTIME_VOICE (e.g. alloy).
 * Gemini uses REALTIME_VOICE as a prebuilt voice name (e.g. Puck).
 *
 * Optional:
 *   REALTIME_PROVIDER=openai|gemini   (auto-detected from model name if omitted)
 *   SPIKE_SAMPLES=20                  (latency samples for p50/p95)
 *
 * OpenAI: create_response:false on server_vad.
 * Gemini: automaticActivityDetection.disabled + manual activityStart/activityEnd.
 *
 * If unprompted audio appears before the app triggers a response, STOP — redesign.
 */

import { loadEnv } from "../src/env.js";

loadEnv();

const API_KEY = process.env.REALTIME_API_KEY;
const MODEL = process.env.REALTIME_MODEL ?? "gpt-realtime-2.1";
const VOICE = process.env.REALTIME_VOICE ?? "alloy";
const SAMPLES = Math.max(1, Number(process.env.SPIKE_SAMPLES ?? "20"));
const PROVIDER = resolveProvider(process.env.REALTIME_PROVIDER, MODEL);

if (!API_KEY) {
  console.error("REALTIME_API_KEY is missing. Set it in apps/api/.env.local.");
  process.exit(1);
}

type Json = Record<string, unknown>;
type Provider = "openai" | "gemini";

interface SpikeResult {
  provider: Provider;
  silenceOk: boolean;
  vadOk: boolean;
  manualResponseOk: boolean;
  unpromptedAudioEvents: number;
  speechStarted: number;
  speechStopped: number;
  latenciesMs: number[];
}

function resolveProvider(explicit: string | undefined, model: string): Provider {
  if (explicit === "openai" || explicit === "gemini") return explicit;
  const m = model.toLowerCase();
  if (m.includes("gemini") || m.startsWith("models/gemini")) return "gemini";
  return "openai";
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function pcm16Base64(samples: Int16Array): string {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");
}

function silenceChunk(sampleRate: number, ms: number): string {
  const n = Math.floor((sampleRate * ms) / 1000);
  return pcm16Base64(new Int16Array(n));
}

/** Loud sine bursts — spike-only substitute for real speech energy. */
function speechLikeChunk(sampleRate: number, ms: number, hz = 220): string {
  const n = Math.floor((sampleRate * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, i / 400) * Math.min(1, (n - i) / 400);
    out[i] = Math.floor(Math.sin(2 * Math.PI * hz * t) * 0.55 * env * 32767);
  }
  return pcm16Base64(out);
}

async function readWsData(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  return String(data);
}

async function parseWsMessage(data: unknown): Promise<Json | null> {
  try {
    return JSON.parse(await readWsData(data)) as Json;
  } catch {
    return null;
  }
}

function send(ws: WebSocket, event: Json): void {
  ws.send(JSON.stringify(event));
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
      void parseWsMessage(ev.data).then((msg) => {
        if (!msg) return;
        if (predicate(msg)) {
          cleanup();
          resolve(msg);
        }
      });
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
    };

    ws.addEventListener("message", onMessage);
  });
}

function connectWs(url: string, headers?: Record<string, string>): WebSocket {
  return new (WebSocket as unknown as {
    new (u: string, options?: { headers?: Record<string, string> }): WebSocket;
  })(url, headers ? { headers } : undefined);
}

function emptyResult(provider: Provider): SpikeResult {
  return {
    provider,
    silenceOk: false,
    vadOk: false,
    manualResponseOk: false,
    unpromptedAudioEvents: 0,
    speechStarted: 0,
    speechStopped: 0,
    latenciesMs: [],
  };
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

const OPENAI_SAMPLE_RATE = 24_000;

function openAiSessionUpdate(): Json {
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
          format: { type: "audio/pcm", rate: OPENAI_SAMPLE_RATE },
          turn_detection: {
            type: "server_vad",
            threshold: 0.4,
            prefix_padding_ms: 200,
            silence_duration_ms: 400,
            create_response: false,
            interrupt_response: false,
          },
        },
        output: {
          format: { type: "audio/pcm", rate: OPENAI_SAMPLE_RATE },
          voice: VOICE,
        },
      },
    },
  };
}

function isOpenAiAudioDelta(type: string): boolean {
  return (
    type === "response.output_audio.delta" ||
    type === "response.audio.delta" ||
    type === "response.output_audio_transcript.delta"
  );
}

function attachOpenAiCounters(ws: WebSocket, result: SpikeResult, allowAudio: { value: boolean }): () => void {
  const onMessage = (ev: MessageEvent) => {
    void parseWsMessage(ev.data).then((msg) => {
      if (!msg) return;
      const type = String(msg.type ?? "");
      if (type === "input_audio_buffer.speech_started") result.speechStarted += 1;
      if (type === "input_audio_buffer.speech_stopped") result.speechStopped += 1;
      if (isOpenAiAudioDelta(type) && !allowAudio.value) {
        result.unpromptedAudioEvents += 1;
        console.error(`FAIL: unprompted audio/transcript event: ${type}`);
      }
      if (type === "error") console.error("server error event:", JSON.stringify(msg));
    });
  };
  ws.addEventListener("message", onMessage);
  return () => ws.removeEventListener("message", onMessage);
}

async function runOpenAiSpike(): Promise<SpikeResult> {
  const result = emptyResult("openai");
  const wsUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;

  console.log(`Connecting ${wsUrl}`);
  console.log(`provider=openai model=${MODEL} voice=${VOICE} samples=${SAMPLES}`);

  const ws = connectWs(wsUrl, { Authorization: `Bearer ${API_KEY}` });
  const allowAudio = { value: false };
  const detach = attachOpenAiCounters(ws, result, allowAudio);

  try {
    await onceOpen(ws);
    await waitFor(ws, (m) => m.type === "session.created", 15_000, "session.created");

    send(ws, openAiSessionUpdate());
    const updated = await waitFor(ws, (m) => m.type === "session.updated", 15_000, "session.updated");
    const td = (((updated.session as Json | undefined)?.audio as Json | undefined)?.input as Json | undefined)
      ?.turn_detection as Json | undefined;
    console.log("effective turn_detection:", JSON.stringify(td ?? null));

    if (td?.create_response !== false) {
      console.error("FAIL: session did not keep create_response=false. Effective value:", td?.create_response);
      console.error("STOP — do not build M3/M4 on prompt-enforced silence.");
      process.exitCode = 2;
      return result;
    }

    console.log("\nPhase A — silence (expect no speech events, no audio)");
    for (let i = 0; i < 8; i++) {
      send(ws, { type: "input_audio_buffer.append", audio: silenceChunk(OPENAI_SAMPLE_RATE, 250) });
    }
    await new Promise((r) => setTimeout(r, 1500));
    result.silenceOk = result.speechStarted === 0 && result.unpromptedAudioEvents === 0;
    console.log(result.silenceOk ? "PASS: silence stayed silent" : `FAIL: speechStarted=${result.speechStarted} unprompted=${result.unpromptedAudioEvents}`);

    console.log("\nPhase B — speech-like audio (expect VAD, no auto response)");
    const beforeStarted = result.speechStarted;
    const beforeStopped = result.speechStopped;
    send(ws, { type: "input_audio_buffer.append", audio: speechLikeChunk(OPENAI_SAMPLE_RATE, 900) });
    send(ws, { type: "input_audio_buffer.append", audio: silenceChunk(OPENAI_SAMPLE_RATE, 700) });
    try {
      await waitFor(ws, (m) => String(m.type) === "input_audio_buffer.speech_started", 8_000, "speech_started");
      await waitFor(ws, (m) => String(m.type) === "input_audio_buffer.speech_stopped", 8_000, "speech_stopped");
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
        : `FAIL: VAD/auto-response (started=${result.speechStarted}, stopped=${result.speechStopped}, unprompted=${result.unpromptedAudioEvents})`,
    );

    console.log(`\nPhase C — response.create × ${SAMPLES} (latency to first audio byte)`);
    for (let i = 0; i < SAMPLES; i++) {
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
        await waitFor(ws, (m) => isOpenAiAudioDelta(String(m.type)), 20_000, "first audio delta");
        result.latenciesMs.push(performance.now() - t0);
        process.stdout.write(`  sample ${i + 1}/${SAMPLES}: ${result.latenciesMs.at(-1)!.toFixed(0)} ms\n`);
        result.manualResponseOk = true;
      } catch (err) {
        console.error(`  sample ${i + 1} failed:`, err instanceof Error ? err.message : err);
      } finally {
        allowAudio.value = false;
      }

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
        // Non-fatal.
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    detach();
    ws.close();
  }

  return result;
}

// ── Gemini Live ───────────────────────────────────────────────────────────────

const GEMINI_SAMPLE_RATE = 16_000;

function geminiModelId(): string {
  return MODEL.startsWith("models/") ? MODEL : `models/${MODEL}`;
}

function geminiSetup(): Json {
  return {
    setup: {
      model: geminiModelId(),
      generation_config: {
        response_modalities: ["AUDIO"],
        speech_config: {
          voice_config: {
            prebuilt_voice_config: { voice_name: VOICE },
          },
        },
      },
      system_instruction: {
        parts: [{ text: "You are a silent interview observer. Say only the single word ready when asked to speak." }],
      },
      realtime_input_config: {
        automatic_activity_detection: { disabled: true },
      },
    },
  };
}

function geminiAudioInput(base64: string): Json {
  return {
    realtime_input: {
      audio: {
        mimeType: `audio/pcm;rate=${GEMINI_SAMPLE_RATE}`,
        data: base64,
      },
    },
  };
}

function geminiServerContent(msg: Json): Json | undefined {
  return (msg.serverContent ?? msg.server_content) as Json | undefined;
}

function geminiHasModelAudio(msg: Json): boolean {
  const parts = (geminiServerContent(msg)?.modelTurn as Json | undefined)?.parts as Json[] | undefined;
  if (!parts) {
    const snakeParts = (geminiServerContent(msg)?.model_turn as Json | undefined)?.parts as Json[] | undefined;
    if (!snakeParts) return false;
    return snakeParts.some((p) => {
      const inline = (p.inlineData ?? p.inline_data) as Json | undefined;
      return String(inline?.mimeType ?? inline?.mime_type ?? "").includes("audio");
    });
  }
  return parts.some((p) => {
    const inline = (p.inlineData ?? p.inline_data) as Json | undefined;
    return String(inline?.mimeType ?? inline?.mime_type ?? "").includes("audio");
  });
}

function geminiTurnComplete(msg: Json): boolean {
  const sc = geminiServerContent(msg);
  return sc?.turnComplete === true || sc?.turn_complete === true;
}

function geminiSetupComplete(msg: Json): boolean {
  return msg.setupComplete !== undefined || msg.setup_complete !== undefined;
}

function geminiError(msg: Json): Json | undefined {
  return (msg.error ?? msg.errorMessage ?? msg.error_message) as Json | undefined;
}

function attachGeminiCounters(ws: WebSocket, result: SpikeResult, allowAudio: { value: boolean }): () => void {
  const onMessage = (ev: MessageEvent) => {
    void parseWsMessage(ev.data).then((msg) => {
      if (!msg) return;
      if (geminiHasModelAudio(msg) && !allowAudio.value) {
        result.unpromptedAudioEvents += 1;
        console.error("FAIL: unprompted model audio in serverContent");
      }
      const err = geminiError(msg);
      if (err) console.error("server error event:", JSON.stringify(err));
    });
  };
  ws.addEventListener("message", onMessage);
  return () => ws.removeEventListener("message", onMessage);
}

async function runGeminiSpike(): Promise<SpikeResult> {
  const result = emptyResult("gemini");
  const wsUrl =
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
    `?key=${encodeURIComponent(API_KEY!)}`;

  console.log(`Connecting Gemini Live (${geminiModelId()})`);
  console.log(`provider=gemini model=${MODEL} voice=${VOICE} samples=${SAMPLES}`);

  const ws = connectWs(wsUrl);
  const allowAudio = { value: false };
  const detach = attachGeminiCounters(ws, result, allowAudio);

  try {
    await onceOpen(ws);
    send(ws, geminiSetup());
    const setupMsg = await waitFor(
      ws,
      (m) => geminiSetupComplete(m) || geminiError(m) !== undefined,
      15_000,
      "setupComplete",
    );
    const setupErr = geminiError(setupMsg);
    if (setupErr) {
      console.error("FAIL: Gemini setup rejected:", JSON.stringify(setupErr));
      process.exitCode = 2;
      return result;
    }
    console.log("effective turn_detection:", JSON.stringify({ automaticActivityDetection: { disabled: true } }));

    console.log("\nPhase A — silence (expect no activity, no audio)");
    for (let i = 0; i < 4; i++) {
      send(ws, geminiAudioInput(silenceChunk(GEMINI_SAMPLE_RATE, 250)));
    }
    await new Promise((r) => setTimeout(r, 1500));
    result.silenceOk = result.speechStarted === 0 && result.unpromptedAudioEvents === 0;
    console.log(result.silenceOk ? "PASS: silence stayed silent" : `FAIL: unprompted=${result.unpromptedAudioEvents}`);

    console.log("\nPhase B — manual activityStart/End (expect boundaries, no auto audio)");
    send(ws, { realtime_input: { activity_start: {} } });
    result.speechStarted += 1;
    send(ws, geminiAudioInput(speechLikeChunk(GEMINI_SAMPLE_RATE, 900)));
    send(ws, geminiAudioInput(silenceChunk(GEMINI_SAMPLE_RATE, 700)));
    await new Promise((r) => setTimeout(r, 400));
    send(ws, { realtime_input: { activity_end: {} } });
    result.speechStopped += 1;
    await new Promise((r) => setTimeout(r, 1200));
    result.vadOk = result.speechStarted >= 1 && result.speechStopped >= 1 && result.unpromptedAudioEvents === 0;
    console.log(
      result.vadOk
        ? `PASS: manual VAD boundaries sent (started=${result.speechStarted}, stopped=${result.speechStopped}) with no auto audio`
        : `FAIL: manual VAD/auto-response (started=${result.speechStarted}, stopped=${result.speechStopped}, unprompted=${result.unpromptedAudioEvents})`,
    );

    console.log(`\nPhase C — clientContent turnComplete × ${SAMPLES} (latency to first audio byte)`);
    for (let i = 0; i < SAMPLES; i++) {
      allowAudio.value = true;
      const t0 = performance.now();
      send(ws, {
        client_content: {
          turns: [{ role: "user", parts: [{ text: "Please say the word ready." }] }],
          turn_complete: true,
        },
      });

      try {
        await waitFor(ws, (m) => geminiHasModelAudio(m), 20_000, "first model audio");
        result.latenciesMs.push(performance.now() - t0);
        process.stdout.write(`  sample ${i + 1}/${SAMPLES}: ${result.latenciesMs.at(-1)!.toFixed(0)} ms\n`);
        result.manualResponseOk = true;
      } catch (err) {
        console.error(`  sample ${i + 1} failed:`, err instanceof Error ? err.message : err);
      } finally {
        allowAudio.value = false;
      }

      try {
        await waitFor(ws, (m) => geminiTurnComplete(m), 20_000, "turnComplete");
      } catch {
        // Non-fatal.
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    detach();
    ws.close();
  }

  return result;
}

// ── Summary ───────────────────────────────────────────────────────────────────

function printSummary(result: SpikeResult): void {
  const sorted = [...result.latenciesMs].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);

  console.log("\n════════ M0-1 spike summary ════════");
  console.log(`provider:              ${result.provider}`);
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

const result = await (PROVIDER === "gemini" ? runGeminiSpike() : runOpenAiSpike());
printSummary(result);
