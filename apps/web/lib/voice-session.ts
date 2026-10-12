import {
  PlaybackScheduler,
  type AudioSink,
  type ScheduledSource,
} from "./playback";
import { apiFetch } from "./api-client";
import {
  RealtimeVoice,
  type SpeechAuthorization,
  type SpeechBoundary,
  type VoiceCredential,
} from "./realtime-voice";
import { VoiceLatencyLedger, type LatencyLedger } from "./latency-ledger";
import { Vad } from "./vad";
import { ProsodicTurnEndPredictor } from "./turn-predictor";
import { RoomTone } from "./room-tone";
import { LIVE_OUTPUT_SAMPLE_RATE } from "./audio";
import {
  UtteranceLifecycle,
  type UtteranceReport,
  type UtteranceSignal,
} from "./utterance-lifecycle";

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

const CAPTURE_WORKLET = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(Math.round(sampleRate * 0.02));
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
  private readonly gainNode: GainNode;
  get running(): boolean {
    return this.context.state === "running";
  }
  constructor(
    private readonly context: AudioContext,
    private readonly onEnded: (source: ScheduledSource) => void,
  ) {
    this.gainNode = context.createGain();
    this.gainNode.connect(context.destination);
  }

  setGain(value: number, seconds: number): void {
    const now = this.context.currentTime;
    const gain = this.gainNode.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    if (seconds <= 0) gain.setValueAtTime(value, now);
    else gain.linearRampToValueAtTime(value, now + seconds);
  }

  get currentTime(): number {
    return this.context.currentTime;
  }

  play(
    samples: Float32Array,
    sampleRate: number,
    atTime: number,
  ): ScheduledSource {
    // The model's rate rarely matches the context's, and an AudioBuffer created
    // at the source rate is resampled by the browser on playback — better than
    // anything we would write here.
    const buffer = this.context.createBuffer(1, samples.length, sampleRate);
    // `set` rather than `copyToChannel`: the latter's signature pins the backing
    // buffer type, and our samples come from a slice whose provenance TS tracks.
    buffer.getChannelData(0).set(samples);

    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gainNode);

    const handle: ScheduledSource = { stop: () => node.stop() };
    node.onended = () => this.onEnded(handle);
    node.start(atTime);

    return handle;
  }
}

export type VoiceStatus =
  "IDLE" | "CONNECTING" | "LISTENING" | "SPEAKING" | "FAILED";

/**
 * Deadlines for an authorized utterance (roadmap §1).
 *
 * Each one is a point after which waiting longer cannot be told apart from the
 * interviewer having silently decided not to speak — so the utterance ends
 * with an honest FAILED instead, and the candidate is told.
 */
export const SPEECH_DEADLINES = {
  /** Authorized model speech with no audio. Covers a tool round trip. */
  noFirstAudioMs: 15_000,
  /** The provider ended its turn with no audio; allow late frames briefly. */
  emptyTurnGraceMs: 3_000,
  /** Playback drained while the source still owed audio. A spoken pause is
   *  encoded as silent samples, so an empty queue means no data arrived. */
  midStreamStallMs: 5_000,
  /** Source complete but playback never drained (suspended output, lost device). */
  drainSlackMs: 3_000,
  /** Authorized while the provider socket was down. */
  providerUnavailableMs: 20_000,
} as const;

/** A structured, user-safe record of something that went wrong with voice. */
export interface VoiceDiagnostic {
  kind:
    | "READY_FAILED"
    | "SPEECH_FAILED"
    | "SPEECH_CUT_OFF"
    | "OUTCOME_REPORT_FAILED"
    | "PROVIDER_RECONNECT";
  atMs: number;
  utteranceId?: string | undefined;
  action?: string | undefined;
  reason?: string | undefined;
  detail?: string | undefined;
}

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
  /** Structured diagnostics; also kept in `diagnostics` for support reports. */
  onDiagnostic?: (diagnostic: VoiceDiagnostic) => void;
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
  private captureGain: GainNode | null = null;
  private voice: RealtimeVoice | null = null;
  private playback: PlaybackScheduler | null = null;
  private roomTone: RoomTone | null = null;
  private status: VoiceStatus = "IDLE";
  private stopping = false;
  private replacingVoice = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private goAwayTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private captureRate = 0;
  private mutedState = false;
  private pendingSpeech: SpeechAuthorization | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private activeDeviceId: string | undefined;
  private recoveringMicrophone = false;
  private activeSinkId: string | undefined;
  private deviceChangeListener: (() => void) | null = null;
  /**
   * The one utterance in flight, from authorization to an honest outcome.
   * Replaces the old cluster of booleans; see utterance-lifecycle.ts.
   */
  private utterance: UtteranceLifecycle | null = null;
  /** Recently finished ids, so a duplicate ACTION cannot replay a turn. */
  private readonly finishedUtterances: string[] = [];
  private speechWatchdog: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic time the current utterance was requested or authorized. */
  private speechWaitStartedAt = 0;
  /** The provider ended the current turn without audio. */
  private emptyTurnAtMs: number | null = null;
  /** A source failure that waits for the already-queued prefix to drain. */
  private pendingFailure: string | null = null;
  private cachedAbort: AbortController | null = null;
  /** Ordered outcome reports; /voice-ready waits for them. */
  private outcomeReports: Promise<void> = Promise.resolve();
  private readyGeneration = 0;
  private readonly diagnosticLog: VoiceDiagnostic[] = [];
  private candidateSpeechOpen = false;
  private awaitingFinalTranscript = false;
  private latestInterimTranscript = "";
  private readonly finalTranscriptChunks: string[] = [];
  private finalTranscriptTimer: ReturnType<typeof setTimeout> | null = null;
  private finalFlushNotBeforeMs = 0;
  private preStopInterimAtMs: number | null = null;
  private preStopFinalAtMs: number | null = null;
  private preStopFinalChunks = 0;
  private readonly transcriptWaiters = new Set<() => void>();
  /** Serializes handle reports so a replacement token cannot outrun its handle. */
  private resumptionReport: Promise<void> = Promise.resolve();
  private readonly ledger = new VoiceLatencyLedger({
    onComplete: (report) => this.postLatencyReport(report),
  });

  constructor(private readonly opts: VoiceSessionOptions) {}

  get currentStatus(): VoiceStatus {
    return this.status;
  }

  get muted(): boolean {
    return this.mutedState;
  }

  /** Recent voice diagnostics, newest last. Safe to attach to a support report. */
  get diagnostics(): readonly VoiceDiagnostic[] {
    return [...this.diagnosticLog];
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
        navigator.mediaDevices.addEventListener(
          "devicechange",
          this.deviceChangeListener,
        );
      }

      this.context = new AudioContext({ latencyHint: "interactive" });
      await this.context.resume();
      this.captureRate = this.context.sampleRate;

      if (process.env.NEXT_PUBLIC_ROOM_TONE !== "off") {
        this.roomTone = new RoomTone(this.context);
        this.roomTone.start();
      }

      this.playback = new PlaybackScheduler({
        sink: new WebAudioSink(this.context, (source) => {
          this.playback?.release(source);
          this.onPlaybackProgress();
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

    const configuredHangover = Number(process.env.NEXT_PUBLIC_VAD_HANGOVER_MS);
    const endHangoverMs =
      Number.isFinite(configuredHangover) &&
      configuredHangover >= 500 &&
      configuredHangover <= 800
        ? configuredHangover
        : 500;

    const voice = new RealtimeVoice({
      credential,
      captureRate: this.captureRate,
      vad: new Vad(
        { endHangoverMs },
        process.env.NEXT_PUBLIC_TURN_PREDICTOR === "off"
          ? null
          : new ProsodicTurnEndPredictor(),
      ),
      connect: (handlers) => {
        const socket = new WebSocket(credential.wsUrl);
        socket.binaryType = "arraybuffer";
        socket.onopen = () => handlers.onOpen();
        socket.onclose = () => handlers.onClose();
        socket.onerror = () =>
          handlers.onError(new Error("voice socket error"));
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
        if (boundary.type === "SPEECH_STARTED") {
          this.latestInterimTranscript = "";
          this.preStopInterimAtMs = null;
          this.preStopFinalAtMs = null;
          this.preStopFinalChunks = 0;
          if (this.finalTranscriptTimer)
            clearTimeout(this.finalTranscriptTimer);
          this.finalTranscriptTimer = null;
        }
        if (boundary.type === "SPEECH_STOPPED") {
          this.ledger.mark("quietOnsetMs", boundary.atMs);
          this.ledger.mark("vadEndDetectedMs", Date.now());
          this.ledger.mark("activityEndSentMs", Date.now());
          if (this.preStopInterimAtMs !== null)
            this.ledger.mark(
              "firstInterimTranscriptMs",
              this.preStopInterimAtMs,
            );
          if (this.preStopFinalAtMs !== null) {
            for (let i = 0; i < this.preStopFinalChunks; i++)
              this.ledger.mark("transcriptFinalMs", this.preStopFinalAtMs);
          }
          this.finalFlushNotBeforeMs = Date.now() + 250;
          this.scheduleFinalTranscriptFlush(250);
        }
        const boundaryText =
          this.finalTranscriptChunks.length > 0
            ? assembleTranscript(this.finalTranscriptChunks)
            : this.latestInterimTranscript;
        this.opts.onSpeechBoundary?.(
          boundary.type === "SPEECH_STOPPED" && boundaryText
            ? { ...boundary, interimTranscript: boundaryText.slice(0, 400) }
            : boundary,
        );
      },
      onInputTranscript: (transcript) => {
        if (transcript.final) {
          const atMs = Date.now();
          if (this.candidateSpeechOpen) {
            this.preStopFinalAtMs = atMs;
            this.preStopFinalChunks += 1;
          } else {
            this.ledger.mark("transcriptFinalMs", atMs);
          }
          if (process.env.NEXT_PUBLIC_TRANSCRIPT_COALESCE === "off") {
            this.awaitingFinalTranscript = false;
            for (const settle of this.transcriptWaiters) settle();
            this.transcriptWaiters.clear();
            this.opts.onTranscript?.(transcript);
            return;
          }
          this.finalTranscriptChunks.push(transcript.text);
          this.opts.onTranscript?.({
            text: assembleTranscript(this.finalTranscriptChunks),
            final: false,
          });
          if (!this.candidateSpeechOpen) this.scheduleFinalTranscriptFlush(120);
        } else {
          if (this.candidateSpeechOpen) this.preStopInterimAtMs ??= Date.now();
          else this.ledger.mark("firstInterimTranscriptMs", Date.now());
          this.latestInterimTranscript = transcript.text.trim().slice(0, 400);
          this.opts.onTranscript?.(transcript);
        }
      },
      // Every tool call goes to the server. The client answers none of them:
      // the tools read pinned scenario content and check the gate's
      // authorization, neither of which may live here.
      callTool: async (call, signal) => {
        const res = await apiFetch(
          `${this.opts.apiBase}/v1/interview-sessions/${this.opts.sessionId}/voice-tool`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: call.name, args: call.args }),
            ...(signal ? { signal } : {}),
          },
        );

        if (!res.ok) return { ok: false, refusal: `RELAY_${res.status}` };
        return (await res.json()) as Record<string, unknown>;
      },
      onToolCall: (info) => {
        if (this.voice === voice) this.ledger.toolCall(info.ms, info.ok);
      },
      onModelAudio: (pcm, utteranceId) => {
        // Tagged twice: by connection (a replaced socket's late frames) and by
        // utterance (a cancelled turn's late frames). Either mismatch is audio
        // nobody authorized to play now.
        const u = this.utterance;
        if (this.voice !== voice || !u || u.source !== "MODEL") return;
        if (utteranceId !== u.utteranceId || pcm.length === 0) return;
        const isFirstChunk = !u.hasAudio;
        this.signal({ type: "AUDIO_RECEIVED", seconds: pcm.length / LIVE_OUTPUT_SAMPLE_RATE });
        const startAt = this.playback?.enqueue(pcm);
        if (startAt === null || startAt === undefined) return;
        this.signal({ type: "PLAYBACK_STARTED" });
        voice.noteModelPlayback(true);
        this.setStatus("SPEAKING");
        if (isFirstChunk) {
          this.ledger.mark("firstAudioByteMs", Date.now());
          this.ledger.firstSamplePlayed(this.firstSampleWallTime(startAt));
        }
      },
      onSpeechComplete: ({ utteranceId, hadAudio }) => {
        const u = this.utterance;
        if (this.voice !== voice || !u || u.source !== "MODEL") return;
        if (utteranceId !== u.utteranceId) return;
        if (hadAudio) {
          this.signal({ type: "SOURCE_COMPLETE" });
          return;
        }
        // A provider can end a turn without audio. That is not a delivered
        // answer — but late frames are possible, so give it a short grace
        // period before reporting EMPTY_RESPONSE.
        this.emptyTurnAtMs = performance.now();
        this.armWatchdog();
      },
      onBargeIn: () => {
        if (this.voice !== voice) return;
        // Immediate and total. Chunks arrive faster than real time, so a
        // barge-in that only stopped future audio would keep talking over the
        // candidate for however much was already scheduled.
        const unplayedSeconds = this.playback?.queuedSeconds ?? 0;
        this.playback?.stop();
        this.signal({ type: "INTERRUPT", unplayedSeconds });
        this.setStatus("LISTENING");
      },
      onBargeInProvisional: (ducked) => {
        if (ducked) this.playback?.duck();
        else this.playback?.restore();
      },
      onReady: () => {
        if (this.voice !== voice) return;
        this.reconnectAttempts = 0;
        if (this.utterance?.source !== "CACHED") this.setStatus("LISTENING");
        const pending = this.pendingSpeech;
        this.pendingSpeech = null;
        if (pending && this.utterance?.utteranceId === pending.utteranceId) {
          this.requestModelSpeech(this.utterance, pending);
        }
        // Opens the interview. Until the model can be spoken through there is
        // nothing to deliver the brief to, so this is the moment — not session
        // creation, which would spend the authorization on silence.
        void this.postVoiceReady();
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
            if (!response.ok)
              throw new Error(
                `resumption handle rejected: HTTP ${response.status}`,
              );
          })
          // Losing provider context is recoverable; failing the voice channel
          // itself would be worse. The next mint opens a clean session.
          .catch(() => {});
      },
      onGoAway: (timeLeftMs) => {
        this.scheduleGoAwayRotation(timeLeftMs);
      },
      onDisconnected: () => {
        if (!this.candidateSpeechOpen) this.flushFinalTranscript();
        if (!this.stopping && !this.replacingVoice) {
          this.scheduleReconnect(
            new Error("Voice connection ended. Reconnecting…"),
          );
        }
      },
      onError: (err) => this.scheduleReconnect(err),
    });
    voice.setMuted(this.mutedState);
    if (this.utterance?.source === "CACHED") voice.noteLocalPlayback(true);
    this.voice = voice;
    voice.connect();
  }

  private scheduleReconnect(error: Error): void {
    if (this.stopping || this.reconnectTimer) return;
    if (this.goAwayTimer) clearTimeout(this.goAwayTimer);
    this.goAwayTimer = null;
    // Cached audio does not depend on the provider socket and keeps playing.
    // Model speech does, and it ends here as a failure rather than pretending
    // it was interrupted by the candidate.
    if (this.utterance?.source === "MODEL") {
      const unplayedSeconds = this.playback?.queuedSeconds ?? 0;
      this.playback?.stop();
      this.signal({ type: "FAIL", reason: "PROVIDER_DISCONNECTED", unplayedSeconds });
    }
    this.pendingSpeech = null;
    if (this.utterance?.source !== "CACHED") this.setStatus("CONNECTING");
    this.diagnose({ kind: "PROVIDER_RECONNECT", detail: error.message.slice(0, 200) });
    this.opts.onError?.(error);
    const delay = Math.min(
      30_000,
      1_000 * 2 ** Math.min(this.reconnectAttempts++, 5),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectProvider().catch((err: unknown) => {
        this.scheduleReconnect(
          err instanceof Error ? err : new Error(String(err)),
        );
      });
    }, delay);
  }

  private scheduleGoAwayRotation(timeLeftMs: number): void {
    if (this.stopping) return;
    if (this.goAwayTimer) clearTimeout(this.goAwayTimer);
    const deadline = Date.now() + Math.max(0, timeLeftMs);

    const rotate = () => {
      const remaining = deadline - Date.now();
      if (this.utterance?.source === "MODEL" && remaining > 3_000) {
        this.goAwayTimer = setTimeout(rotate, Math.min(250, remaining - 3_000));
        return;
      }

      this.goAwayTimer = null;
      if (this.utterance?.source === "MODEL") {
        const unplayedSeconds = this.playback?.queuedSeconds ?? 0;
        this.playback?.stop();
        this.signal({ type: "FAIL", reason: "PROVIDER_GOAWAY", unplayedSeconds });
      }
      if (this.utterance?.source !== "CACHED") this.setStatus("CONNECTING");
      void this.connectProvider().catch((err: unknown) => {
        this.scheduleReconnect(
          err instanceof Error ? err : new Error(String(err)),
        );
      });
    };

    // Begin five seconds early. If speech is active it may finish naturally,
    // but three seconds remain reserved for token minting and the handshake.
    this.goAwayTimer = setTimeout(rotate, Math.max(0, timeLeftMs - 5_000));
  }

  // ── Utterance lifecycle ────────────────────────────────────────────────────

  /** Feed one signal to the utterance in flight; finish it if that ended it. */
  private signal(signal: UtteranceSignal): void {
    const u = this.utterance;
    if (!u) return;
    const report = u.apply(signal, performance.now());
    if (report) this.finishUtterance(u, report);
    else this.armWatchdog();
  }

  /** A buffer finished on its own. Drain is half of delivery, never all of it. */
  private onPlaybackProgress(): void {
    const playing = Boolean(this.playback?.isPlaying);
    const u = this.utterance;
    this.voice?.noteModelPlayback(u?.source === "MODEL" && playing);
    if (playing || !u) return;
    if (this.pendingFailure) {
      this.signal({ type: "FAIL", reason: this.pendingFailure });
      return;
    }
    this.signal({ type: "PLAYBACK_DRAINED" });
  }

  /**
   * Re-arm the one deadline that applies to the utterance's current state.
   *
   * Uses buffer depth rather than wall time alone: while audio is queued the
   * candidate is hearing something, so only an EMPTY queue with audio still
   * owed counts toward a stall. A normal spoken pause never empties the queue.
   */
  private armWatchdog(): void {
    if (this.speechWatchdog) clearTimeout(this.speechWatchdog);
    this.speechWatchdog = null;
    const u = this.utterance;
    if (!u || u.terminal || this.stopping) return;

    const playing = Boolean(this.playback?.isPlaying);
    const now = performance.now();
    let delayMs: number;
    let reason: string;

    if (!u.hasAudio) {
      if (u.source !== "MODEL") return;
      if (this.emptyTurnAtMs !== null) {
        delayMs = this.emptyTurnAtMs + SPEECH_DEADLINES.emptyTurnGraceMs - now;
        reason = "EMPTY_RESPONSE";
      } else if (u.phase === "AUTHORIZED") {
        delayMs = this.speechWaitStartedAt + SPEECH_DEADLINES.providerUnavailableMs - now;
        reason = "PROVIDER_UNAVAILABLE";
      } else {
        delayMs = this.speechWaitStartedAt + SPEECH_DEADLINES.noFirstAudioMs - now;
        reason = "NO_FIRST_AUDIO";
      }
    } else if (!u.isSourceComplete) {
      if (playing) return;
      delayMs = SPEECH_DEADLINES.midStreamStallMs;
      reason = u.source === "MODEL" ? "MID_STREAM_STALL" : "CACHED_TAIL_STALL";
    } else {
      if (!playing) return;
      delayMs = (this.playback?.queuedSeconds ?? 0) * 1000 + SPEECH_DEADLINES.drainSlackMs;
      reason = "PLAYBACK_STALLED";
    }

    this.speechWatchdog = setTimeout(() => {
      this.speechWatchdog = null;
      if (this.utterance !== u || u.terminal) return;
      // Re-check: a chunk may have landed between arming and firing.
      if (reason.endsWith("STALL") && this.playback?.isPlaying) {
        this.armWatchdog();
        return;
      }
      const unplayedSeconds = this.playback?.queuedSeconds ?? 0;
      this.playback?.stop();
      this.signal({ type: "FAIL", reason, unplayedSeconds });
    }, Math.max(0, delayMs));
  }

  private clearWatchdog(): void {
    if (this.speechWatchdog) clearTimeout(this.speechWatchdog);
    this.speechWatchdog = null;
  }

  /**
   * One place an utterance ends, whatever ended it. Releases its resources,
   * tells the server the truth, and tells the candidate when they missed
   * something — never silently.
   */
  private finishUtterance(u: UtteranceLifecycle, report: UtteranceReport): void {
    if (this.utterance !== u) return;
    this.utterance = null;
    this.clearWatchdog();
    this.emptyTurnAtMs = null;
    this.pendingFailure = null;
    this.cachedAbort?.abort();
    this.cachedAbort = null;
    if (this.pendingSpeech?.utteranceId === u.utteranceId) this.pendingSpeech = null;
    if (report.outcome !== "COMPLETED") this.playback?.stop();
    this.voice?.cancelSpeech();
    this.voice?.noteLocalPlayback(false);
    this.voice?.noteModelPlayback(false);
    this.finishedUtterances.push(u.utteranceId);
    if (this.finishedUtterances.length > 32) this.finishedUtterances.shift();
    if (this.status === "SPEAKING") this.setStatus("LISTENING");

    this.ledger.terminal(report, Date.now());
    this.reportOutcome(report);

    if (report.outcome !== "FAILED") return;
    const providerBroken =
      u.source === "MODEL" &&
      (report.reason === "NO_FIRST_AUDIO" || report.reason === "MID_STREAM_STALL");
    if (report.firstAudio) {
      // Do not replay a long answer on our own, or guess where playback
      // stopped. The candidate decides; a repeat request is gate-authorized.
      this.diagnose({ kind: "SPEECH_CUT_OFF", utteranceId: u.utteranceId, action: u.action, reason: report.reason });
      this.opts.onError?.(new Error(
        u.action === "DELIVER_BRIEF"
          ? "The problem statement was cut off. Say \"Can you repeat the problem?\" to hear it again."
          : "The interviewer's audio was cut off. Ask them to repeat if you missed something.",
      ));
    } else {
      this.diagnose({ kind: "SPEECH_FAILED", utteranceId: u.utteranceId, action: u.action, reason: report.reason });
      if (!providerBroken) {
        this.opts.onError?.(new Error(
          u.action === "DELIVER_BRIEF"
            ? "The problem didn't play. Trying again…"
            : "The interviewer's reply didn't come through. Ask again if you need it.",
        ));
        // A brief that never played is re-offered by the server on readiness.
        if (u.action === "DELIVER_BRIEF" && this.voice?.isReady) void this.postVoiceReady();
      }
    }
    if (providerBroken) {
      this.scheduleReconnect(new Error(
        u.action === "DELIVER_BRIEF" && !report.firstAudio
          ? "The problem didn't play. Reconnecting voice to try again…"
          : "The interviewer's audio stalled. Reconnecting voice…",
      ));
    }
  }

  /**
   * Tell the server how the utterance ended. Retried, because a lost report
   * leaves the server's authorization open, and an open authorization reads
   * to the gate as "interviewer still speaking" — muting every later turn.
   */
  private reportOutcome(report: UtteranceReport): void {
    const body = JSON.stringify({
      utteranceId: report.utteranceId,
      outcome: report.outcome,
      ...(report.reason ? { reason: report.reason } : {}),
      source: report.source,
      firstAudio: report.firstAudio,
      receivedAudioMs: report.receivedAudioMs,
      playedAudioMs: report.playedAudioMs,
      underruns: report.underruns,
      durationMs: report.durationMs,
    });
    const url = `${this.opts.apiBase}/v1/interview-sessions/${this.opts.sessionId}/voice-utterance-complete`;
    this.outcomeReports = this.outcomeReports.then(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const res = await apiFetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            keepalive: true,
          });
          // 4xx other than throttling is final: stale or unknown is an answer.
          if (res.ok || (res.status < 500 && res.status !== 429)) return;
        } catch {
          // Network failure: retry below.
        }
        await delay(300 * 3 ** attempt);
      }
      this.diagnose({ kind: "OUTCOME_REPORT_FAILED", utteranceId: report.utteranceId, reason: report.outcome });
    });
  }

  /**
   * Readiness, retried with backoff and reported honestly. Carries the
   * utterance this client is actually playing, so the server can tell a
   * reconnect mid-sentence (leave it alone) from a page that lost the turn
   * (close it, and re-offer a brief that never played).
   */
  private async postVoiceReady(): Promise<void> {
    const generation = ++this.readyGeneration;
    // An outcome still in flight must land first, or the server would see an
    // open authorization this client no longer holds.
    await this.outcomeReports;
    const url = `${this.opts.apiBase}/v1/interview-sessions/${this.opts.sessionId}/voice-ready`;
    let lastDetail = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (this.stopping || generation !== this.readyGeneration) return;
      try {
        const res = await apiFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            activeUtteranceId: this.utterance?.utteranceId ?? null,
            attempt,
          }),
        });
        if (res.ok) return;
        lastDetail = `HTTP ${res.status}`;
        // Ended or never started: retrying cannot help, and is not a fault.
        if (res.status === 404 || res.status === 409) return;
      } catch (err) {
        lastDetail = err instanceof Error ? err.message.slice(0, 120) : "network";
      }
      await delay(500 * 2 ** attempt);
    }
    if (this.stopping || generation !== this.readyGeneration) return;
    this.diagnose({ kind: "READY_FAILED", detail: lastDetail });
    this.opts.onError?.(new Error(
      "Couldn't reach the interview server to start the interviewer. Check your connection; voice will try again when it reconnects.",
    ));
  }

  private diagnose(entry: Omit<VoiceDiagnostic, "atMs">): void {
    const diagnostic: VoiceDiagnostic = { ...entry, atMs: Date.now() };
    this.diagnosticLog.push(diagnostic);
    if (this.diagnosticLog.length > 50) this.diagnosticLog.shift();
    this.opts.onDiagnostic?.(diagnostic);
  }

  private postLatencyReport(report: LatencyLedger): void {
    void apiFetch(
      `${this.opts.apiBase}/v1/interview-sessions/${this.opts.sessionId}/voice-latency`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report),
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
  speak(
    authorization: SpeechAuthorization,
    serverTiming?: {
      decisionMs?: number;
      classifierMs?: number;
      classifierSource?: string;
    },
  ): void {
    const id = authorization.utteranceId;
    // A duplicate ACTION (channel replay, reconnect) must not restart a turn
    // that is playing or replay one that already ended.
    if (this.utterance?.utteranceId === id || this.finishedUtterances.includes(id)) return;
    if (this.utterance) {
      // The server authorizes one utterance at a time, so a new id means the
      // old one is over as far as the server is concerned.
      const unplayedSeconds = this.playback?.queuedSeconds ?? 0;
      this.playback?.stop();
      this.signal({ type: "FAIL", reason: "SUPERSEDED", unplayedSeconds });
    }

    const now = Date.now();
    const u = new UtteranceLifecycle(
      id,
      authorization.action,
      authorization.audio ? "CACHED" : "MODEL",
      performance.now(),
    );
    this.utterance = u;
    this.speechWaitStartedAt = performance.now();
    this.emptyTurnAtMs = null;
    this.pendingFailure = null;
    this.ledger.authorized(
      id,
      authorization.action,
      authorization.audio ? "CACHED_AUDIO" : "REALTIME_MODEL",
      now,
    );
    if (serverTiming) {
      this.ledger.setServerTiming(
        serverTiming.decisionMs,
        serverTiming.classifierMs,
        serverTiming.classifierSource,
      );
    }

    // The first 400 ms ride on ACTION. Schedule them before any await or fetch;
    // this is the latency win that rendering on the server makes possible.
    if (authorization.audio && this.playback && this.context) {
      try {
        const audio = authorization.audio;
        const bytes = base64ToBytes(audio.head);
        const rate = audio.rate;
        if (
          bytes.length === 0 ||
          bytes.length % 2 !== 0 ||
          !Number.isFinite(rate) ||
          rate <= 0
        ) {
          throw new Error("invalid cached audio head");
        }
        const head = toPcm16(bytes, null).pcm;
        const startAt = this.playback.enqueueAt(head, rate);
        if (startAt === null) throw new Error("empty cached audio head");
        this.signal({ type: "AUDIO_RECEIVED", seconds: head.length / rate });
        this.signal({ type: "PLAYBACK_STARTED" });
        this.voice?.noteLocalPlayback(true);
        this.ledger.mark("firstAudioByteMs", now);
        this.ledger.firstSamplePlayed(this.firstSampleWallTime(startAt));
        this.setStatus("SPEAKING");
        if (audio.tailFrom !== undefined) {
          void this.streamCachedTail(u, audio.tailFrom, rate, audio.totalBytes);
        } else if (audio.totalBytes !== undefined && audio.totalBytes !== bytes.length) {
          // The server said there was more and offered no way to fetch it.
          this.failAfterDrain(u, "CACHED_HEAD_TRUNCATED");
        } else {
          this.signal({ type: "SOURCE_COMPLETE" });
        }
        return;
      } catch {
        // Nothing played yet, so the model can say it instead without
        // repeating a word. Past the first sample this would be a repeat.
        if (this.utterance !== u || !u.switchSource("MODEL")) return;
        this.ledger.setSource("REALTIME_MODEL");
      }
    } else if (authorization.audio) {
      u.switchSource("MODEL");
      this.ledger.setSource("REALTIME_MODEL");
    }

    if (this.voice?.isReady) {
      this.requestModelSpeech(u, authorization);
      return;
    }
    // Held for the next provider handshake, under a deadline of its own.
    this.pendingSpeech = authorization;
    this.armWatchdog();
  }

  private requestModelSpeech(u: UtteranceLifecycle, authorization: SpeechAuthorization): void {
    if (this.utterance !== u || u.terminal) return;
    if (!this.voice?.requestSpeech(authorization)) {
      this.pendingSpeech = authorization;
      this.armWatchdog();
      return;
    }
    this.speechWaitStartedAt = performance.now();
    this.ledger.mark("speechRequestedMs", Date.now());
    this.signal({ type: "REQUESTED" });
  }

  /** End after the already-queued prefix plays, as a failure — never a success. */
  private failAfterDrain(u: UtteranceLifecycle, reason: string): void {
    if (this.utterance !== u || u.terminal) return;
    if (this.playback?.isPlaying) {
      this.pendingFailure = reason;
      return;
    }
    this.signal({ type: "FAIL", reason });
  }

  /**
   * The rest of a pre-rendered utterance.
   *
   * Verified, not trusted: the stream must deliver exactly the bytes the
   * server said it would. A tail that dies or comes up short is a FAILED
   * utterance once its prefix finishes — not a COMPLETED one because the
   * queue happened to drain.
   */
  private async streamCachedTail(
    u: UtteranceLifecycle,
    fromByte: number,
    rate: number,
    totalBytes: number | undefined,
  ): Promise<void> {
    const controller = new AbortController();
    this.cachedAbort = controller;
    let carry: number | null = null;
    let received = 0;
    let reason = "CACHED_TAIL_FAILED";
    try {
      const query = new URLSearchParams({
        utteranceId: u.utteranceId,
        fromByte: String(fromByte),
      });
      this.ledger.mark("audioFetchStartedMs", Date.now());
      const response = await apiFetch(
        `${this.opts.apiBase}/v1/interview-sessions/${this.opts.sessionId}/voice-utterance-audio?${query}`,
        { signal: controller.signal },
      );
      if (!response.ok || !response.body)
        throw new Error(`cached audio HTTP ${response.status}`);
      const headerTotal = Number(response.headers.get("x-utterance-total-bytes"));
      const total = totalBytes ?? (Number.isFinite(headerTotal) && headerTotal > 0 ? headerTotal : undefined);
      const reader = response.body.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (controller.signal.aborted || this.utterance !== u) return;
        received += next.value.length;
        const decoded = toPcm16(next.value, carry);
        carry = decoded.remainder;
        if (decoded.pcm.length === 0) continue;
        this.signal({ type: "AUDIO_RECEIVED", seconds: decoded.pcm.length / rate });
        if (this.playback?.enqueueAt(decoded.pcm, rate) !== null) {
          this.signal({ type: "PLAYBACK_STARTED" });
          this.voice?.noteLocalPlayback(true);
        }
      }
      if (this.utterance !== u) return;
      if (carry !== null || (total !== undefined && fromByte + received !== total)) {
        reason = "CACHED_TAIL_TRUNCATED";
        throw new Error("cached audio tail truncated");
      }
      this.signal({ type: "SOURCE_COMPLETE" });
    } catch {
      // Aborted by us means the utterance already ended for another reason.
      if (controller.signal.aborted || this.utterance !== u) return;
      // Once the head played, restarting through the model would repeat it.
      // Let the queued prefix finish, then report the failure honestly.
      this.failAfterDrain(u, reason);
    } finally {
      if (this.cachedAbort === controller) this.cachedAbort = null;
    }
  }

  private scheduleFinalTranscriptFlush(afterMs: number): void {
    if (process.env.NEXT_PUBLIC_TRANSCRIPT_COALESCE === "off") return;
    if (this.finalTranscriptTimer) clearTimeout(this.finalTranscriptTimer);
    const delay = Math.max(afterMs, this.finalFlushNotBeforeMs - Date.now());
    this.finalTranscriptTimer = setTimeout(() => {
      this.finalTranscriptTimer = null;
      this.flushFinalTranscript();
    }, delay);
  }

  private flushFinalTranscript(): void {
    if (this.candidateSpeechOpen || this.finalTranscriptChunks.length === 0)
      return;
    const text = assembleTranscript(this.finalTranscriptChunks);
    this.finalTranscriptChunks.length = 0;
    if (!text) return;
    this.awaitingFinalTranscript = false;
    this.opts.onTranscript?.({ text, final: true });
    for (const settle of this.transcriptWaiters) settle();
    this.transcriptWaiters.clear();
  }


  private firstSampleWallTime(startAt: number): number {
    const context = this.context;
    if (!context) return Date.now();
    const latency = Number.isFinite(context.outputLatency)
      ? context.outputLatency
      : 0;
    return Date.now() + (startAt - context.currentTime + latency) * 1000;
  }

  setMuted(muted: boolean): void {
    this.mutedState = muted;
    this.voice?.setMuted(muted);
    // Mute the track too. Stopping frames at the VAD would still leave the
    // browser's capture indicator on, which reads as being recorded while muted.
    for (const track of this.stream?.getAudioTracks() ?? [])
      track.enabled = !muted;
  }

  /**
   * End the candidate's current audio turn and allow its authoritative provider
   * transcript to reach the app channel before the server seals the session.
   * The bound keeps a provider fault from trapping the completion button.
   */
  async finishInput(timeoutMs = 4_000): Promise<void> {
    if (
      this.stopping ||
      (!this.candidateSpeechOpen && !this.awaitingFinalTranscript)
    )
      return;

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
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.transcriptWaiters.delete(settle);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.readyGeneration += 1;
    this.clearWatchdog();
    if (this.finalTranscriptTimer) clearTimeout(this.finalTranscriptTimer);
    this.finalTranscriptTimer = null;
    this.finalTranscriptChunks.length = 0;
    this.roomTone?.stop();
    this.roomTone = null;
    if (this.deviceChangeListener) {
      navigator.mediaDevices?.removeEventListener(
        "devicechange",
        this.deviceChangeListener,
      );
      this.deviceChangeListener = null;
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.goAwayTimer) clearTimeout(this.goAwayTimer);
    this.goAwayTimer = null;
    this.playback?.stop();
    this.signal({ type: "CANCEL", reason: "SESSION_STOPPED" });
    this.voice?.disconnect();
    this.worklet?.disconnect();
    this.captureGain?.disconnect();

    for (const track of this.stream?.getTracks() ?? []) track.stop();
    await this.context?.close().catch(() => {});

    this.context = null;
    this.stream = null;
    this.worklet = null;
    this.captureGain = null;
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
    this.captureGain?.disconnect();
    this.source = null;
    this.worklet = null;
    this.captureGain = null;

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
    if (this.status === "FAILED" && this.voice?.isReady)
      this.setStatus("LISTENING");
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

    const live =
      this.stream
        ?.getAudioTracks()
        .some((track) => track.readyState === "live") ?? false;
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
        const stillPresent = speakers.some(
          (device) => device.deviceId === this.activeSinkId,
        );
        if (!stillPresent) {
          await context.setSinkId("");
          this.activeSinkId = undefined;
          this.opts.onError?.(
            new Error(
              "Your speaker disconnected. Audio moved to the default output.",
            ),
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
          ...(this.activeDeviceId
            ? { activeMicrophoneId: this.activeDeviceId }
            : {}),
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
      const detail =
        res.status === 503
          ? "Voice is not configured on the server."
          : `HTTP ${res.status}`;
      throw new Error(`could not obtain a voice credential: ${detail}`);
    }

    return (await res.json()) as VoiceCredential;
  }

  private async startCapture(
    context: AudioContext,
    stream: MediaStream,
  ): Promise<void> {
    const url = URL.createObjectURL(
      new Blob([CAPTURE_WORKLET], { type: "application/javascript" }),
    );
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
    // Keep capture in the active render graph even while output is silent.
    // A disconnected worklet can stop being pulled by the audio engine.
    const silentGain = context.createGain();
    silentGain.gain.value = 0;
    worklet.connect(silentGain);
    silentGain.connect(context.destination);
    this.captureGain = silentGain;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Live frames arrive as Blob in browsers and string in some environments. */
async function toText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return String(data);
}

function assembleTranscript(chunks: readonly string[]): string {
  let assembled = "";
  for (const chunk of chunks) {
    const next = chunk.trim();
    if (!next) continue;
    if (assembled && next.startsWith(assembled)) assembled = next;
    else if (!assembled.endsWith(next))
      assembled = [assembled, next].filter(Boolean).join(" ");
  }
  return assembled.slice(-800);
}

/** Decode the inline audio head without an async hop. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** PCM16 little-endian decoder that carries an odd byte between stream chunks. */
export function toPcm16(
  bytes: Uint8Array,
  carry: number | null,
): { pcm: Int16Array; remainder: number | null } {
  const length = bytes.length + (carry === null ? 0 : 1);
  const pcm = new Int16Array(Math.floor(length / 2));
  for (let i = 0; i < pcm.length; i += 1) {
    const low =
      i === 0 && carry !== null
        ? carry
        : (bytes[2 * i - (carry === null ? 0 : 1)] ?? 0);
    const high = bytes[2 * i + (carry === null ? 1 : 0)] ?? 0;
    const unsigned = low | (high << 8);
    pcm[i] = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
  }
  return {
    pcm,
    remainder: length % 2 ? (bytes[bytes.length - 1] ?? carry) : null,
  };
}
