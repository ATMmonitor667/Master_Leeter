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
  /** Authoritative cursors returned by the resume endpoint after a page load. */
  initialClientSeq?: number;
  initialCodeRevision?: number;
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
  random?: () => number;
  newId?: () => string;
  onServerMessage?: (msg: ServerMessage) => void;
  onConnectionChange?: (connected: boolean) => void;
  /** Includes debounced edits and sent events that have not been acknowledged. */
  onPendingChange?: (pending: number) => void;
}

export interface TransportHandlers {
  onMessage: (raw: string) => void;
  onOpen: () => void;
  onClose: (retryable?: boolean) => void;
}

interface OutboxEntry {
  event: ClientEvent;
  attempts: number;
}

interface AckWaiter {
  targetClientSeq: number;
  resolve: (clientSeq: number) => void;
  reject: (error: Error) => void;
  timer: unknown;
}

let idCounter = 0;
const defaultNewId = () => `id-${Date.now()}-${idCounter++}`;

export class SessionClient {
  private transport: Transport | null = null;
  private readonly outbox = new Map<string, OutboxEntry>();

  private clientSeq = 0;
  private codeRevision = 0;
  private lastAckedSeq = -1;
  private lastAckedClientSeq = -1;
  private readonly ackWaiters = new Set<AckWaiter>();

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
  private reconnectTimer: unknown = null;
  private reconnectAttempts = 0;

  constructor(private readonly opts: SessionClientOptions) {
    this.clientSeq = opts.initialClientSeq ?? 0;
    this.codeRevision = opts.initialCodeRevision ?? 0;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.debounceMs = opts.debounceMs ?? 750;
    this.newId = opts.newId ?? defaultNewId;
  }

  connect(): void {
    if (this.reconnectTimer !== null) this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopped = false;
    this.transport = this.opts.connect({
      onMessage: (raw) => this.handleMessage(raw),
      onOpen: () => {
        this.reconnectAttempts = 0;
        this.opts.onConnectionChange?.(true);
        this.flushOutbox();
      },
      onClose: (retryable = true) => {
        this.opts.onConnectionChange?.(false);
        // Deliberately NOT nulling the transport. A closed transport still
        // knows how to send once it reopens, and dropping the reference here
        // meant a reconnect could never flush the outbox — every event buffered
        // during an outage was stranded.
        if (!retryable) this.stopped = true;
        if (!this.stopped && this.reconnectTimer === null && this.opts.reconnectDelayMs !== undefined) {
          const base = Math.min(30_000, this.opts.reconnectDelayMs * 2 ** Math.min(this.reconnectAttempts++, 10));
          const delay = base * (0.5 + (this.opts.random ?? Math.random)() * 0.5);
          this.reconnectTimer = this.setTimer(() => {
            this.reconnectTimer = null;
            if (!this.stopped) this.connect();
          }, delay);
        }
      },
    });
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
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
    return this.outbox.size + Number(this.pendingCode !== null) + Number(this.pendingNotes !== null);
  }

  /**
   * Called on every keystroke. Cheap — it only records intent.
   *
   * The actual send waits for the candidate to pause. Someone typing steadily
   * for ninety seconds should produce a handful of deltas, not thousands.
   */
  codeChanged(text: string): void {
    this.pendingCode = text;
    this.notifyPending();
    this.scheduleFlush();
  }

  notesChanged(text: string): void {
    this.pendingNotes = text;
    this.notifyPending();
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
    this.notifyPending();
  }

  /**
   * Flush all local edits and wait until the server has acknowledged every
   * client event through that point. The returned cursor is sent with the end
   * request so the server can seal the exact durable input set atomically.
   */
  flushAndWaitForAcknowledgement(timeoutMs = 10_000): Promise<number> {
    this.flush();
    const targetClientSeq = this.clientSeq - 1;
    if (targetClientSeq <= this.lastAckedClientSeq || !this.hasPendingThrough(targetClientSeq)) {
      return Promise.resolve(targetClientSeq);
    }

    return new Promise((resolve, reject) => {
      const waiter: AckWaiter = {
        targetClientSeq,
        resolve,
        reject,
        timer: this.setTimer(() => {
          this.ackWaiters.delete(waiter);
          reject(new Error("Your latest changes have not reached the server yet. Reconnect and try again."));
        }, timeoutMs),
      };
      this.ackWaiters.add(waiter);
    });
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
  speechBoundary(
    type: "SPEECH_STARTED" | "SPEECH_STOPPED",
    atMs: number,
    prosody?: { probability: number; confidence: number; reason?: string },
    interimTranscript?: string,
  ): void {
    const payload = type === "SPEECH_STOPPED" ? {
      ...(prosody ? { prosody } : {}),
      ...(interimTranscript?.trim() ? { interimTranscript: interimTranscript.trim().slice(0, 400) } : {}),
    } : {};
    this.enqueue(type, payload, atMs);
  }

  /** Finalized candidate transcript — the gate's only speech input (M4-2). */
  speechFinal(transcript: string, occurredAtMs?: number): void {
    const text = transcript.trim();
    if (!text) return;
    const endedAt = occurredAtMs ?? this.now();
    this.enqueue("SPEECH_FINAL", {
      segmentId: this.newId(),
      speaker: "CANDIDATE",
      transcript: text,
      finalized: true,
      endedAt: new Date(endedAt).toISOString(),
    }, endedAt);
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
    this.notifyPending();
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
        this.lastAckedClientSeq = Math.max(this.lastAckedClientSeq, msg.clientSeq);
        for (const [key, entry] of this.outbox) {
          if (entry.event.clientSeq === msg.clientSeq) this.outbox.delete(key);
        }
        this.notifyPending();
        this.resolveAckWaiters();
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

  private hasPendingThrough(targetClientSeq: number): boolean {
    for (const entry of this.outbox.values()) {
      if (entry.event.clientSeq <= targetClientSeq) return true;
    }
    return false;
  }

  private resolveAckWaiters(): void {
    for (const waiter of this.ackWaiters) {
      if (this.hasPendingThrough(waiter.targetClientSeq)) continue;
      this.clearTimer(waiter.timer);
      this.ackWaiters.delete(waiter);
      waiter.resolve(waiter.targetClientSeq);
    }
  }

  private notifyPending(): void {
    this.opts.onPendingChange?.(this.pendingCount);
  }
}
