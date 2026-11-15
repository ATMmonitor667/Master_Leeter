import type { LiveCredential } from "@master-leeter/contracts";
import { base64ToPcm16, LIVE_INPUT_MIME } from "../audio";
import type { LiveProvider, LiveProviderEvents } from "./provider";

/**
 * Gemini Live over a WebSocket.
 *
 * The credential is a single-use token with the whole session setup (prompt,
 * voice, turn detection) locked inside it by the server, so the only thing this
 * client says at connect is which model it wants. The provider's own turn
 * detection decides when the interviewer speaks.
 */

type Json = Record<string, unknown>;
const pick = (object: Json | undefined, ...names: string[]): unknown => {
  for (const name of names) if (object && object[name] !== undefined) return object[name];
  return undefined;
};

/** "12.5s" or {seconds, nanos} to milliseconds. */
function durationMs(value: unknown): number {
  if (typeof value === "string") return Math.round(parseFloat(value) * 1000) || 0;
  if (value && typeof value === "object") {
    const d = value as { seconds?: number | string; nanos?: number };
    return Math.round(Number(d.seconds ?? 0) * 1000 + (d.nanos ?? 0) / 1e6);
  }
  return 0;
}

export class GeminiLive implements LiveProvider {
  private socket: WebSocket | null = null;
  private closing = false;

  constructor(private readonly events: LiveProviderEvents) {}

  connect(credential: LiveCredential): Promise<void> {
    this.closing = false;
    return new Promise((resolve, reject) => {
      let ready = false;
      const socket = new WebSocket(credential.wsUrl);
      this.socket = socket;
      const timer = setTimeout(() => { if (!ready) { reject(new Error("LIVE_CONNECT_TIMEOUT")); socket.close(); } }, 12_000);

      socket.onopen = () => socket.send(JSON.stringify({ setup: { model: credential.model } }));
      socket.onerror = () => { /* onclose follows with the code */ };
      socket.onclose = (event) => {
        clearTimeout(timer);
        if (this.socket === socket) this.socket = null;
        if (!ready) reject(new Error(event.reason || `LIVE_CLOSED_${event.code}`));
        this.events.closed({ code: event.code, reason: event.reason, expected: this.closing });
      };
      socket.onmessage = (event) => {
        void this.decode(event.data).then((message) => {
          if (!message) return;
          if (pick(message, "setupComplete", "setup_complete") !== undefined && !ready) {
            ready = true;
            clearTimeout(timer);
            resolve();
          }
          this.handle(message);
        });
      };
    });
  }

  private async decode(data: unknown): Promise<Json | null> {
    try {
      const text = typeof data === "string" ? data : data instanceof Blob ? await data.text() : new TextDecoder().decode(data as ArrayBuffer);
      return JSON.parse(text) as Json;
    } catch { return null; }
  }

  private handle(message: Json): void {
    const resumption = pick(message, "sessionResumptionUpdate", "session_resumption_update") as Json | undefined;
    const handle = pick(resumption, "newHandle", "new_handle");
    if (typeof handle === "string" && handle) this.events.resumption(handle);

    const goAway = pick(message, "goAway", "go_away") as Json | undefined;
    if (goAway) this.events.goAway(durationMs(pick(goAway, "timeLeft", "time_left")));

    const activity = pick(message, "voiceActivity", "voice_activity") as Json | undefined;
    if (activity) this.events.speech(pick(activity, "type") === "ACTIVITY_START");

    const content = pick(message, "serverContent", "server_content") as Json | undefined;
    if (!content) return;
    if (content["interrupted"] === true) this.events.interrupted();

    const turn = pick(content, "modelTurn", "model_turn") as Json | undefined;
    for (const part of (turn?.["parts"] as Json[] | undefined) ?? []) {
      const inline = pick(part, "inlineData", "inline_data") as Json | undefined;
      const data = inline?.["data"];
      if (typeof data === "string" && String(pick(inline, "mimeType", "mime_type") ?? "").startsWith("audio/")) {
        this.events.audio(base64ToPcm16(data));
      }
    }
    const heard = pick(content, "inputTranscription", "input_transcription") as Json | undefined;
    if (typeof heard?.["text"] === "string" && heard["text"]) this.events.userText(heard["text"]);
    const said = pick(content, "outputTranscription", "output_transcription") as Json | undefined;
    if (typeof said?.["text"] === "string" && said["text"]) this.events.modelText(said["text"]);

    if (pick(content, "turnComplete", "turn_complete") === true) this.events.turnEnd();
  }

  private send(message: Json): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  sendAudio(base64Pcm16: string): void {
    this.send({ realtimeInput: { audio: { data: base64Pcm16, mimeType: LIVE_INPUT_MIME } } });
  }

  pauseAudio(): void {
    this.send({ realtimeInput: { audioStreamEnd: true } });
  }

  sendText(text: string, opts: { respond: boolean }): void {
    // Measured on gemini-3.8-live: realtime text gets a spoken reply; client
    // content with turnComplete false is taken in silently.
    if (opts.respond) this.send({ realtimeInput: { text } });
    else this.send({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: false } });
  }

  close(): void {
    this.closing = true;
    this.socket?.close(1000);
    this.socket = null;
  }
}
