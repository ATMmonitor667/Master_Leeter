import { codeContext, cueText, type CueKind, type LiveCredential, type LiveEvent, type Speaker } from "@master-leeter/contracts";
import { AudioIO } from "./audio-io";
import { GeminiLive } from "./gemini-live";
import { LatencyTracker, type LatencyStats } from "./latency";
import type { LiveProvider } from "./provider";

/**
 * One live voice interview, from the browser's side.
 *
 * The realtime model runs the conversation. This class only:
 *   - connects the microphone and speaker to it,
 *   - pushes short text items so the model has "eyes" ([CODE], [RUN], cues),
 *   - collects what both sides said and uploads it for the report,
 *   - reconnects when the provider rotates the connection.
 *
 * It makes no decision about whether the interviewer speaks.
 */

export type LiveStatus = "idle" | "connecting" | "ready" | "listening" | "thinking" | "speaking" | "reconnecting" | "failed";

export interface TranscriptLine { id: string; speaker: Speaker; text: string }

export interface LiveState {
  status: LiveStatus;
  started: boolean;
  muted: boolean;
  lines: TranscriptLine[];
  /** What is being said right now, before it is final. */
  caption: { speaker: Speaker; text: string } | null;
  error: string | null;
  /** A reply was requested and no audio arrived within 4 s. */
  stalled: boolean;
  latency: LatencyStats;
}

export interface LiveSessionDeps {
  mint(resumptionHandle?: string): Promise<LiveCredential>;
  upload(events: LiveEvent[]): Promise<void>;
  /** Supportive interviewers react to test results; the others only take note. */
  reactToRuns: boolean;
  initialLines?: TranscriptLine[];
  started?: boolean;
  createProvider?: (events: ConstructorParameters<typeof GeminiLive>[0]) => LiveProvider;
}

const STALL_MS = 4_000;
const QUIET_MS = 90_000;
const CODE_IDLE_MS = 5_000;
/** Covers the provider's roughly one-new-connection-per-minute limit. */
const RECONNECT_DELAYS_MS = [0, 3_000, 8_000, 15_000, 30_000, 30_000, 30_000];

const newId = () => crypto.randomUUID();
const stamp = () => new Date().toISOString();

export class LiveSession {
  private state: LiveState;
  private readonly listeners = new Set<(state: LiveState) => void>();
  private readonly audio: AudioIO;
  private provider: LiveProvider | null = null;
  private readonly latency = new LatencyTracker();
  private handle: string | undefined;
  private disposed = false;
  private deviceId: string | undefined;

  private userText = "";
  private modelText = "";
  private modelTurnOpen = false;
  private userTimer: ReturnType<typeof setTimeout> | null = null;
  private thinkTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCue: { kind: CueKind; n?: number } | null = null;

  private code: { revision: number; text: string } | null = null;
  private sentRevision = -1;
  private loggedRevision = -1;
  private codeTimer: ReturnType<typeof setTimeout> | null = null;

  private outbox: LiveEvent[] = [];
  private uploading = false;
  private readonly ticker: ReturnType<typeof setInterval>;
  private lastActivityAt = Date.now();
  private quietCues = 0;
  private reconnecting = false;

  constructor(private readonly deps: LiveSessionDeps) {
    this.state = {
      status: "idle", started: deps.started ?? false, muted: false, lines: deps.initialLines ?? [],
      caption: null, error: null, stalled: false, latency: this.latency.stats(),
    };
    this.audio = new AudioIO({
      frame: (base64) => this.provider?.sendAudio(base64),
      playing: (active) => {
        if (active) this.lastActivityAt = Date.now();
        this.refreshStatus();
      },
      microphoneLost: () => this.fail("The microphone was disconnected. Reconnect it and press Retry."),
    });
    this.ticker = setInterval(() => this.tick(), 2_000);
  }

  subscribe(listener: (state: LiveState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => { this.listeners.delete(listener); };
  }

  private set(patch: Partial<LiveState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  /** Levels for the presence orb, read on animation frames rather than through React state. */
  levels(): { input: number; output: number } {
    return { input: this.state.muted ? 0 : this.audio.inputLevel, output: this.audio.outputLevel() };
  }

  /** Open the microphone and the provider connection. Call from a click (R4). */
  async connect(deviceId?: string): Promise<void> {
    if (this.disposed || this.state.status === "connecting") return;
    this.deviceId = deviceId;
    this.set({ status: "connecting", error: null });
    try {
      this.audio.close();
      await this.audio.open(deviceId);
    } catch (error) {
      const name = (error as Error)?.name;
      return this.fail(name === "NotAllowedError" ? "Microphone access was blocked. Allow it in the browser's site settings, then retry."
        : name === "NotFoundError" ? "No microphone was found. Plug one in, then retry."
          : "The microphone could not be opened. Retry, or type instead.");
    }
    try {
      await this.openProvider();
      this.set({ status: this.state.started ? "listening" : "ready" });
    } catch (error) {
      this.fail(this.describe(error));
    }
  }

  private async openProvider(): Promise<void> {
    const credential = await this.deps.mint(this.handle);
    const provider = (this.deps.createProvider ?? ((events) => new GeminiLive(events)))({
      audio: (pcm) => this.onAudio(pcm),
      interrupted: () => { this.audio.flush(); this.finishModelTurn(); },
      userText: (fragment) => this.onUserText(fragment),
      modelText: (fragment) => { this.modelText += fragment; this.set({ caption: { speaker: "INTERVIEWER", text: this.modelText.trim() } }); },
      speech: (active) => this.onSpeech(active),
      turnEnd: () => this.finishModelTurn(),
      goAway: (ms) => { void this.rotate(ms); },
      resumption: (handle) => { this.handle = handle; },
      closed: (info) => { if (!info.expected && this.provider === provider) void this.reconnect(); },
    });
    await provider.connect(credential);
    if (this.disposed) { provider.close(); return; }
    this.provider = provider;
    if (this.state.muted) provider.pauseAudio();
    this.sentRevision = -1;
    this.pushCode();
  }

  private describe(error: unknown): string {
    const message = error instanceof Error ? error.message : "";
    if (/exhausted|quota|RATE_LIMITED/i.test(message)) return "The voice provider is rate limiting new connections. Wait a minute, then retry.";
    if (/UNAVAILABLE/.test(message)) return "Voice is not configured on the server.";
    return "Could not reach the voice provider. Check your connection, then retry.";
  }

  private fail(error: string): void {
    this.provider?.close();
    this.provider = null;
    this.audio.flush();
    this.set({ status: "failed", error, caption: null });
  }

  // ── Conversation ────────────────────────────────────────────────────────

  /** Start the interview: the interviewer greets and presents the problem. */
  begin(): void {
    if (this.state.started) return;
    this.set({ started: true, status: "listening" });
    this.cue("START");
  }

  /** A cue from the interview software that asks the interviewer to speak. */
  cue(kind: CueKind, n?: number): void {
    if (!this.provider) return;
    this.lastCue = { kind, ...(n !== undefined ? { n } : {}) };
    this.provider.sendText(cueText(kind, n), { respond: true });
    this.queue({ type: "CUE", id: newId(), kind, ...(n !== undefined ? { n } : {}), at: stamp() });
    this.armStall();
  }

  /** Re-send the last cue after "the interviewer didn't respond". */
  retry(): void {
    if (this.state.status === "failed") { void this.connect(this.deviceId); return; }
    if (!this.lastCue || !this.provider) { this.set({ stalled: false }); return; }
    this.provider.sendText(cueText(this.lastCue.kind, this.lastCue.n), { respond: true });
    this.armStall();
  }

  /** Typed instead of spoken: the fallback when the microphone fails. */
  typed(text: string): void {
    const said = text.trim();
    if (!said || !this.provider) return;
    this.pushCode();
    this.provider.sendText(said, { respond: true });
    this.addLine("CANDIDATE", said);
    this.armStall();
  }

  /** Tell the interviewer about a test run. */
  runFinished(summary: string): void {
    this.lastActivityAt = Date.now();
    this.pushCode();
    this.provider?.sendText(summary, { respond: this.deps.reactToRuns });
    if (this.deps.reactToRuns) this.armStall();
  }

  /** The editor changed. Sent to the model when the candidate speaks, or after 5 s idle. */
  setCode(revision: number, text: string): void {
    this.code = { revision, text };
    this.lastActivityAt = Date.now();
    if (this.codeTimer) clearTimeout(this.codeTimer);
    this.codeTimer = setTimeout(() => { this.pushCode(); this.logCode(); }, CODE_IDLE_MS);
  }

  private pushCode(): void {
    if (!this.code || !this.provider || this.code.revision === this.sentRevision) return;
    this.provider.sendText(codeContext(this.code.revision, this.code.text), { respond: false });
    this.sentRevision = this.code.revision;
  }

  private logCode(): void {
    if (!this.code || this.code.revision === this.loggedRevision) return;
    this.loggedRevision = this.code.revision;
    this.queue({ type: "CODE", id: newId(), revision: this.code.revision, text: this.code.text, at: stamp() });
  }

  /** "Thinking quietly": stop sending audio so nothing muttered can trigger a reply. */
  setMuted(muted: boolean): void {
    this.audio.setMuted(muted);
    if (muted) this.provider?.pauseAudio();
    this.lastActivityAt = Date.now();
    this.set({ muted });
  }

  // ── Provider events ─────────────────────────────────────────────────────

  private onAudio(pcm: Int16Array): void {
    if (!this.modelTurnOpen) {
      this.modelTurnOpen = true;
      this.finishUserTurn();
      this.clearStall();
      const ms = this.latency.firstAudio(this.audio.lastVoiceAt);
      if (ms !== null) {
        this.queue({ type: "LATENCY", id: newId(), speechEndToFirstAudioMs: ms, at: stamp() });
        this.set({ latency: this.latency.stats() });
      }
    }
    this.audio.play(pcm);
  }

  private onUserText(fragment: string): void {
    this.userText += fragment;
    this.lastActivityAt = Date.now();
    this.quietCues = 0;
    this.latency.candidateSpoke();
    if (!this.modelTurnOpen) this.set({ caption: { speaker: "CANDIDATE", text: this.userText.trim() } });
    // Thinking aloud often gets no reply, so the utterance has to end on its own.
    if (this.userTimer) clearTimeout(this.userTimer);
    this.userTimer = setTimeout(() => this.finishUserTurn(), 3_000);
  }

  private onSpeech(active: boolean): void {
    this.lastActivityAt = Date.now();
    if (active) { this.pushCode(); return; }
    // Speech ended and no audio yet: an honest "thinking" state, for a bounded time.
    if (this.thinkTimer) clearTimeout(this.thinkTimer);
    this.thinking = true;
    this.thinkTimer = setTimeout(() => { this.thinking = false; this.refreshStatus(); }, 3_000);
    this.refreshStatus();
  }
  private thinking = false;

  private finishUserTurn(): void {
    if (this.userTimer) { clearTimeout(this.userTimer); this.userTimer = null; }
    const said = this.userText.trim();
    this.userText = "";
    if (said) this.addLine("CANDIDATE", said);
    else if (this.state.caption?.speaker === "CANDIDATE") this.set({ caption: null });
  }

  private finishModelTurn(): void {
    this.modelTurnOpen = false;
    this.thinking = false;
    const said = this.modelText.trim();
    this.modelText = "";
    if (said) this.addLine("INTERVIEWER", said);
    void this.flush();
    this.refreshStatus();
  }

  private addLine(speaker: Speaker, text: string): void {
    const id = newId();
    this.set({ lines: [...this.state.lines, { id, speaker, text }], caption: null });
    this.queue({ type: "TRANSCRIPT", id, speaker, text: text.slice(0, 8_000), at: stamp() });
  }

  private refreshStatus(): void {
    if (!["listening", "thinking", "speaking"].includes(this.state.status)) return;
    if (this.audio.playing) { this.thinking = false; this.set({ status: "speaking" }); }
    else this.set({ status: this.thinking ? "thinking" : "listening" });
  }

  private armStall(): void {
    this.clearStall();
    this.thinking = true;
    this.refreshStatus();
    this.stallTimer = setTimeout(() => {
      this.thinking = false;
      this.refreshStatus();
      if (!this.audio.playing) this.set({ stalled: true });
    }, STALL_MS);
  }

  private clearStall(): void {
    if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
    if (this.state.stalled) this.set({ stalled: false });
  }

  // ── Connection lifetime ─────────────────────────────────────────────────

  /** The provider announced it will close this connection. Reconnect between turns. */
  private async rotate(msLeft: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, msLeft - 3_000);
    while (this.audio.playing && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    await this.reconnect();
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.disposed || this.state.status === "failed" || this.state.status === "idle") return;
    this.reconnecting = true;
    const before = this.state.status;
    this.provider?.close();
    this.provider = null;
    this.audio.flush();
    this.finishModelTurn();
    this.set({ status: "reconnecting", caption: null });
    try {
      for (const delay of RECONNECT_DELAYS_MS) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (this.disposed) return;
        try {
          await this.openProvider();
          this.set({ status: before === "ready" ? "ready" : "listening", error: null });
          return;
        } catch { /* try again after the next delay */ }
      }
      this.fail("The voice connection could not be restored. Your code is safe. Press Retry to reconnect.");
    } finally { this.reconnecting = false; }
  }

  // ── Upload ──────────────────────────────────────────────────────────────

  private queue(event: LiveEvent): void { this.outbox.push(event); }

  private tick(): void {
    void this.flush();
    if (!this.state.started || this.state.muted || !this.provider) return;
    if (["listening"].includes(this.state.status) && this.quietCues < 3 && Date.now() - this.lastActivityAt > QUIET_MS) {
      this.quietCues++;
      this.lastActivityAt = Date.now();
      this.cue("QUIET");
    }
  }

  /** Never on the speaking path: if the API is slow the conversation continues and this retries. */
  async flush(): Promise<void> {
    if (this.uploading || this.outbox.length === 0) return;
    this.uploading = true;
    const batch = this.outbox.slice(0, 100);
    try {
      await this.deps.upload(batch);
      this.outbox = this.outbox.slice(batch.length);
    } catch { /* kept in the outbox for the next tick */ }
    finally { this.uploading = false; }
  }

  /** Everything said and typed so far is uploaded before the session is ended. */
  async stop(): Promise<void> {
    this.finishUserTurn();
    this.finishModelTurn();
    this.logCode();
    this.dispose();
    for (let i = 0; i < 3 && this.outbox.length; i++) await this.flush();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.ticker);
    for (const timer of [this.userTimer, this.thinkTimer, this.stallTimer, this.codeTimer]) if (timer) clearTimeout(timer);
    this.provider?.close();
    this.provider = null;
    this.audio.close();
  }
}
