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
  /**
   * The device list or an active device changed — on an OS-level device change,
   * and after an automatic recovery. Lets the UI offer a switch during the round
   * and show which devices are actually live.
   */
  onDeviceChange?: (state: VoiceDeviceState) => void;
}

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  // Labels are empty until permission has been granted once — the caller should
  // enumerate again after start() for a list worth showing.
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput");
}

export async function listSpeakers(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audiooutput");
}

/** Output routing is Chromium-only; everything else degrades to the default. */
type SinkCapableContext = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

export interface VoiceDeviceState {
  microphones: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
  /** What the session is actually capturing from, after any recovery. */
  activeMicrophoneId?: string;
  activeSpeakerId?: string;
  /** False where the browser cannot route output; the picker should hide. */
  canChooseSpeaker: boolean;
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
  private goAwayTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private captureRate = 0;
  private mutedState = false;
  private providerTurnComplete = false;
  private pendingSpeech: SpeechAuthorization | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private activeDeviceId: string | undefined;
  private recoveringMicrophone = false;
  private activeSinkId: string | undefined;
  private deviceChangeListener: (() => void) | null = null;
  private speechInFlight = false;
  private candidateSpeechOpen = false;
  private awaitingFinalTranscript = false;
  private readonly transcriptWaiters = new Set<() => void>();
  /** Serializes handle reports so a replacement token cannot outrun its handle. */
  private resumptionReport: Promise<void> = Promise.resolve();

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
      this.activeDeviceId = this.opts.deviceId;
      this.stream = await this.openStream(this.activeDeviceId);

      // A device appearing or vanishing mid-round is normal (bluetooth headset,
      // docked laptop, another app grabbing the input). Watch for it so the
      // interview can recover instead of ending on a hardware event.
      if (typeof navigator.mediaDevices.addEventListener === "function") {
        this.deviceChangeListener = () => this.handleDeviceChange();
        navigator.mediaDevices.addEventListener("devicechange", this.deviceChangeListener);
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
      this.notifyDevices();
    } catch (err) {
      const failure = err instanceof Error ? err : new Error(String(err));
      // Permission can succeed before a later setup step fails. Release that
      // half-open stream and graph now; leaving cleanup until the user retries
      // keeps the browser's recording indicator lit behind a failed control.
      await this.stop();
      this.fail(failure);
      throw err;
    }
  }

  private async connectProvider(): Promise<void> {
    // Gemini sends the resumption handle on the old socket, while the API mints
    // the replacement credential. Make that handoff ordered: otherwise a fast
    // GoAway rotation can reach /realtime-token before the report request and
    // silently open a fresh provider session.
    await this.resumptionReport;
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
        onSpeechBoundary: (boundary) => {
          this.candidateSpeechOpen = boundary.type === "SPEECH_STARTED";
          this.awaitingFinalTranscript = true;
          this.opts.onSpeechBoundary?.(boundary);
        },
        onInputTranscript: (transcript) => {
          if (transcript.final) {
            this.awaitingFinalTranscript = false;
            for (const settle of this.transcriptWaiters) settle();
            this.transcriptWaiters.clear();
          }
          this.opts.onTranscript?.(transcript);
        },
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
          this.speechInFlight = true;
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
            this.speechInFlight = true;
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
        onResumptionHandle: (handle) => {
          // Reported, not held. The server decides which handle a credential is
          // minted with, so a browser cannot ask to resume a session that is not
          // its own. Reporting it also means a page refresh keeps continuity.
          this.resumptionReport = this.resumptionReport
            .then(async () => {
              const response = await apiFetch(
                `${this.opts.apiBase}/v1/interview-sessions/${this.opts.sessionId}/voice-resumption`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ handle }),
                },
              );
              if (!response.ok) throw new Error(`resumption handle rejected: HTTP ${response.status}`);
            })
            // Losing provider context is recoverable; failing the voice channel
            // itself would be worse. The next mint opens a clean session.
            .catch(() => {});
        },
        onGoAway: (timeLeftMs) => {
          this.scheduleGoAwayRotation(timeLeftMs);
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
    if (this.goAwayTimer) clearTimeout(this.goAwayTimer);
    this.goAwayTimer = null;
    this.playback?.stop();
    this.providerTurnComplete = false;
    if (this.speechInFlight) this.reportSpeechOutcome("INTERRUPTED");
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

  private scheduleGoAwayRotation(timeLeftMs: number): void {
    if (this.stopping) return;
    if (this.goAwayTimer) clearTimeout(this.goAwayTimer);
    const deadline = Date.now() + Math.max(0, timeLeftMs);

    const rotate = () => {
      const remaining = deadline - Date.now();
      if (this.speechInFlight && remaining > 3_000) {
        this.goAwayTimer = setTimeout(rotate, Math.min(250, remaining - 3_000));
        return;
      }

      this.goAwayTimer = null;
      if (this.speechInFlight) {
        this.playback?.stop();
        this.providerTurnComplete = false;
        this.reportSpeechOutcome("INTERRUPTED");
      }
      this.setStatus("CONNECTING");
      void this.connectProvider().catch((err: unknown) => {
        this.scheduleReconnect(err instanceof Error ? err : new Error(String(err)));
      });
    };

    // Begin five seconds early. If speech is active it may finish naturally,
    // but three seconds remain reserved for token minting and the handshake.
    this.goAwayTimer = setTimeout(rotate, Math.max(0, timeLeftMs - 5_000));
  }

  private completeSpeechIfDrained(): void {
    if (!this.providerTurnComplete || this.playback?.isPlaying) return;
    this.providerTurnComplete = false;
    this.setStatus("LISTENING");
    this.reportSpeechOutcome("COMPLETED");
  }

  private reportSpeechOutcome(outcome: "COMPLETED" | "INTERRUPTED"): void {
    if (!this.speechInFlight) return;
    this.speechInFlight = false;
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
      this.speechInFlight = true;
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

  /**
   * End the candidate's current audio turn and allow its authoritative provider
   * transcript to reach the app channel before the server seals the session.
   * The bound keeps a provider fault from trapping the completion button.
   */
  async finishInput(timeoutMs = 4_000): Promise<void> {
    if (this.stopping || (!this.candidateSpeechOpen && !this.awaitingFinalTranscript)) return;

    let settle!: () => void;
    const transcript = new Promise<void>((resolve) => {
      settle = resolve;
      this.transcriptWaiters.add(resolve);
    });

    if (this.candidateSpeechOpen) this.setMuted(true);

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        transcript,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.transcriptWaiters.delete(settle);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.deviceChangeListener) {
      navigator.mediaDevices?.removeEventListener("devicechange", this.deviceChangeListener);
      this.deviceChangeListener = null;
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.goAwayTimer) clearTimeout(this.goAwayTimer);
    this.goAwayTimer = null;
    this.playback?.stop();
    if (this.speechInFlight) this.reportSpeechOutcome("INTERRUPTED");
    this.voice?.disconnect();
    this.worklet?.disconnect();

    for (const track of this.stream?.getTracks() ?? []) track.stop();
    await this.context?.close().catch(() => {});

    this.context = null;
    this.stream = null;
    this.worklet = null;
    this.source = null;
    this.activeDeviceId = undefined;
    this.activeSinkId = undefined;
    this.voice = null;
    this.pendingSpeech = null;
    this.playback = null;
    for (const settle of this.transcriptWaiters) settle();
    this.transcriptWaiters.clear();
    this.candidateSpeechOpen = false;
    this.awaitingFinalTranscript = false;
    this.setStatus("IDLE");
  }

  /**
   * Swap the capture device without disturbing the interview.
   *
   * Only the microphone half of the audio graph is rebuilt. The provider
   * socket, any pending speech authorization and the server-owned deadline are
   * all untouched, so changing headsets costs the candidate nothing. This is
   * deliberately not start()/stop(): that path re-mints a credential, replays
   * the ready handshake and would re-open the brief.
   */
  async switchMicrophone(deviceId?: string): Promise<void> {
    const context = this.context;
    if (this.stopping || !context) return;
    const stream = await this.openStream(deviceId);
    await this.replaceCaptureStream(context, stream, deviceId);
  }

  /**
   * Route the interviewer's audio to a different output.
   *
   * Only meaningful where AudioContext.setSinkId exists. Elsewhere the browser
   * follows the system default and there is nothing to choose, so this resolves
   * without pretending otherwise.
   */
  async switchSpeaker(deviceId?: string): Promise<void> {
    const context = this.context as SinkCapableContext | null;
    if (this.stopping || !context?.setSinkId) return;
    await context.setSinkId(deviceId ?? "");
    this.activeSinkId = deviceId;
    this.notifyDevices();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Acquire a capture stream and arm its loss handler.
   *
   * Mute is applied to the track here rather than by the caller: a replacement
   * stream that ignored it would silently un-mute the candidate.
   */
  private async openStream(deviceId?: string): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: 1,
        // The browser's own processing is better than ours and it runs before
        // our VAD sees anything, which is the correct order.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    for (const track of stream.getAudioTracks()) {
      track.enabled = !this.mutedState;
      track.onended = () => {
        if (!this.stopping) void this.recoverMicrophone();
      };
    }
    return stream;
  }

  /** Detach the old capture graph, attach the new one, then release the old device. */
  private async replaceCaptureStream(
    context: AudioContext,
    stream: MediaStream,
    deviceId: string | undefined,
  ): Promise<void> {
    const previous = this.stream;

    this.source?.disconnect();
    this.worklet?.disconnect();
    this.source = null;
    this.worklet = null;

    this.stream = stream;
    this.activeDeviceId = deviceId;
    await this.startCapture(context, stream);

    // Released only once the replacement is carrying audio, so the browser's
    // capture indicator never blinks off mid-interview.
    for (const track of previous?.getTracks() ?? []) {
      // We are retiring this stream deliberately. Its `ended` callback is for
      // hardware loss; leaving it armed would start a second recovery while a
      // successful device switch is already complete.
      track.onended = null;
      track.stop();
    }

    // A recovery that lands while the session is FAILED should return it to the
    // round rather than leaving a dead control behind.
    if (this.status === "FAILED" && this.voice?.isReady) this.setStatus("LISTENING");
    this.notifyDevices();
  }

  /**
   * The active microphone went away — unplugged, bluetooth dropped, or taken by
   * another application.
   *
   * Try the same device first, since a USB interface that re-enumerates usually
   * keeps its id, then fall back to the system default. Only if both fail does
   * this surface a failure, and the provider connection stays up even then, so
   * picking a device recovers in place instead of restarting the round.
   */
  private async recoverMicrophone(): Promise<void> {
    const context = this.context;
    if (this.recoveringMicrophone || this.stopping || !context) return;
    this.recoveringMicrophone = true;

    try {
      for (const candidate of [this.activeDeviceId, undefined]) {
        try {
          const stream = await this.openStream(candidate);
          await this.replaceCaptureStream(context, stream, candidate);
          return;
        } catch {
          // Fall through to the next candidate.
        }
      }
      // The provider connection and interview are still healthy. Keep the live
      // controls available so a newly connected device can recover in place.
      this.opts.onError?.(
        new Error(
          "Microphone disconnected. Reconnect it or choose another device — your code, notes and interview time are safe.",
        ),
      );
      this.notifyDevices();
    } finally {
      this.recoveringMicrophone = false;
    }
  }

  /**
   * An OS-level device change. If the stream we are holding is still live this
   * is only news for the picker; if it is not, the active device just vanished.
   */
  private handleDeviceChange(): void {
    if (this.stopping) return;

    void this.recoverSpeaker();

    const live = this.stream?.getAudioTracks().some((track) => track.readyState === "live") ?? false;
    if (!live) {
      void this.recoverMicrophone();
      return;
    }
    this.notifyDevices();
  }

  /**
   * The chosen output went away.
   *
   * Losing a speaker is quieter than losing a microphone — literally. Nothing
   * throws; the interviewer simply becomes inaudible, which a candidate reads as
   * the AI having stopped talking. So this checks explicitly rather than waiting
   * for an error that never arrives: fall back to the system default, and resume
   * a context that the removal suspended.
   */
  private async recoverSpeaker(): Promise<void> {
    const context = this.context as SinkCapableContext | null;
    if (this.stopping || !context) return;

    try {
      if (this.activeSinkId && context.setSinkId) {
        const speakers = await listSpeakers();
        const stillPresent = speakers.some((device) => device.deviceId === this.activeSinkId);
        if (!stillPresent) {
          await context.setSinkId("");
          this.activeSinkId = undefined;
          this.opts.onError?.(
            new Error("Your speaker disconnected. Audio moved to the default output."),
          );
        }
      }

      // Removing the active output suspends the graph in Chromium. Left
      // suspended, scheduled interviewer audio is dropped silently.
      if (context.state === "suspended") await context.resume();
    } catch {
      // Best effort. A failed reroute must not take the interview down.
    }
  }

  private notifyDevices(): void {
    const notify = this.opts.onDeviceChange;
    if (!notify) return;

    void Promise.all([listMicrophones(), listSpeakers()])
      .then(([microphones, speakers]) => {
        if (this.stopping) return;
        const context = this.context as SinkCapableContext | null;
        notify({
          microphones,
          speakers,
          canChooseSpeaker: typeof context?.setSinkId === "function",
          ...(this.activeDeviceId ? { activeMicrophoneId: this.activeDeviceId } : {}),
          ...(this.activeSinkId ? { activeSpeakerId: this.activeSinkId } : {}),
        });
      })
      .catch(() => {});
  }


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
    // Held so a device swap can detach exactly this graph and leave the
    // provider socket alone.
    this.source = source;
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
