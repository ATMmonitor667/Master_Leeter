import { LIVE_INPUT_MIME, base64ToPcm16, encodeForLive } from "./audio";
import { BARGE_IN_VAD_CONFIG, Vad, frameDb, type VadEvent } from "./vad";

/**
 * Gemini Live transport and authorized playback lifecycle.
 * Manual activity detection controls input boundaries; it does not disable
 * provider generation or interruption. Only authorized utterances reach local
 * playback. Provider completion and audible completion are separate events.
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
}

/** A tool call from the model, on its way to the server relay. */
export interface VoiceToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** How an interviewer utterance ended. Mirrors the orchestrator's type. */
export type UtteranceOutcome = "COMPLETED" | "INTERRUPTED" | "FAILED";

/** What the controller below is allowed to touch. */
export interface InterruptionSink {
  /** Tell the model where the candidate's activity begins and ends. */
  sendActivity(kind: "activityStart" | "activityEnd"): void;
  /** Cancel the interviewer's current utterance, locally and on the wire. */
  stopPlayback(): void;
  /** Is the candidate hearing the interviewer right now? */
  interviewerAudible(): boolean;
}

/**
 * The single owner of interruption.
 *
 * Three things used to decide independently whether the interviewer stops
 * talking, and they disagreed:
 *
 *   1. `activityStart` on the wire, sent from the loose detector's SPEECH_START.
 *   2. Local playback cancellation, from the strict detector.
 *   3. Whether to keep enqueueing the chunks that arrive afterwards.
 *
 * The first is the one that was missed. Disabling automatic activity detection
 * stops the model *answering* on its own; it does not stop `activityStart`
 * interrupting a turn in progress, which is what the Live API says that message
 * means. So a cough cleared the loose detector's 9 dB for two frames, the wire
 * carried an interruption, Gemini cancelled generation — and playback carried
 * on locally because the strict detector had approved nothing. The interviewer
 * appeared to stop mid-word for no reason, which is the switching you hear.
 *
 * The rule this class enforces: **while the interviewer is audible, only the
 * strict detector may open an activity.** A probable start during playback is
 * discarded rather than sent; if the strict detector confirms it, the stop and
 * the `activityStart` happen together, from here, in that order. Outside
 * playback nothing has changed and activity still tracks the loose detector, so
 * onset capture for ordinary speech is unaffected.
 *
 * The cost, stated rather than hidden: on a genuine barge-in, the candidate's
 * first ~300 ms falls outside the activity window and the model may not hear
 * it. That is the price of not cutting out on every cough, and it is the right
 * side of the trade — a lost syllable is recoverable, an interviewer that
 * interrupts at random is not.
 */
export class InterruptionController {
  private activityOpen = false;
  private suppressedUtterance = false;

  constructor(private readonly sink: InterruptionSink) {}

  /** True while the remainder of an interrupted turn should be discarded. */
  get suppressing(): boolean {
    return this.suppressedUtterance;
  }

  /** True while the model has been told the candidate is talking. */
  get activityIsOpen(): boolean {
    return this.activityOpen;
  }

  /**
   * The loose detector thinks the candidate started speaking.
   *
   * Good enough to hold the floor and to log as evidence; not good enough to
   * interrupt anyone. During playback it is dropped entirely rather than
   * buffered — a start worth acting on will be confirmed 300 ms later, and a
   * start that is not confirmed was echo.
   */
  onProbableSpeechStart(): void {
    if (this.sink.interviewerAudible()) return;
    this.openActivity();
  }

  onProbableSpeechEnd(): void {
    this.closeActivity();
  }

  /** The strict detector confirms it. This is the only path to an interruption. */
  onConfirmedSpeechStart(): void {
    if (!this.sink.interviewerAudible()) {
      // Already open from the probable start in the ordinary case; this covers
      // the one where the interviewer stopped in between.
      this.openActivity();
      return;
    }

    this.suppressedUtterance = true;
    this.sink.stopPlayback();
    this.openActivity();
  }

  /** The model's turn is over, interrupted or not. Suppression lifts here only. */
  onUtteranceEnd(): void {
    this.suppressedUtterance = false;
  }

  /** Mute, disconnect, teardown. Closes an open activity honestly. */
  reset(): void {
    this.suppressedUtterance = false;
    this.closeActivity();
  }

  private openActivity(): void {
    if (this.activityOpen) return;
    this.activityOpen = true;
    this.sink.sendActivity("activityStart");
  }

  private closeActivity(): void {
    if (!this.activityOpen) return;
    this.activityOpen = false;
    this.sink.sendActivity("activityEnd");
  }
}

export interface RealtimeVoiceOptions {
  credential: VoiceCredential;
  connect: (handlers: RealtimeTransportHandlers) => RealtimeTransport;
  /** Capture rate of the incoming frames. Usually 48000. */
  captureRate: number;
  vad?: Vad;
  /** Barge-in detector. Deliberately deafer than `vad` — see BARGE_IN_VAD_CONFIG. */
  bargeVad?: Vad;
  now?: () => number;
  /**
   * Is model audio still coming out of the speakers?
   *
   * Supplied by the shell, because this class hands audio off and never learns
   * what happened to it. Without it, barge-in is judged by `interviewerSpeaking`
   * alone, which goes false on `turnComplete` — i.e. when *generation* ends,
   * seconds before playback does.
   */
  isPlaying?: () => boolean;
  /** Append these to the session event log — they drive M4-2. */
  onSpeechBoundary?: (boundary: SpeechBoundary) => void;
  /** Model audio, already decoded. The shell schedules playback. */
  onModelAudio?: (pcm: Int16Array) => void;
  /** The candidate spoke over the interviewer. Stop playback immediately. */
  onBargeIn?: (utteranceId: string | null) => void;
  onReady?: () => void;
  onError?: (err: Error) => void;
  /** The model finished generating. NOT the same as the candidate having heard it. */
  onSpeechComplete?: (utteranceId: string | null) => void;
  /**
   * The utterance died with the connection.
   *
   * Previously reported as nothing at all, which left the server's
   * authorization open forever and the gate believing the interviewer was still
   * speaking — so every later turn read as a barge-in and it never spoke again.
   */
  onSpeechFailed?: (utteranceId: string | null) => void;
  /**
   * Relays a tool call to the server and returns its result.
   *
   * The client never answers a tool call itself. The five tools read pinned
   * scenario content and check the gate's authorization, and neither of those
   * may live in a browser the candidate controls.
   */
  callTool?: (call: VoiceToolCall) => Promise<Record<string, unknown>>;
}

export class RealtimeVoice {
  private transport: RealtimeTransport | null = null;
  private readonly vad: Vad;
  private readonly bargeVad: Vad;
  private readonly now: () => number;

  private readonly interruptions: InterruptionController;

  private ready = false;
  private muted = false;
  /** True while model audio is arriving. */
  private interviewerSpeaking = false;
  /**
   * The utterance the gate authorized, while it is in flight.
   *
   * Null outside an utterance, and null in tests that push model audio without
   * an authorization. Every completion report is scoped by it so a late one
   * cannot close a newer authorization server-side.
   */
  private currentUtteranceId: string | null = null;
  private providerTurnOpen = false;
  private pendingAuthorization: SpeechAuthorization | null = null;
  /**
   * An utterance is in flight and has not yet been reported.
   *
   * Separate from `currentUtteranceId` because it must be true for model audio
   * that arrives without a client-side authorization, and because it is what
   * stops an interrupted turn being reported a second time when its
   * `turnComplete` finally lands.
   */
  private utteranceLive = false;

  constructor(private readonly opts: RealtimeVoiceOptions) {
    this.vad = opts.vad ?? new Vad();
    this.bargeVad = opts.bargeVad ?? new Vad(BARGE_IN_VAD_CONFIG);
    this.now = opts.now ?? (() => Date.now());
    this.interruptions = new InterruptionController({
      sendActivity: (kind) => this.sendActivity(kind),
      stopPlayback: () => this.reportUtterance("INTERRUPTED"),
      interviewerAudible: () => this.isInterviewerAudible(),
    });
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
        this.providerTurnOpen = false;
        this.pendingAuthorization = null;
        this.interviewerSpeaking = false;
        // A socket that goes away mid-utterance has to say so. Silence here is
        // what leaves the server's authorization open for the rest of the
        // session.
        this.reportUtterance("FAILED");
        this.interruptions.reset();
      },
      onError: (err) => {
        this.ready = false;
        this.pendingAuthorization = null;
        this.reportUtterance("FAILED");
        this.opts.onError?.(err);
      },
    });
  }

  disconnect(): void {
    this.ready = false;
    this.pendingAuthorization = null;
    this.providerTurnOpen = false;
    this.reportUtterance("FAILED");
    // Close the turn honestly. A session that goes away mid-sentence must not
    // leave the server believing the candidate is still talking, which would
    // hold the gate's floor forever.
    const closing = this.vad.reset(this.now());
    this.bargeVad.reset(this.now());
    this.interruptions.reset();
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
      this.bargeVad.reset(this.now());
      this.interruptions.reset();
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

    // One energy measurement, two detectors. Holding the floor and cutting the
    // interviewer off have opposite cost asymmetries, so they cannot share a
    // threshold — see BARGE_IN_VAD_CONFIG.
    const db = frameDb(frame);

    const event = this.vad.pushDb(db, atMs);
    if (event) this.handleVadEvent(event);

    if (this.bargeVad.pushDb(db, atMs)?.type === "SPEECH_START") {
      this.interruptions.onConfirmedSpeechStart();
    }

    if (!this.ready || !this.transport?.connected) return;

    this.send({
      realtimeInput: {
        audio: { data: encodeForLive(frame, this.opts.captureRate), mimeType: LIVE_INPUT_MIME },
      },
    });
  }

  /**
   * Ask the model to speak — the single path to audio, and the whole of M3-5.
   *
   * Explicit response requests originate here after server authorization.
   * Manual activity boundaries can also trigger provider behavior, so received
   * audio is separately gated on the current authorized utterance.
   *
   * Note what is NOT passed in: the words. The instruction names the authorized
   * action and tells the model to fetch its own wording from the tool surface,
   * which re-checks the same authorization server-side. So a tampered client
   * that called this unprompted would get a model that asks for a probe and is
   * refused — it cannot invent an interview turn, only waste a round trip.
   */
  requestSpeech(authorization: SpeechAuthorization): void {
    if (!this.ready || !this.transport?.connected) return;
    if (authorization.utteranceId === this.currentUtteranceId) return;
    // Provider messages do not carry our utterance IDs. Never relabel chunks
    // from an old generation as a newly authorized response.
    if (this.providerTurnOpen || this.currentUtteranceId) {
      this.pendingAuthorization = authorization;
      return;
    }

    // Remembered so the completion report can be scoped to it. Without this the
    // server cannot tell a stale report from a current one.
    this.currentUtteranceId = authorization.utteranceId;
    this.utteranceLive = true;
    this.providerTurnOpen = true;

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
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  markPlaybackFinished(utteranceId: string): void {
    if (this.currentUtteranceId !== utteranceId) return;
    this.currentUtteranceId = null;
    this.interviewerSpeaking = false;
    this.flushAuthorization();
  }

  private flushAuthorization(): void {
    if (this.providerTurnOpen || this.currentUtteranceId || !this.pendingAuthorization) return;
    const next = this.pendingAuthorization;
    this.pendingAuthorization = null;
    this.requestSpeech(next);
  }

  private sendSetup(): void {
    // Model only. The credential already pins generation config and
    // realtimeInputConfig, and constraints win over whatever the client asks
    // for — so restating them here would be decoration that could drift.
    this.send({ setup: { model: this.opts.credential.model } });
  }

  private handleVadEvent(event: VadEvent): void {
    // This detector owns evidence and nothing else. It is tuned to declare
    // speech early because a false start only holds the floor — which is right
    // for the session log and wrong for anything that interrupts. Whether the
    // wire hears about it is the controller's decision, not this one's.
    if (event.type === "SPEECH_START") {
      this.interruptions.onProbableSpeechStart();
      this.emitBoundary({ type: "SPEECH_STARTED", atMs: event.atMs });
      return;
    }

    this.interruptions.onProbableSpeechEnd();
    this.emitBoundary({ type: "SPEECH_STOPPED", atMs: event.atMs });
  }

  /**
   * Tell the model where the turn boundary is.
   *
   * These boundaries affect provider turn handling, including interruptions.
   * They must go through the interruption controller; disabling automatic
   * detection alone does not make them observational signals.
   */
  private sendActivity(kind: "activityStart" | "activityEnd"): void {
    if (!this.ready || !this.transport?.connected) return;
    this.send({ realtimeInput: { [kind]: {} } });
  }

  /**
   * Close out the utterance in flight, exactly once, with an outcome.
   *
   * Every path that ends an utterance comes through here: the model finishing,
   * the candidate interrupting, and the socket dying. `utteranceLive` makes it
   * idempotent, which matters most for the interrupted case — the model does
   * not know it was cut off and its `turnComplete` still arrives afterwards. If
   * that landed as a second report, an interrupted brief would be reported
   * COMPLETED a moment after being reported INTERRUPTED, and the interview
   * would advance on the strength of the later one.
   */
  private reportUtterance(outcome: UtteranceOutcome): void {
    if (!this.utteranceLive && !(outcome !== "COMPLETED" && this.currentUtteranceId)) return;

    this.utteranceLive = false;
    this.interviewerSpeaking = false;

    const utteranceId = this.currentUtteranceId;
    // Keep the ID through the audible tail so an interruption can supersede
    // generation completion until the shell acknowledges speaker drain.
    if (outcome !== "COMPLETED") this.currentUtteranceId = null;

    if (outcome === "INTERRUPTED") this.opts.onBargeIn?.(utteranceId);
    else if (outcome === "FAILED") this.opts.onSpeechFailed?.(utteranceId);
    else this.opts.onSpeechComplete?.(utteranceId);
  }

  /**
   * Is the candidate actually hearing the interviewer right now?
   *
   * `interviewerSpeaking` alone was the wrong test. It goes false on
   * `turnComplete`, which arrives when generation finishes, and chunks arrive
   * faster than real time — so barge-in was disabled for the last seconds of
   * every utterance, which is precisely the window in which someone interrupts.
   * The shell supplies the second half because only it knows what the speakers
   * are doing.
   */
  private isInterviewerAudible(): boolean {
    return this.interviewerSpeaking || (this.opts.isPlaying?.() ?? false);
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

    const responses: Array<Record<string, unknown>> = [];

    for (const call of calls) {
      const id = String(call["id"] ?? "");
      const name = String(call["name"] ?? "");
      const args = (call["args"] ?? {}) as Record<string, unknown>;

      let response: Record<string, unknown>;
      try {
        response = (await this.opts.callTool?.({ id, name, args })) ?? {
          ok: false,
          refusal: "NO_RELAY",
        };
      } catch {
        response = { ok: false, refusal: "RELAY_FAILED" };
      }

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
      this.opts.onReady?.();
      return;
    }

    const error = msg["error"];
    if (error !== undefined) {
      this.ready = false;
      this.pendingAuthorization = null;
      this.reportUtterance("FAILED");
      this.opts.onError?.(new Error(`realtime error: ${JSON.stringify(error).slice(0, 300)}`));
      return;
    }

    const toolCall = msg["toolCall"] ?? msg["tool_call"];
    if (toolCall) {
      void this.relayToolCall(toolCall as Record<string, unknown>);
      return;
    }

    // Chunks from a barged-in turn are decoded nowhere and played nowhere. They
    // keep arriving until the model finishes the turn it does not know was
    // interrupted; the only correct thing to do with them is drop them.
    const audio = extractModelAudio(msg);
    if (audio.length > 0 && this.currentUtteranceId && !this.interruptions.suppressing) {
      this.interviewerSpeaking = true;
      // Ignore unsolicited provider output outside an authorized utterance.
      this.utteranceLive = true;
      for (const chunk of audio) this.opts.onModelAudio?.(base64ToPcm16(chunk));
    }

    const content = serverContent(msg);
    if (content?.["interrupted"] === true) {
      this.reportUtterance("INTERRUPTED");
    }
    if (content?.["turnComplete"] === true || content?.["turn_complete"] === true) {
      // Suppression lifts here and only here: this is the one signal that the
      // turn the candidate interrupted is genuinely finished generating.
      this.providerTurnOpen = false;
      this.interruptions.onUtteranceEnd();
      this.reportUtterance("COMPLETED");
      this.flushAuthorization();
    }
  }
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
    GIVE_HINT_L1: "Give the authorized hint. Say only the wording you are given.",
    GIVE_HINT_L2: "Give the authorized hint. Say only the wording you are given.",
    PRESENT_FOLLOW_UP: "Present the follow-up. Call get_follow_up and say what it returns.",
    ACKNOWLEDGE_BRIEFLY: "Acknowledge in three words or fewer. Add nothing.",
    DELIVER_BRIEF:
      "Call get_interview_context and deliver openingScript in full, exactly as written, from " +
      "the first word to the last. It runs longer than two sentences; that is expected here and " +
      "the length rule does not apply to it. Do not summarise it or stop early.",
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
