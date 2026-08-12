import type { ClientEvent, ClientEventType, ServerMessage } from "@master-leeter/contracts";

/**
 * Browser session client (M2-3 / M2-5 client half).
 *
 * Everything stateful about the candidate's connection lives here, deliberately
 * outside React. Reconnect correctness is the hardest part of this product's
 * client and it should be testable without mounting a component tree.
 *
 * Three responsibilities:
 *
 *   1. Debounce edits into meaningful deltas. One network event per keystroke
 *      would be tens of thousands of events per interview and would tell the
 *      observer nothing a debounced patch doesn't.
 *   2. Number every delta with a monotonic revision, so the interviewer can
 *      always say which version of the code it is talking about.
 *   3. Survive a drop. Unacked events stay in an outbox and are resent on
 *      reconnect; the server dedupes on idempotency key.
 */

export interface Transport {
  send(data: string): void;
  close(): void;
  readonly connected: boolean;
}

export interface SessionClientOptions {
  sessionId: string;
  connect: (handlers: TransportHandlers) => Transport;
  /** Injected so tests are deterministic and don't sleep. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Milliseconds of quiet before an edit is flushed. */
  debounceMs?: number;
  /**
   * Delay before re-dialling after an unexpected close. Undefined disables the
   * reconnect loop, which is what the unit tests want — they exercise outbox
   * semantics, not dialling.
   */
  reconnectDelayMs?: number;
  newId?: () => string;
  onServerMessage?: (msg: ServerMessage) => void;
  onConnectionChange?: (connected: boolean) => void;
}

export interface TransportHandlers {
  onMessage: (raw: string) => void;
  onOpen: () => void;
  onClose: () => void;
}

interface OutboxEntry {
  event: ClientEvent;
  attempts: number;
}

let idCounter = 0;
const defaultNewId = () => `id-${Date.now()}-${idCounter++}`;

export class SessionClient {
  private transport: Transport | null = null;
  private readonly outbox = new Map<string, OutboxEntry>();

  private clientSeq = 0;
  private codeRevision = 0;
  private lastAckedSeq = -1;

  private pendingCode: string | null = null;
  private pendingNotes: string | null = null;
  private flushTimer: unknown = null;

  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly debounceMs: number;
  private readonly newId: () => string;
  /** Set by disconnect(), so a deliberate teardown does not re-dial. */
  private stopped = false;

  constructor(private readonly opts: SessionClientOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.debounceMs = opts.debounceMs ?? 750;
    this.newId = opts.newId ?? defaultNewId;
  }

  connect(): void {
    this.stopped = false;
    this.transport = this.opts.connect({
      onMessage: (raw) => this.handleMessage(raw),
      onOpen: () => {
        this.opts.onConnectionChange?.(true);
        this.flushOutbox();
      },
      onClose: () => {
        this.opts.onConnectionChange?.(false);
        // Deliberately NOT nulling the transport. A closed transport still
        // knows how to send once it reopens, and dropping the reference here
        // meant a reconnect could never flush the outbox — every event buffered
        // during an outage was stranded.
        if (!this.stopped && this.opts.reconnectDelayMs !== undefined) {
          this.setTimer(() => {
            if (!this.stopped) this.connect();
          }, this.opts.reconnectDelayMs);
        }
      },
    });
  }

  disconnect(): void {
    this.stopped = true;
    if (this.flushTimer !== null) this.clearTimer(this.flushTimer);
    this.flushTimer = null;
    this.transport?.close();
    this.transport = null;
  }

  /** Current code revision. Attach to anything that talks about the code. */
  get revision(): number {
    return this.codeRevision;
  }

  get pendingCount(): number {
    return this.outbox.size;
  }

  /**
   * Called on every keystroke. Cheap — it only records intent.
   *
   * The actual send waits for the candidate to pause. Someone typing steadily
   * for ninety seconds should produce a handful of deltas, not thousands.
   */
  codeChanged(text: string): void {
    this.pendingCode = text;
    this.scheduleFlush();
  }

  notesChanged(text: string): void {
    this.pendingNotes = text;
    this.scheduleFlush();
  }

  /** Forces an immediate flush. Used before a run, so the runner sees current code. */
  flush(): void {
    if (this.flushTimer !== null) {
      this.clearTimer(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.pendingCode !== null) {
      // Revision increments only when code actually ships, so a revision id
      // always corresponds to something the server has seen.
      this.codeRevision += 1;
      this.enqueue("CODE_DELTA", { revision: this.codeRevision, text: this.pendingCode });
      this.pendingCode = null;
    }

    if (this.pendingNotes !== null) {
      this.enqueue("NOTE_DELTA", { text: this.pendingNotes });
      this.pendingNotes = null;
    }
  }

  requestRun(input: string): number {
    // Flush first: a run against a revision the server has not seen would make
    // the result impossible to attribute.
    this.flush();
    const revision = this.codeRevision;
    this.enqueue("RUN_REQUESTED", { revision, input });
    return revision;
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) this.clearTimer(this.flushTimer);
    this.flushTimer = this.setTimer(() => {
      this.flushTimer = null;
      this.flush();
    }, this.debounceMs);
  }

  /**
   * `ClientEventType`, not `EventType`.
   *
   * The narrow type is the point: the client is now structurally incapable of
   * emitting a conclusion — `RUN_COMPLETED`, `MILESTONE`, `HINT_GIVEN` — into
   * the evidence log. The server rejects them anyway, but a compile error here
   * means nobody writes the code that gets rejected at runtime in the first
   * place.
   */
  /**
   * Report a VAD boundary (M3-2).
   *
   * `atMs` is when the boundary *happened*, not when this was called, and it is
   * carried through as `occurredAt`. That matters more than it looks: the server
   * computes `silenceMs` as the interval between two logged `occurredAt`
   * timestamps (M4-2). Stamping send time instead would fold the VAD's hangover
   * and the network hop into the measurement, shortening every observed pause
   * and making the gate more willing to speak.
   */
  speechBoundary(type: "SPEECH_STARTED" | "SPEECH_STOPPED", atMs: number): void {
    this.enqueue(type, {}, atMs);
  }

  /** Finalized candidate transcript — the gate's only speech input (M4-2). */
  speechFinal(transcript: string, occurredAtMs?: number): void {
    const text = transcript.trim();
    if (!text) return;
    this.enqueue("SPEECH_FINAL", { transcript: text, finalized: true }, occurredAtMs);
  }

  private enqueue(
    type: ClientEventType,
    payload: Record<string, unknown>,
    occurredAtMs?: number,
  ): void {
    const event: ClientEvent = {
      sessionId: this.opts.sessionId,
      clientSeq: this.clientSeq++,
      idempotencyKey: this.newId(),
      type,
      occurredAt: new Date(occurredAtMs ?? this.now()).toISOString(),
      payload,
    };

    this.outbox.set(event.idempotencyKey, { event, attempts: 0 });
    this.trySend(event);
  }

  private trySend(event: ClientEvent): void {
    if (!this.transport?.connected) return;
    const entry = this.outbox.get(event.idempotencyKey);
    if (entry) entry.attempts += 1;
    this.transport.send(JSON.stringify(event));
  }

  /**
   * Resends everything unacked, oldest first.
   *
   * Order matters: the server rejects gaps, so replaying out of order would
   * trigger a REPLAY_FROM loop.
   */
  private flushOutbox(): void {
    const pending = [...this.outbox.values()].sort((a, b) => a.event.clientSeq - b.event.clientSeq);
    for (const entry of pending) this.trySend(entry.event);
  }

  private handleMessage(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    switch (msg.kind) {
      case "ACK": {
        this.lastAckedSeq = Math.max(this.lastAckedSeq, msg.seq);
        for (const [key, entry] of this.outbox) {
          if (entry.event.clientSeq === msg.clientSeq) this.outbox.delete(key);
        }
        break;
      }
      case "REPLAY_FROM": {
        // The server lost something. Resend everything from that point rather
        // than guessing which event went missing.
        for (const entry of [...this.outbox.values()].sort(
          (a, b) => a.event.clientSeq - b.event.clientSeq,
        )) {
          if (entry.event.clientSeq >= msg.seq) this.trySend(entry.event);
        }
        break;
      }
      default:
        break;
    }

    this.opts.onServerMessage?.(msg);
  }

  /** Last server sequence acknowledged. Sent on reconnect to resume. */
  get resumeFrom(): number {
    return this.lastAckedSeq;
  }
}
