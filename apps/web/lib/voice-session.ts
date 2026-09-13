import { PlaybackScheduler, type AudioSink, type ScheduledSource } from "./playback";
import { apiFetch } from "./auth";
import {
  RealtimeVoice,
  type SpeechAuthorization,
  type SpeechBoundary,
  type UtteranceOutcome,
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

/**
 * Fade applied when a scheduled buffer is cancelled.
 *
 * Barge-in stops buffers at an arbitrary sample. That is a step discontinuity,
 * and a step discontinuity is a click — on every single interruption. Long
 * enough to remove it, short enough that nobody hears a fade.
 */
const STOP_RAMP_SECONDS = 0.008;

/** What the capture worklet posts. The timestamp is the point of the wrapper. */
interface CaptureFrame {
  samples: Float32Array;
  /** Context time at the end of the frame. See `startCapture`. */
  atSeconds: number;
}

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
        // Timestamped here, from the audio clock, rather than with Date.now()
        // on the receiving end. Frames queue behind main-thread work, so a
        // detector reading arrival time sees several frames at the same instant
        // followed by a gap — and then every duration it measures
        // (minSpeechMs, endHangoverMs) is wrong exactly when the page is busy.
        this.port.postMessage({ samples: this.buffer.slice(0), atSeconds: currentTime });
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

    // The gain stage exists for `stop()` alone — see STOP_RAMP_SECONDS. A buffer
    // scheduled in the future is stopped before it starts, which is legal and
    // simply means it never plays; `onended` still fires, so the scheduler still
    // learns the queue drained.
    const gain = this.context.createGain();
    node.connect(gain);
    gain.connect(this.context.destination);

    const handle: ScheduledSource = {
      stop: () => {
        const at = this.context.currentTime;
        gain.gain.cancelScheduledValues(at);
        gain.gain.setValueAtTime(gain.gain.value, at);
        gain.gain.linearRampToValueAtTime(0, at + STOP_RAMP_SECONDS);
        node.stop(at + STOP_RAMP_SECONDS);
      },
    };
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
  /** True from an utterance's first audio chunk until it is reported complete. */
  private utteranceOpen = false;
  /** The model stopped generating. Not the same as the candidate having stopped hearing it. */
  private generationDone = false;
  /** Which utterance the pending report is about, so a stale one cannot close a newer window. */
  private pendingUtteranceId: string | null = null;
  /** How it ended. Only COMPLETED waits for the speakers to drain. */
  private pendingOutcome: UtteranceOutcome = "COMPLETED";

  constructor(private readonly opts: VoiceSessionOptions) {}

  get currentStatus(): VoiceStatus {
    return this.status;
  }

  get muted(): boolean {
    return this.voice?.isMuted ?? false;
  }

  async start(): Promise<void> {
    this.setStatus("CONNECTING");

    try {
      const credential = await this.mintCredential();

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
          // Off, deliberately. The VAD thresholds on distance above a tracked
          // noise floor, and AGC's whole job is to compress that distance: it
          // lifts the room during pauses and holds speech at a target, which
          // narrows the very margin the detector measures. Useful for a
          // transcriber, actively harmful to a relative-energy VAD.
          autoGainControl: false,
        },
      });

      this.context = new AudioContext();
      const captureRate = this.context.sampleRate;

      this.playback = new PlaybackScheduler({
        sink: new WebAudioSink(this.context, (source) => this.playback?.release(source)),
        onDrain: () => this.settleUtterance(),
      });

      this.voice = new RealtimeVoice({
        credential,
        captureRate,
        // Barge-in must remain possible through the playback tail, which outlasts
        // generation by however much audio is queued.
        isPlaying: () => this.playback?.isPlaying ?? false,
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
          this.utteranceOpen = true;
          this.playback?.enqueue(pcm);
          this.setStatus("SPEAKING");
        },
        onSpeechComplete: (utteranceId) => {
          // Generation finished. The candidate is very probably still listening
          // — `settleUtterance` decides when that stops being true.
          this.armReport(utteranceId, "COMPLETED");
          this.settleUtterance();
        },
        onBargeIn: (utteranceId) => {
          // Immediate and total. Chunks arrive faster than real time, so a
          // barge-in that only stopped future audio would keep talking over the
          // candidate for however much was already scheduled.
          this.playback?.stop();
          // As far as the candidate is concerned this utterance is over, so the
          // window closes now rather than whenever the model finishes generating
          // into a void — and it closes as INTERRUPTED, which is what stops a
          // half-heard brief from advancing the interview.
          this.armReport(utteranceId, "INTERRUPTED");
          this.settleUtterance();
        },
        onSpeechFailed: (utteranceId) => {
          this.playback?.stop();
          this.armReport(utteranceId, "FAILED");
          this.settleUtterance();
        },
        onReady: () => {
          this.setStatus("LISTENING");
          // Opens the interview. Until the model can be spoken through there is
          // nothing to deliver the brief to, so this is the moment — not session
          // creation, which would spend the authorization on silence.
          void apiFetch(
            `${this.opts.apiBase}/v1/interview-sessions/${this.opts.sessionId}/voice-ready`,
            { method: "POST" },
          ).catch(() => {});
        },
        onError: (err) => this.fail(err),
      });

      this.voice.connect();
      await this.startCapture(this.context, this.stream);
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /**
   * The server authorized speech; ask the model to produce it.
   *
   * Called from the app channel's ACTION message and nowhere else. The
   * authorization carries a server-minted utterance id, and no wording — the
   * model fetches that through the relay above, under the same check.
   */
  speak(authorization: SpeechAuthorization): void {
    this.voice?.requestSpeech(authorization);
  }

  setMuted(muted: boolean): void {
    this.voice?.setMuted(muted);
    // Mute the track too. Stopping frames at the VAD would still leave the
    // browser's capture indicator on, which reads as being recorded while muted.
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  async stop(): Promise<void> {
    this.playback?.stop();
    this.voice?.disconnect();
    this.worklet?.disconnect();

    for (const track of this.stream?.getTracks() ?? []) track.stop();
    await this.context?.close().catch(() => {});

    this.context = null;
    this.stream = null;
    this.worklet = null;
    this.voice = null;
    this.playback = null;
    this.utteranceOpen = false;
    this.generationDone = false;
    this.pendingUtteranceId = null;
    this.setStatus("IDLE");
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Record what the pending report will say. Separate so `settleUtterance` stays about timing. */
  private armReport(utteranceId: string | null, outcome: UtteranceOutcome): void {
    this.pendingUtteranceId = utteranceId;
    this.pendingOutcome = outcome;
    this.generationDone = true;
  }

  /**
   * Report the interviewer's utterance finished — once, and at the right moment.
   *
   * The right moment is when the candidate stops *hearing* the interviewer, not
   * when the model stops generating. Live chunks arrive faster than real time,
   * so `turnComplete` can precede the last speaker output by seconds. Reporting
   * on it started the gate's silence clock while the interviewer was still
   * audibly talking, which meant every `silenceMs` M4-2 measured was short by
   * the length of the playback queue — in the one direction that makes the gate
   * more willing to speak.
   *
   * Only COMPLETED waits for the queue. An interruption and a failure are both
   * already true at the speakers: playback was cancelled on the way in, so
   * waiting for a drain that has already happened would be waiting for nothing.
   *
   * Called from four places (generation end, queue drain, barge-in, failure)
   * and idempotent across them, because which arrives last depends on the
   * network.
   */
  private settleUtterance(): void {
    if (!this.generationDone) return;
    // An authorized turn that produced no audio at all still has to be closed;
    // waiting on a queue that was never filled would hold the window open.
    if (this.pendingOutcome === "COMPLETED" && this.utteranceOpen && this.playback?.isPlaying) {
      return;
    }

    const utteranceId = this.pendingUtteranceId;
    const outcome = this.pendingOutcome === "COMPLETED" && !this.utteranceOpen
      ? "FAILED" : this.pendingOutcome;

    this.generationDone = false;
    this.utteranceOpen = false;
    this.pendingUtteranceId = null;
    this.pendingOutcome = "COMPLETED";
    this.setStatus("LISTENING");
    if (!utteranceId) return;
    this.voice?.markPlaybackFinished(utteranceId);

    // Fire and forget: a lost report costs a stale window, not a broken session.
    void apiFetch(
      `${this.opts.apiBase}/v1/interview-sessions/${this.opts.sessionId}/voice-utterance-complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome, ...(utteranceId ? { utteranceId } : {}) }),
        keepalive: true,
      },
    ).catch(() => {});
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

    // Anchor the context clock to wall time once. Boundary timestamps keep the
    // epoch semantics the server's event log expects, while their *spacing*
    // comes from the audio clock rather than from when the event loop got round
    // to the message.
    const epochMs = Date.now() - context.currentTime * 1_000;

    worklet.port.onmessage = (event: MessageEvent<CaptureFrame>) => {
      this.voice?.pushAudio(event.data.samples, epochMs + event.data.atSeconds * 1_000);
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
