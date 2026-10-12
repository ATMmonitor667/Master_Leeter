import { LIVE_INPUT_MIME, base64ToPcm16, encodeForLive } from "./audio";
import { Vad, frameDb, DEFAULT_VAD_CONFIG, type VadEvent } from "./vad";

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
 * **Exactly one method can make the model speak, and it takes an authorization.**
 *
 * On Gemini Live, audio is produced when the client sends `clientContent` with
 * `turnComplete: true`. That message is sent from `requestSpeech` and nowhere
 * else. Streaming candidate audio and sending activity boundaries cannot produce
 * a reply at all, because M3-1 pinned `automaticActivityDetection.disabled` into
 * the credential — activity signals are observations, not requests.
 *
 * Until M3-5 this class had no such method and this comment said so. It now has
 * one, which is a genuine narrowing of the guarantee and worth stating rather
 * than leaving a claim that has quietly become false. What replaces it is
 * smaller but still structural, and it holds in two places at once:
 *
 *   - `requestSpeech` takes a `SpeechAuthorization` carrying a server-minted
 *     `utteranceId`. The client cannot manufacture one.
 *   - It sends no wording. The instruction names the authorized action and tells
 *     the model to fetch its own words from the tool surface, which re-checks
 *     that same authorization SERVER-side.
 *
 * So a tampered client calling `requestSpeech` unprompted gets a model that asks
 * for a probe and is refused. It can waste a round trip; it cannot invent an
 * interview turn. `realtime-voice.test.ts` asserts every other method remains
 * incapable of producing `turnComplete`.
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

export type SpeechBoundary = {
  type: "SPEECH_STARTED" | "SPEECH_STOPPED";
  atMs: number;
  prosody?: { probability: number; confidence: number; reason: string };
  interimTranscript?: string;
};

/**
 * An authorization from the server, and the ONLY thing that can produce speech.
 *
 * Deliberately not constructible from anything the client knows on its own: it
 * carries an `utteranceId` the server minted when the gate authorized, so
 * "speak now" is always something that was granted rather than decided here.
 */
export interface SpeechAuthorization {
  action: string;
  utteranceId: string;
  /**
   * Pre-rendered audio head from the server (P3).
   *
   * When present, the client schedules this synchronously, cutting the
   * decision-to-first-audio path from ~1.5 s to ~50 ms. The model is not
   * asked to speak and the tool relay is skipped entirely.
   */
  audio?: {
    head: string;
    rate: number;
    tailFrom?: number | undefined;
    /** Full PCM length. The client verifies the tail against it. */
    totalBytes?: number | undefined;
  };
}

/** A tool call from the model, on its way to the server relay. */
export interface VoiceToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface RealtimeVoiceOptions {
  credential: VoiceCredential;
  connect: (handlers: RealtimeTransportHandlers) => RealtimeTransport;
  /** Capture rate of the incoming frames. Usually 48000. */
  captureRate: number;
  vad?: Vad;
  now?: () => number;
  /** Append these to the session event log — they drive M4-2. */
  onSpeechBoundary?: (boundary: SpeechBoundary) => void;
  /**
   * Model audio, already decoded, tagged with the utterance it was requested
   * for. The shell schedules playback and drops audio for any other utterance.
   */
  onModelAudio?: (pcm: Int16Array, utteranceId: string | null) => void;
  /** Candidate transcription emitted from the same provider audio stream. */
  onInputTranscript?: (transcript: { text: string; final: boolean }) => void;
  /** The candidate spoke over the interviewer. Stop playback immediately. */
  onBargeIn?: () => void;
  /** Interviewer audio ducks immediately, then either resumes or stops. */
  onBargeInProvisional?: (ducked: boolean) => void;
  onReady?: () => void;
  /** Latest opaque handle for continuing this logical provider session. */
  onResumptionHandle?: (handle: string) => void;
  /** Provider connection will close after this many milliseconds. */
  onGoAway?: (timeLeftMs: number) => void;
  /** The provider socket closed and a fresh short-lived credential is required. */
  onDisconnected?: () => void;
  onError?: (err: Error) => void;
  /**
   * The provider finished GENERATING a turn. Not playback completion: queued
   * audio may still be playing, and `hadAudio: false` means it produced none.
   */
  onSpeechComplete?: (info: { utteranceId: string | null; hadAudio: boolean }) => void;
  /**
   * Relays a tool call to the server and returns its result.
   *
   * The client never answers a tool call itself. The five tools read pinned
   * scenario content and check the gate's authorization, and neither of those
   * may live in a browser the candidate controls. The signal aborts when the
   * deadline passes or the turn it belonged to is cancelled.
   */
  callTool?: (call: VoiceToolCall, signal?: AbortSignal) => Promise<Record<string, unknown>>;
  /** Timing of each relayed tool call, for the latency trace. */
  onToolCall?: (info: { name: string; ms: number; ok: boolean; refusal?: string }) => void;
  /** Deadline for one relayed tool call. A model left waiting stalls the turn. */
  toolTimeoutMs?: number;
}

/** Longest candidate audio held while deciding whether they interrupted. */
const DEFERRED_PREROLL_SECONDS = 1.5;
/** Normal manual-VAD look-back before an activity boundary. */
const PREROLL_SECONDS = 0.16;
/** Sustained voiced audio that turns a provisional interruption into a real one. */
const BARGE_CONFIRM_MS = 400;

export class RealtimeVoice {
  private transport: RealtimeTransport | null = null;
  private readonly vad: Vad;
  private readonly now: () => number;

  private ready = false;
  private muted = false;
  /** True while model audio is arriving — the window in which barge-in applies. */
  private interviewerSpeaking = false;
  /** False after barge-in: drops any model audio still in transit. */
  private acceptingModelAudio = false;
  private localPlaybackActive = false;
  private modelPlaybackActive = false;
  private inputActivityOpen = false;
  private readonly preSpeechFrames: Float32Array[] = [];
  private preSpeechSamples = 0;
  private provisionalBargeAtMs: number | null = null;
  /**
   * Requested, and the provider has not yet finished generating with audio.
   * During this window an `activityStart` would cut the provider off, so a
   * possible interruption is held locally until it is confirmed.
   */
  private modelGenerating = false;
  private modelAudioThisTurn = false;
  private requestUtteranceId: string | null = null;
  /**
   * Bumped whenever the current request is replaced, cancelled or loses its
   * socket. A tool result that resolves under an older epoch is discarded
   * rather than handed to a model that is now doing something else.
   */
  private speechEpoch = 0;
  /** SPEECH_START happened but its provider boundary is held pending confirmation. */
  private deferredActivity = false;
  private readonly toolAborts = new Set<AbortController>();
  private readonly toolTimeoutMs: number;

  constructor(private readonly opts: RealtimeVoiceOptions) {
    this.vad = opts.vad ?? new Vad();
    this.now = opts.now ?? (() => Date.now());
    this.toolTimeoutMs = opts.toolTimeoutMs ?? 8_000;
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
        this.inputActivityOpen = false;
        this.deferredActivity = false;
        this.invalidateRequest();
        this.clearPreSpeech();
        this.interviewerSpeaking = this.localPlaybackActive || this.modelPlaybackActive;
        this.acceptingModelAudio = false;
        this.endProvisionalBarge();
        this.opts.onDisconnected?.();
      },
      onError: (err) => this.opts.onError?.(err),
    });
  }

  disconnect(): void {
    this.endProvisionalBarge();
    // Close the turn honestly. A session that goes away mid-sentence must not
    // leave the server believing the candidate is still talking, which would
    // hold the gate's floor forever.
    const closing = this.vad.reset(this.now());
    if (closing) {
      // Manual VAD means the provider cannot infer that the last audio frame was
      // the end of the turn. Close it before the socket so a final transcript
      // still has a chance to arrive during an orderly shutdown.
      this.closeInputActivity();
      this.emitBoundary({ type: "SPEECH_STOPPED", atMs: closing.atMs, ...boundaryProsody(closing) });
    }

    this.invalidateRequest();
    this.deferredActivity = false;
    this.ready = false;
    this.inputActivityOpen = false;
    this.clearPreSpeech();
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
      this.clearPreSpeech();
      this.endProvisionalBarge();
      const closing = this.vad.reset(this.now());
      if (closing) {
        this.closeInputActivity();
        this.emitBoundary({ type: "SPEECH_STOPPED", atMs: closing.atMs, ...boundaryProsody(closing) });
      }
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

    // Manual VAD has no provider-side look-back. Keep only 160 ms locally,
    // then send it AFTER activityStart, so the first consonant is preserved.
    // While a possible interruption is being confirmed, keep up to 1.5 s.
    if (!this.inputActivityOpen) this.bufferPreSpeech(frame);

    const event = this.vad.push(frame, atMs, this.opts.captureRate);
    if (event) this.handleVadEvent(event);
    this.resolveProvisionalBarge(frame, atMs);

    if (!this.ready || !this.transport?.connected || !this.inputActivityOpen) return;
    // The start frame was already included in the pre-roll flush.
    if (event?.type !== "SPEECH_START") this.sendAudio(frame);
  }

  private sendAudio(frame: Float32Array): void {
    this.send({
      realtimeInput: {
        audio: { data: encodeForLive(frame, this.opts.captureRate), mimeType: LIVE_INPUT_MIME },
      },
    });
  }

  private bufferPreSpeech(frame: Float32Array): void {
    const seconds = this.deferredActivity ? DEFERRED_PREROLL_SECONDS : PREROLL_SECONDS;
    const limit = Math.ceil(this.opts.captureRate * seconds);
    const copy = frame.slice(-limit);
    this.preSpeechFrames.push(copy);
    this.preSpeechSamples += copy.length;
    while (this.preSpeechFrames.length > 1 && this.preSpeechSamples > limit) {
      this.preSpeechSamples -= this.preSpeechFrames.shift()!.length;
    }
  }

  private clearPreSpeech(): void {
    this.preSpeechFrames.length = 0;
    this.preSpeechSamples = 0;
  }

  /**
   * Ask the model to speak — the single path to audio, and the whole of M3-5.
   *
   * Everything else in this class streams audio and reports boundaries, none of
   * which can produce a reply, because the credential disables automatic
   * activity detection. `clientContent` with `turnComplete` is the only message
   * Gemini answers, it is sent here and nowhere else, and it is sent only when
   * the server has said the gate authorized it.
   *
   * Note what is NOT passed in: the words. The instruction names the authorized
   * action and tells the model to fetch its own wording from the tool surface,
   * which re-checks the same authorization server-side. So a tampered client
   * that called this unprompted would get a model that asks for a probe and is
   * refused — it cannot invent an interview turn, only waste a round trip.
   */
  requestSpeech(authorization: SpeechAuthorization): boolean {
    if (!this.ready || !this.transport?.connected) return false;

    this.invalidateRequest();
    this.acceptingModelAudio = true;
    this.modelGenerating = true;
    this.modelAudioThisTurn = false;
    this.requestUtteranceId = authorization.utteranceId;
    this.send({
      clientContent: {
        turns: [
          {
            role: "user",
            parts: [{ text: instructionFor(authorization) }],
          },
        ],
        turnComplete: true,
      },
    });
    return true;
  }

  /**
   * Stop listening for the current request: its audio, its tool calls, its
   * completion. Called when an utterance ends any way other than naturally,
   * and harmless after a natural ending. The provider may keep generating for
   * a moment; whatever it sends is discarded here rather than played.
   */
  cancelSpeech(): void {
    this.invalidateRequest();
    this.interviewerSpeaking = this.localPlaybackActive || this.modelPlaybackActive;
    this.afterInterviewerChange();
  }

  /** Cached speech is already gate-authorized; this only enables local barge-in. */
  noteLocalPlayback(active: boolean): void {
    this.localPlaybackActive = active;
    this.interviewerSpeaking = active || this.modelPlaybackActive;
    this.afterInterviewerChange();
  }

  /** Provider completion can precede audible completion by several seconds. */
  noteModelPlayback(active: boolean): void {
    this.modelPlaybackActive = active;
    this.interviewerSpeaking = active || this.localPlaybackActive;
    this.afterInterviewerChange();
  }

  private invalidateRequest(): void {
    this.speechEpoch += 1;
    this.acceptingModelAudio = false;
    this.modelGenerating = false;
    this.modelAudioThisTurn = false;
    this.requestUtteranceId = null;
    for (const controller of this.toolAborts) controller.abort();
    this.toolAborts.clear();
  }

  /**
   * The interviewer may have just gone quiet. A held interruption is then no
   * longer an interruption — it is the candidate talking, and their provider
   * boundary opens now so the words are transcribed.
   */
  private afterInterviewerChange(): void {
    if (this.interviewerSpeaking || this.modelGenerating) return;
    if (this.deferredActivity) {
      this.deferredActivity = false;
      if (this.vad.isSpeaking && !this.muted) this.openInputActivity();
      else this.clearPreSpeech();
    }
    this.endProvisionalBarge();
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
      //
      // It starts PROVISIONAL for every source: duck, and confirm only on
      // sustained voice or an explicit "stop". A cough, a keyboard clack or an
      // "mm-hm" must not cancel the problem statement.
      if (this.interviewerSpeaking || this.modelGenerating) {
        this.provisionalBargeAtMs = event.atMs;
        this.opts.onBargeInProvisional?.(true);
        if (this.modelGenerating) {
          // Under manual VAD, activityStart interrupts the provider's
          // generation. Sending it for a cough would kill the answer, so the
          // boundary waits for confirmation and the audio is held locally.
          this.deferredActivity = true;
          this.emitBoundary({ type: "SPEECH_STARTED", atMs: event.atMs });
          return;
        }
      }

      this.openInputActivity();
      this.emitBoundary({ type: "SPEECH_STARTED", atMs: event.atMs });
      return;
    }

    this.endProvisionalBarge();
    this.closeInputActivity();
    this.emitBoundary({ type: "SPEECH_STOPPED", atMs: event.atMs, ...boundaryProsody(event) });
  }

  private openInputActivity(): void {
    this.sendActivity("activityStart");
    if (this.inputActivityOpen) {
      for (const frame of this.preSpeechFrames) this.sendAudio(frame);
    }
    this.clearPreSpeech();
  }

  /** End the provider boundary, unless it was never opened because it was held. */
  private closeInputActivity(): void {
    if (this.deferredActivity) {
      this.deferredActivity = false;
      this.clearPreSpeech();
      return;
    }
    this.sendActivity("activityEnd");
  }

  private resolveProvisionalBarge(frame: Float32Array, atMs: number): void {
    const start = this.provisionalBargeAtMs;
    if (start === null) return;
    // VAD stays open during its quiet hangover. Confirm only on voiced audio.
    if (frameDb(frame) < this.vad.noiseFloor + DEFAULT_VAD_CONFIG.continueMarginDb) {
      this.provisionalBargeAtMs = atMs;
      return;
    }
    if (atMs - start < BARGE_CONFIRM_MS) return;
    this.confirmBargeIn();
  }

  private confirmBargeIn(): void {
    if (this.provisionalBargeAtMs === null) return;
    this.provisionalBargeAtMs = null;
    this.localPlaybackActive = false;
    this.modelPlaybackActive = false;
    this.interviewerSpeaking = false;
    this.invalidateRequest();
    // The candidate really is talking. Open the boundary that was held and
    // send what they said while we were deciding, so no words are lost.
    if (this.deferredActivity) {
      this.deferredActivity = false;
      if (this.vad.isSpeaking && !this.muted) this.openInputActivity();
      else this.clearPreSpeech();
    }
    this.opts.onBargeIn?.();
  }

  private endProvisionalBarge(): void {
    if (this.provisionalBargeAtMs === null) return;
    this.provisionalBargeAtMs = null;
    this.opts.onBargeInProvisional?.(false);
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
    if (kind === "activityEnd") this.inputActivityOpen = false;
    if (!this.ready || !this.transport?.connected) return;
    this.send({ realtimeInput: { [kind]: {} } });
    this.inputActivityOpen = kind === "activityStart";
  }

  private emitBoundary(boundary: SpeechBoundary): void {
    this.opts.onSpeechBoundary?.(boundary);
  }

  /**
   * Forward a tool call to the server and return its answer to the model.
   *
   * Failures answer with a refusal rather than silence: a model left waiting on
   * a function response stalls the turn, and a stalled turn is indistinguishable
   * from the interviewer having decided to say nothing.
   */
  private async relayToolCall(toolCall: Record<string, unknown>): Promise<void> {
    const calls = (toolCall["functionCalls"] ?? toolCall["function_calls"]) as
      | Array<Record<string, unknown>>
      | undefined;
    if (!calls) return;

    // A result is only worth sending to the request that asked for it, on the
    // socket that asked for it. Anything else is a late answer to a turn that
    // was cancelled, replaced or reconnected away.
    const epoch = this.speechEpoch;
    const transport = this.transport;
    const responses: Array<Record<string, unknown>> = [];

    for (const call of calls) {
      const id = String(call["id"] ?? "");
      const name = String(call["name"] ?? "");
      const args = (call["args"] ?? {}) as Record<string, unknown>;

      const controller = new AbortController();
      this.toolAborts.add(controller);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.toolTimeoutMs);
      const startedAt = this.now();

      let response: Record<string, unknown>;
      try {
        const relay = this.opts.callTool?.({ id, name, args }, controller.signal);
        response = (relay ? await untilAborted(relay, controller.signal) : null) ?? {
          ok: false,
          refusal: "NO_RELAY",
        };
      } catch {
        response = { ok: false, refusal: timedOut ? "TOOL_TIMEOUT" : "RELAY_FAILED" };
      } finally {
        clearTimeout(timer);
        this.toolAborts.delete(controller);
      }

      if (epoch !== this.speechEpoch || transport !== this.transport) return;

      const refusal = typeof response["refusal"] === "string" ? response["refusal"] : undefined;
      this.opts.onToolCall?.({
        name,
        ms: Math.max(0, this.now() - startedAt),
        ok: response["ok"] !== false,
        ...(refusal ? { refusal } : {}),
      });
      responses.push({ id, name, response });
    }

    this.send({ toolResponse: { functionResponses: responses } });
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
      // Speech may have begun while the socket was handshaking. Re-open its
      // provider boundary before sending samples, without duplicating the log.
      if (this.vad.isSpeaking && !this.muted) {
        this.sendActivity("activityStart");
        for (const frame of this.preSpeechFrames) this.sendAudio(frame);
        this.clearPreSpeech();
      }
      this.opts.onReady?.();
      return;
    }

    const error = msg["error"];
    if (error !== undefined) {
      this.opts.onError?.(new Error(`realtime error: ${JSON.stringify(error).slice(0, 300)}`));
      return;
    }

    const resumption = (msg["sessionResumptionUpdate"] ?? msg["session_resumption_update"]) as
      | Record<string, unknown>
      | undefined;
    if (resumption) {
      const handle = resumption["newHandle"] ?? resumption["new_handle"] ?? resumption["token"];
      if (resumption["resumable"] !== false && typeof handle === "string" && handle.length > 0) {
        this.opts.onResumptionHandle?.(handle);
      }
      return;
    }

    const goAway = (msg["goAway"] ?? msg["go_away"]) as Record<string, unknown> | undefined;
    if (goAway) {
      this.opts.onGoAway?.(durationMs(goAway["timeLeft"] ?? goAway["time_left"]));
      return;
    }

    const toolCall = msg["toolCall"] ?? msg["tool_call"];
    if (toolCall) {
      void this.relayToolCall(toolCall as Record<string, unknown>);
      return;
    }

    const audio = extractModelAudio(msg);
    if (audio.length > 0 && this.acceptingModelAudio) {
      this.interviewerSpeaking = true;
      this.modelAudioThisTurn = true;
      for (const chunk of audio) {
        this.opts.onModelAudio?.(base64ToPcm16(chunk), this.requestUtteranceId);
      }
    }

    const content = serverContent(msg);
    if (content?.["interrupted"] === true && this.acceptingModelAudio && !this.localPlaybackActive) {
      this.interviewerSpeaking = false;
      this.invalidateRequest();
      this.opts.onBargeIn?.();
    }
    const interimTranscript = content?.["interimInputTranscription"] ?? content?.["interim_input_transcription"];
    const finalTranscript = content?.["inputTranscription"] ?? content?.["input_transcription"];
    const interimText = transcriptText(interimTranscript);
    const finalText = transcriptText(finalTranscript);
    if (this.provisionalBargeAtMs !== null && /\b(wait|sorry|no|hold on|actually|excuse me|stop)\b/i.test(interimText || finalText)) {
      this.confirmBargeIn();
    }
    if (interimText) this.opts.onInputTranscript?.({ text: interimText, final: false });
    if (finalText) this.opts.onInputTranscript?.({ text: finalText, final: true });

    if (content?.["turnComplete"] === true || content?.["turn_complete"] === true) {
      const hadAudio = this.modelAudioThisTurn;
      const utteranceId = this.requestUtteranceId;
      // A turn that ends with no audio stays open: the shell gives it a short
      // grace period and then reports an empty response, rather than this
      // class deciding that nothing was a delivery.
      if (hadAudio || !this.modelGenerating) {
        this.acceptingModelAudio = false;
        this.modelGenerating = false;
      }
      this.interviewerSpeaking = this.localPlaybackActive || this.modelPlaybackActive;
      this.opts.onSpeechComplete?.({ utteranceId, hadAudio });
      this.afterInterviewerChange();
    }
  }
}

/** Resolve with the relay, or reject the moment its signal aborts. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function boundaryProsody(event: VadEvent): Pick<SpeechBoundary, "prosody"> {
  if (!event.prosody) return {};
  const { probability, confidence, reason } = event.prosody;
  return { prosody: { probability, confidence, reason: reason.slice(0, 200) } };
}

function transcriptText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const text = (value as Record<string, unknown>)["text"];
  return typeof text === "string" ? text.trim() : "";
}

function durationMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value * 1_000);
  if (typeof value !== "string") return 0;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  return match?.[1] ? Math.max(0, Number(match[1]) * 1_000) : 0;
}

/**
 * What the model is told when it is authorized to speak.
 *
 * Names the action and points at the tool. It deliberately does not contain the
 * wording, a summary of the wording, or anything from the scenario — the whole
 * reason the relay exists is that authored content stays server-side until the
 * model fetches it under a check.
 */
export function instructionFor(authorization: SpeechAuthorization): string {
  const map: Record<string, string> = {
    ANSWER_CLARIFICATION:
      "Answer the candidate's question using get_clarification_fact. Say only what it returns.",
    ASK_PROBE: "Ask the authorized probe. Call get_probe_wording and say what it returns.",
    GIVE_HINT_L1: "Give the authorized hint. Call get_hint_wording and say what it returns.",
    GIVE_HINT_L2: "Give the authorized hint. Call get_hint_wording and say what it returns.",
    PRESENT_FOLLOW_UP: "Present the follow-up. Call get_follow_up and say what it returns.",
    ACKNOWLEDGE_BRIEFLY: "Acknowledge in three words or fewer. Add nothing.",
    DELIVER_BRIEF: "Call get_interview_context and read the complete openingScript verbatim. Read every sentence, including the actual coding task. Do not summarize, add a greeting, or invent a problem count. If openingScript is missing, say you couldn't load the problem and ask the candidate to request a repeat.",
    END_INTERVIEW: "Close the interview in one sentence. No assessment.",
  };

  const instruction = map[authorization.action] ?? "Say nothing.";
  return `[${authorization.utteranceId}] ${instruction}`;
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
