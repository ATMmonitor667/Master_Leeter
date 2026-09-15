import { PlaybackScheduler, type AudioSink, type ScheduledSource } from "./playback";
import { apiFetch } from "./auth";
import {
  RealtimeVoice,
  type SpeechAuthorization,
  type SpeechBoundary,
  type VoiceCredential,
} from "./realtime-voice";

/**
 * Browser shell for the voice path (M3-2).
 *
 * Everything here is I/O: microphone permission, an audio graph, a socket, and
 * speaker output. There is no policy, no timing arithmetic, and no format
 * conversion — those live in `vad.ts`, `audio.ts`, `playback.ts`, and
 * `realtime-voice.ts`, all of which are tested without a browser.
 *
 * That split is deliberate and it is where the line was drawn: this file is the
 * part that cannot be verified in CI, so it was kept as close to nothing as the
 * job allows. If a bug in voice is ever traced to logic *in this file*, the
 * logic was in the wrong place.
 *
 * ── Capture path ───────────────────────────────────────────────────────────
 *
 * An `AudioWorklet` loaded from a blob URL, rather than the deprecated
 * `ScriptProcessorNode` or a static asset that would need to survive the build.
 * The worklet accumulates the 128-sample render quantum into ~20 ms frames
 * before posting: at 48 kHz the raw quantum would be 375 messages per second
 * across the thread boundary, and the VAD wants frames of that size anyway.
 */

/** ~20ms at 48kHz. Matches the VAD's expected frame size. */
const CAPTURE_FRAME_SAMPLES = 960;

const CAPTURE_WORKLET = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(${CAPTURE_FRAME_SAMPLES});
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i];
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("capture", CaptureProcessor);
`;

/** Web Audio behind the scheduler's structural interface. */
export class WebAudioSink implements AudioSink {
  constructor(
    private readonly context: AudioContext,
    private readonly onEnded: (source: ScheduledSource) => void,
  ) {}

  get currentTime(): number {
    return this.context.currentTime;
  }

  play(samples: Float32Array, sampleRate: number, atTime: number): ScheduledSource {
    // The model's rate rarely matches the context's, and an AudioBuffer created
    // at the source rate is resampled by the browser on playback — better than
    // anything we would write here.
    const buffer = this.context.createBuffer(1, samples.length, sampleRate);
    // `set` rather than `copyToChannel`: the latter's signature pins the backing
    // buffer type, and our samples come from a slice whose provenance TS tracks.
    buffer.getChannelData(0).set(samples);

    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.context.destination);

    const handle: ScheduledSource = { stop: () => node.stop() };
    node.onended = () => this.onEnded(handle);
    node.start(atTime);

    return handle;
  }
}

export type VoiceStatus = "IDLE" | "CONNECTING" | "LISTENING" | "SPEAKING" | "FAILED";

export interface VoiceSessionOptions {
  sessionId: string;
  apiBase: string;
  /** Append these to the session log — they are M4-2's timing input. */
  onSpeechBoundary?: (boundary: SpeechBoundary) => void;
  onTranscript?: (transcript: { text: string; final: boolean }) => void;
  onStatus?: (status: VoiceStatus) => void;
  onError?: (err: Error) => void;
  /** Optional device from enumerateDevices. Omitted means the system default. */
  deviceId?: string;
}

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  // Labels are empty until permission has been granted once — the caller should
  // enumerate again after start() for a list worth showing.
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput");
}

export class VoiceSession {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private voice: RealtimeVoice | null = null;
  private playback: PlaybackScheduler | null = null;
  private status: VoiceStatus = "IDLE";
  private stopping = false;
  private replacingVoice = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private captureRate = 0;
  private mutedState = false;
  private providerTurnComplete = false;
  private pendingSpeech: SpeechAuthorization | null = null;

  constructor(private readonly opts: VoiceSessionOptions) {}

  get currentStatus(): VoiceStatus {
    return this.status;
  }

  get muted(): boolean {
    return this.mutedState;
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.setStatus("CONNECTING");

    try {
      // Permission first, because the sample rate of the graph should match the
      // device rather than forcing a resample on an already-resampled signal.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(this.opts.deviceId ? { deviceId: { exact: this.opts.deviceId } } : {}),
          channelCount: 1,
          // The browser's own processing is better than ours and it runs before
          // our VAD sees anything, which is the correct order.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      for (const track of this.stream.getAudioTracks()) {
        track.onended = () => {
          if (!this.stopping) this.fail(new Error("Microphone disconnected. Choose a microphone and reconnect."));
        };
      }

      this.context = new AudioContext();
      this.captureRate = this.context.sampleRate;

      this.playback = new PlaybackScheduler({
        sink: new WebAudioSink(this.context, (source) => {
          this.playback?.release(source);
          this.completeSpeechIfDrained();
        }),
      });

      await this.connectProvider();
      await this.startCapture(this.context, this.stream);
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  private async connectProvider(): Promise<void> {
    const credential = await this.mintCredential();
    if (this.stopping) return;

    this.replacingVoice = true;
    this.voice?.disconnect();
    this.replacingVoice = false;

    const voice = new RealtimeVoice({
        credential,
        captureRate: this.captureRate,
        connect: (handlers) => {
          const socket = new WebSocket(credential.wsUrl);
          socket.onopen = () => handlers.onOpen();
          socket.onclose = () => handlers.onClose();
          socket.onerror = () => handlers.onError(new Error("voice socket error"));
          socket.onmessage = (event) => {
            void toText(event.data).then(handlers.onMessage);
          };

          return {
            send: (data) => socket.send(data),
            close: () => socket.close(),
            get connected() {
              return socket.readyState === WebSocket.OPEN;
            },
          };
        },
        onSpeechBoundary: (boundary) => this.opts.onSpeechBoundary?.(boundary),
        onInputTranscript: (transcript) => this.opts.onTranscript?.(transcript),
        // Every tool call goes to the server. The client answers none of them:
        // the tools read pinned scenario content and check the gate's
        // authorization, neither of which may live here.
        callTool: async (call) => {
          const res = await apiFetch(
            `${this.opts.apiBase}/v1/interview-sessions/${this.opts.sessionId}/voice-tool`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: call.name, args: call.args }),
            },
          );

          if (!res.ok) return { ok: false, refusal: `RELAY_${res.status}` };
          return (await res.json()) as Record<string, unknown>;
        },
        onModelAudio: (pcm) => {
          this.providerTurnComplete = false;
          this.playback?.enqueue(pcm);
          this.setStatus("SPEAKING");
        },
        onSpeechComplete: () => {
          this.providerTurnComplete = true;
          this.completeSpeechIfDrained();
        },
        onBargeIn: () => {
          // Immediate and total. Chunks arrive faster than real time, so a
          // barge-in that only stopped future audio would keep talking over the
          // candidate for however much was already scheduled.
          this.playback?.stop();
          this.providerTurnComplete = false;
          this.reportSpeechOutcome("INTERRUPTED");
          this.setStatus("LISTENING");
        },
        onReady: () => {
          this.reconnectAttempts = 0;
          this.setStatus("LISTENING");
          if (this.pendingSpeech) {
            voice.requestSpeech(this.pendingSpeech);
            this.pendingSpeech = null;
          }
          // Opens the interview. Until the model can be spoken through there is
          // nothing to deliver the brief to, so this is the moment — not session
          // creation, which would spend the authorization on silence.
          void apiFetch(
            `${this.opts.apiBase}/v1/interview-sessions/${this.opts.sessionId}/voice-ready`,
            { method: "POST" },
          ).catch(() => {});
        },
        onDisconnected: () => {
          if (!this.stopping && !this.replacingVoice) {
            this.scheduleReconnect(new Error("Voice connection ended. Reconnecting…"));
          }
        },
        onError: (err) => this.scheduleReconnect(err),
      });
    voice.setMuted(this.mutedState);
    this.voice = voice;
    voice.connect();
  }

  private scheduleReconnect(error: Error): void {
    if (this.stopping || this.reconnectTimer) return;
    this.playback?.stop();
    this.providerTurnComplete = false;
    this.reportSpeechOutcome("INTERRUPTED");
    this.setStatus("CONNECTING");
    this.opts.onError?.(error);
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempts++, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectProvider().catch((err: unknown) => {
        this.scheduleReconnect(err instanceof Error ? err : new Error(String(err)));
      });
    }, delay);
  }

  private completeSpeechIfDrained(): void {
    if (!this.providerTurnComplete || this.playback?.isPlaying) return;
    this.providerTurnComplete = false;
    this.setStatus("LISTENING");
    this.reportSpeechOutcome("COMPLETED");
  }

  private reportSpeechOutcome(outcome: "COMPLETED" | "INTERRUPTED"): void {
    void apiFetch(
      `${this.opts.apiBase}/v1/interview-sessions/${this.opts.sessionId}/voice-utterance-complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome }),
        keepalive: true,
      },
    ).catch(() => {});
  }

  /**
   * The server authorized speech; ask the model to produce it.
   *
   * Called from the app channel's ACTION message and nowhere else. The
   * authorization carries a server-minted utterance id, and no wording — the
   * model fetches that through the relay above, under the same check.
   */
  speak(authorization: SpeechAuthorization): void {
    if (this.voice?.isReady) {
      this.voice.requestSpeech(authorization);
      return;
    }
    this.pendingSpeech = authorization;
  }

  setMuted(muted: boolean): void {
    this.mutedState = muted;
    this.voice?.setMuted(muted);
    // Mute the track too. Stopping frames at the VAD would still leave the
    // browser's capture indicator on, which reads as being recorded while muted.
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.playback?.stop();
    this.voice?.disconnect();
    this.worklet?.disconnect();

    for (const track of this.stream?.getTracks() ?? []) track.stop();
    await this.context?.close().catch(() => {});

    this.context = null;
    this.stream = null;
    this.worklet = null;
    this.voice = null;
    this.pendingSpeech = null;
    this.playback = null;
    this.setStatus("IDLE");
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async mintCredential(): Promise<VoiceCredential> {
    const res = await apiFetch(
      `${this.opts.apiBase}/v1/interview-sessions/${this.opts.sessionId}/realtime-token`,
      { method: "POST" },
    );

    if (!res.ok) {
      const detail = res.status === 503 ? "Voice is not configured on the server." : `HTTP ${res.status}`;
      throw new Error(`could not obtain a voice credential: ${detail}`);
    }

    return (await res.json()) as VoiceCredential;
  }

  private async startCapture(context: AudioContext, stream: MediaStream): Promise<void> {
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "application/javascript" }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, "capture");

    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      this.voice?.pushAudio(event.data);
    };

    source.connect(worklet);
    // Not connected to destination — the candidate must not hear themselves.
    this.worklet = worklet;
  }

  private setStatus(status: VoiceStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatus?.(status);
  }

  private fail(err: Error): void {
    this.setStatus("FAILED");
    this.opts.onError?.(err);
  }
}

/** Live frames arrive as Blob in browsers and string in some environments. */
async function toText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return String(data);
}
