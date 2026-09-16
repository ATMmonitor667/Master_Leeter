/**
 * Voice session resumption handles (I04-2).
 *
 * A 45-minute interview outlives a single provider connection, so each new
 * credential must continue the previous logical session rather than start a
 * fresh one. Gemini expresses that continuity as an opaque handle delivered to
 * whoever holds the provider socket — which is the browser, not this process.
 *
 * The browser therefore has to report the handle, but it must not be allowed to
 * CHOOSE the handle a credential is minted with. Those are different powers. If
 * the mint endpoint honoured a handle from the request body, anyone could paste
 * another session's handle and have the provider restore that interview's
 * accumulated audio context — the problem brief, probes and hints already spoken
 * into it — behind a credential this server signed. Ownership checks on the
 * route stop that reaching across accounts; keeping the handle here also stops
 * the later mint request from selecting or replacing the stored value.
 *
 * So: the report route writes a handle against a session id, and the mint route
 * reads only what is stored for the session it is minting for. The request body
 * is not consulted.
 *
 * Deliberately in-process and not a database column. A handle is transport
 * state with a lifetime of minutes, not interview evidence — it does not belong
 * in the append-only log, and persisting it would outlive its own validity.
 * Voice already runs on the process holding the fenced runtime for a session,
 * which is the same scope as this map. A process restart loses the handle and
 * the next connection starts a fresh provider session with the interview state
 * intact, because interview state was never in here.
 */
export class VoiceResumptionStore {
  private readonly handles = new Map<string, { handle: string; expiresAt: number }>();

  constructor(
    /** Provider handles go stale on their own; outliving that helps nobody. */
    private readonly ttlMs = 15 * 60_000,
    private readonly maxEntries = 5_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  record(sessionId: string, handle: string): void {
    this.prune();
    // A bounded map because this is fed by a client-reachable route. Dropping
    // the newest report under pressure only costs context continuity on the
    // next rotation, which is the cheapest thing here to lose.
    if (this.handles.size >= this.maxEntries && !this.handles.has(sessionId)) return;
    this.handles.set(sessionId, { handle, expiresAt: this.now() + this.ttlMs });
  }

  get(sessionId: string): string | undefined {
    const entry = this.handles.get(sessionId);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.handles.delete(sessionId);
      return undefined;
    }
    return entry.handle;
  }

  /** Called when a session ends or is deleted. */
  clear(sessionId: string): void {
    this.handles.delete(sessionId);
  }

  get size(): number {
    return this.handles.size;
  }

  private prune(): void {
    const at = this.now();
    for (const [id, entry] of this.handles) {
      if (entry.expiresAt <= at) this.handles.delete(id);
    }
  }
}
