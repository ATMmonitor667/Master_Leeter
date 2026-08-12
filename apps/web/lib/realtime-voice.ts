import { LIVE_INPUT_MIME, base64ToPcm16, encodeForLive } from "./audio";
import { Vad, type VadEvent } from "./vad";

/**
 * Gemini Live connection for the candidate's voice (M3-2).
 *
 * Transport-injected, exactly like `SessionClient`, so the behaviour that
 * matters is testable without a socket or a microphone. Everything browser-bound
 * — `getUserMedia`, the worklet, playback scheduling — lives in the shell above
 * this and does nothing but move buffers.
 *
 * ── The property this class exists to guarantee ────────────────────────────
 *
 * **There is no method here that can make the model speak.**
 *
 * On Gemini Live, audio is produced when the client sends `clientContent` with
 * `turnComplete: true`. This class never sends that message, under any input,
 * on any code path. Streaming candidate audio and sending activity boundaries
 * cannot produce speech, because M3-1 pinned
 * `automaticActivityDetection.disabled` into the credential itself — so activity
 * signals are observations, not requests.
 *
 * Response creation belongs to M3-5, driven by the Response Gate, and it will
 * arrive as a separate authorized call rather than a method on the object the
 * microphone feeds. That separation is invariant 1 expressed in class design:
 * the component holding the audio pipe is structurally incapable of triggering a
 * reply. `realtime-voice.test.ts` asserts it over every public method.
 *
 * ── What it reports upward ─────────────────────────────────────────────────
 *
 * Speech boundaries come from our own `Vad`, carry its onset timestamps, and are
 * handed to the caller to append to the session log as `SPEECH_STARTED` /
 * `SPEECH_STOPPED`. Those are the events M4-2 measures `silenceMs` between, and
 * they were the missing input that left its timing half unexercised.
 */

export interface RealtimeTransport {
  send(data: string): void;
  close(): void;
  readonly connected: boolean;
}

export interface RealtimeTransportHandlers {
  onOpen: () => void;
  onMessage: (raw: string) => void;
  onClose: () => void;
  onError: (err: Error) => void;
}

/** The shape POST /realtime-token returns. Narrowed to what the socket needs. */
export interface VoiceCredential {
  wsUrl: string;
  model: string;
  automaticActivityDetectionDisabled: true;
}

export type SpeechBoundary = { type: "SPEECH_STARTED" | "SPEECH_STOPPED"; atMs: number };

export interface RealtimeVoiceOptions {
  credential: VoiceCredential;
  connect: (handlers: RealtimeTransportHandlers) => RealtimeTransport;
  /** Capture rate of the incoming frames. Usually 48000. */
  captureRate: number;
  vad?: Vad;
  now?: () => number;
  /** Append these to the session event log — they drive M4-2. */
  onSpeechBoundary?: (boundary: SpeechBoundary) => void;
  /** Model audio, already decoded. The shell schedules playback. */
  onModelAudio?: (pcm: Int16Array) => void;
  /** The candidate spoke over the interviewer. Stop playback immediately. */
  onBargeIn?: () => void;
  onReady?: () => void;
  onError?: (err: Error) => void;
}

export class RealtimeVoice {
  private transport: RealtimeTransport | null = null;
  private readonly vad: Vad;
  private readonly now: () => number;

  private ready = false;
  private muted = false;
  /** True while model audio is arriving — the window in which barge-in applies. */
  private interviewerSpeaking = false;

  constructor(private readonly opts: RealtimeVoiceOptions) {
    this.vad = opts.vad ?? new Vad();
    this.now = opts.now ?? (() => Date.now());
  }

  get isReady(): boolean {
    return this.ready;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  connect(): void {
    // A credential that does not carry the silence constraint should never reach
    // a socket. M3-1 cannot mint one, so this is a guard against a hand-built or
    // tampered credential rather than against the server — and it fails loudly
    // instead of opening a session that might answer on its own.
    if (this.opts.credential.automaticActivityDetectionDisabled !== true) {
      throw new Error(
        "refusing to connect: credential does not disable automatic activity detection (ADR-001)",
      );
    }

    this.transport = this.opts.connect({
      onOpen: () => this.sendSetup(),
      onMessage: (raw) => this.handleMessage(raw),
      onClose: () => {
        this.ready = false;
        this.interviewerSpeaking = false;
      },
      onError: (err) => this.opts.onError?.(err),
    });
  }

  disconnect(): void {
    // Close the turn honestly. A session that goes away mid-sentence must not
    // leave the server believing the candidate is still talking, which would
    // hold the gate's floor forever.
    const closing = this.vad.reset(this.now());
    if (closing) this.emitBoundary({ type: "SPEECH_STOPPED", atMs: closing.atMs });

    this.ready = false;
    this.transport?.close();
    this.transport = null;
  }

  /**
   * Mute the microphone.
   *
   * Ends any open turn rather than simply dropping frames. Silence that arrives
   * because the mic is off is still silence the candidate is entitled to have
   * measured — but a turn left open would never end at all.
   */
  setMuted(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;

    if (muted) {
      const closing = this.vad.reset(this.now());
      if (closing) this.emitBoundary({ type: "SPEECH_STOPPED", atMs: closing.atMs });
    }
  }

  /**
   * Feed one capture frame.
   *
   * Runs the VAD on the same samples that go on the wire, so a boundary
   * timestamp and the audio it describes cannot disagree.
   */
  pushAudio(frame: Float32Array, atMs = this.now()): void {
    if (this.muted) return;

    const event = this.vad.push(frame, atMs);
    if (event) this.handleVadEvent(event);

    if (!this.ready || !this.transport?.connected) return;

    this.send({
      realtimeInput: {
        audio: { data: encodeForLive(frame, this.opts.captureRate), mimeType: LIVE_INPUT_MIME },
      },
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private sendSetup(): void {
    // Model only. The credential already pins generation config and
    // realtimeInputConfig, and constraints win over whatever the client asks
    // for — so restating them here would be decoration that could drift.
    this.send({ setup: { model: this.opts.credential.model } });
  }

  private handleVadEvent(event: VadEvent): void {
    if (event.type === "SPEECH_START") {
      // Barge-in is decided here rather than by the gate: by the time an event
      // reached the server the interviewer would have talked over the candidate
      // for a round trip. The gate's rule 1 still yields the floor; this stops
      // the audio.
      if (this.interviewerSpeaking) {
        this.interviewerSpeaking = false;
        this.opts.onBargeIn?.();
      }

      this.sendActivity("activityStart");
      this.emitBoundary({ type: "SPEECH_STARTED", atMs: event.atMs });
      return;
    }

    this.sendActivity("activityEnd");
    this.emitBoundary({ type: "SPEECH_STOPPED", atMs: event.atMs });
  }

  /**
   * Tell the model where the turn boundary is.
   *
   * Note what this is not: a request to reply. With automatic activity detection
   * disabled by the credential, `activityEnd` marks the end of an utterance and
   * nothing more. Only `clientContent` with `turnComplete` produces audio, and
   * this class never sends it (M3-5 owns that, under gate authorization).
   */
  private sendActivity(kind: "activityStart" | "activityEnd"): void {
    if (!this.ready || !this.transport?.connected) return;
    this.send({ realtimeInput: { [kind]: {} } });
  }

  private emitBoundary(boundary: SpeechBoundary): void {
    this.opts.onSpeechBoundary?.(boundary);
  }

  private send(message: Record<string, unknown>): void {
    this.transport?.send(JSON.stringify(message));
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // A frame we cannot parse is not evidence of anything. Dropping the
      // connection over one bad frame would cost the candidate their voice
      // channel for the rest of the session.
      return;
    }

    if (msg["setupComplete"] !== undefined || msg["setup_complete"] !== undefined) {
      this.ready = true;
      this.opts.onReady?.();
      return;
    }

    const error = msg["error"];
    if (error !== undefined) {
      this.opts.onError?.(new Error(`realtime error: ${JSON.stringify(error).slice(0, 300)}`));
      return;
    }

    const audio = extractModelAudio(msg);
    if (audio.length > 0) {
      this.interviewerSpeaking = true;
      for (const chunk of audio) this.opts.onModelAudio?.(base64ToPcm16(chunk));
    }

    const content = serverContent(msg);
    if (content?.["turnComplete"] === true || content?.["turn_complete"] === true) {
      this.interviewerSpeaking = false;
    }
  }
}

function serverContent(msg: Record<string, unknown>): Record<string, unknown> | undefined {
  return (msg["serverContent"] ?? msg["server_content"]) as Record<string, unknown> | undefined;
}

/** Both camelCase and snake_case appear on this API depending on the path. */
export function extractModelAudio(msg: Record<string, unknown>): string[] {
  const content = serverContent(msg);
  if (!content) return [];

  const turn = (content["modelTurn"] ?? content["model_turn"]) as
    | Record<string, unknown>
    | undefined;
  const parts = turn?.["parts"] as Array<Record<string, unknown>> | undefined;
  if (!parts) return [];

  const out: string[] = [];
  for (const part of parts) {
    const inline = (part["inlineData"] ?? part["inline_data"]) as
      | Record<string, unknown>
      | undefined;
    if (!inline) continue;

    const mime = String(inline["mimeType"] ?? inline["mime_type"] ?? "");
    const data = inline["data"];
    if (mime.includes("audio") && typeof data === "string") out.push(data);
  }

  return out;
}
