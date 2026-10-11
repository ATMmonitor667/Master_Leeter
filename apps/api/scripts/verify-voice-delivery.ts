/** Live Gemini smoke check: constrained tools -> runtime wording -> complete spoken task.
 * Uses an isolated in-memory interview. No user session or audio recording is saved.
 */
import WebSocket from "ws";
import { join } from "node:path";
import { loadEnv } from "../src/env.js";
import { minterFromEnv } from "../src/modules/realtime/token.js";
import { executeVoiceTool } from "../src/modules/realtime/tools.js";
import { loadScenarioFile } from "../src/modules/scenario/loader.js";
import { InterviewRuntime } from "../src/modules/orchestrator/runtime.js";
import { POLICIES } from "../src/modules/orchestrator/policy.js";
import { InMemoryEventLog } from "../src/modules/session/event-log.js";

loadEnv();
const scenario = (await loadScenarioFile(join(import.meta.dirname, "../../../content/scenarios/parts-bin/v1.yaml"))).version;
const events = new InMemoryEventLog();
const sessionId = "00000000-0000-4000-8000-000000000001";
const runtime = new InterviewRuntime({ sessionId, scenario, policy: POLICIES.MOCK,
  scenarioVersionId: scenario.id, traceId: "voice-delivery-check", events, remainingSeconds: () => 1800 });

async function ingest(type: "SESSION_STARTED" | "SPEECH_FINAL", transcript?: string) {
  const { event } = await events.append({ sessionId, type, actor: type === "SESSION_STARTED" ? "SYSTEM" : "CANDIDATE",
    scenarioVersionId: scenario.id, traceId: "voice-delivery-check", idempotencyKey: `check:${type}`,
    payload: transcript ? { transcript, finalized: true } : {} });
  return runtime.ingest(event);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

let socket: WebSocket | undefined;
try {
  await ingest("SESSION_STARTED");
  const minter = minterFromEnv();
  if (!minter) throw new Error("VOICE_NOT_CONFIGURED");
  const credential = await minter.mint();
  socket = new WebSocket(credential.wsUrl);
  const ws = socket;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("VOICE_SETUP_TIMEOUT")), 20_000);
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString());
      if (message.setupComplete !== undefined) finish();
      if (message.error) finish(new Error("VOICE_SETUP_REJECTED"));
    };
    const onError = () => finish(new Error("VOICE_CONNECTION_FAILED"));
    const onClose = () => finish(new Error("VOICE_CONNECTION_CLOSED"));
    function finish(error?: Error) {
      clearTimeout(timer);
      ws.off("message", onMessage); ws.off("error", onError); ws.off("close", onClose);
      if (error) reject(error); else resolve();
    }
    ws.on("message", onMessage); ws.on("error", onError); ws.on("close", onClose);
    ws.once("open", () => ws.send(JSON.stringify({ setup: { model: credential.model } })));
  });

  async function checkDelivery(label: string) {
    const initial = runtime.voiceContext();
    const expected = initial.authorizedBrief;
    if (!expected || initial.authorized?.action !== "DELIVER_BRIEF") throw new Error("BRIEF_NOT_AUTHORIZED");
    const started = Date.now();
    let audioBytes = 0;
    let firstAudioMs: number | undefined;
    let transcript = "";
    const tools: string[] = [];
    const received: Record<string, number> = {};
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("VOICE_DELIVERY_TIMEOUT")), 45_000);
      let tail = Promise.resolve();
      let finished = false;
      function finish(error?: Error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        ws.off("message", onMessage); ws.off("error", onError); ws.off("close", onClose);
        if (error) console.log(JSON.stringify({ check: label, received, tools, audioBytes, transcriptCharacters: transcript.length }));
        if (error) reject(error); else resolve();
      }
      const onError = () => finish(new Error("VOICE_CONNECTION_FAILED"));
      const onClose = () => finish(new Error("VOICE_CONNECTION_CLOSED"));
      const onMessage = (data: WebSocket.RawData) => {
        tail = tail.then(async () => {
          if (finished) return;
          const message = JSON.parse(data.toString());
          for (const key of Object.keys(message)) received[key] = (received[key] ?? 0) + 1;
          if (message.error) throw new Error("VOICE_PROVIDER_ERROR");
          if (message.toolCall) {
            const responses = [];
            for (const call of message.toolCall.functionCalls) {
              tools.push(call.name);
              const voice = runtime.voiceContext();
              const response = await executeVoiceTool({ name: call.name, args: call.args ?? {} }, {
                scenario, ...voice, remainingSeconds: 1800,
              }, { recordDelivery: async () => {} });
              if (!response.ok) throw new Error("VOICE_TOOL_REFUSED");
              responses.push({ id: call.id, name: call.name, response });
            }
            ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
          }
          const content = message.serverContent;
          for (const part of content?.modelTurn?.parts ?? []) {
            if (part.inlineData?.mimeType?.startsWith("audio/pcm")) {
              firstAudioMs ??= Date.now() - started;
              audioBytes += Buffer.from(part.inlineData.data, "base64").length;
            }
          }
          if (content?.outputTranscription?.text) transcript += content.outputTranscription.text;
          if (content?.turnComplete && audioBytes > 0) finish();
          if (content?.turnComplete && audioBytes === 0) received["emptyTurnComplete"] = (received["emptyTurnComplete"] ?? 0) + 1;
        }).catch((error: Error) => finish(error));
      };
      ws.on("message", onMessage); ws.on("error", onError); ws.on("close", onClose);
      ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text:
        `[${initial.utteranceId}] DELIVER_BRIEF: Call get_interview_context and read the entire openingScript verbatim. Read every sentence, including the coding task. Do not shorten it or add an introduction.`,
      }] }], turnComplete: true } }));
    });
    const spoken = normalize(transcript);
    const expectedWords = normalize(expected).split(" ");
    const heard = new Set(spoken.split(" "));
    const coverage = expectedWords.filter((word) => heard.has(word)).length / expectedWords.length;
    const passed = tools.includes("get_interview_context") && audioBytes > 0 && coverage >= 0.9
      && spoken.includes("part numbers") && !/two coding problems/.test(spoken);
    console.log(JSON.stringify({ check: label, passed, tools, wordCoverage: Number(coverage.toFixed(3)),
      audioSeconds: Number((audioBytes / 48_000).toFixed(2)), firstAudioMs }));
    if (!passed) throw new Error("VOICE_DELIVERY_FIDELITY_FAILED");
    await runtime.markSpeechFinished();
  }

  await checkDelivery("full opening after stage advancement");
  await ingest("SPEECH_FINAL", "So wha t is the problem that we'll be solving today?");
  await checkDelivery("problem request returns reviewed repeat");
} catch (error) {
  // Never print connection URLs, raw provider errors, credentials or audio.
  console.error(JSON.stringify({ passed: false, failure:
    error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "VOICE_CHECK_FAILED" }));
  process.exitCode = 1;
} finally {
  socket?.close();
  runtime.dispose();
}
