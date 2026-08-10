import { createHash } from "node:crypto";
import type { Actor, EventType, SessionEvent } from "@master-leeter/contracts";

/**
 * Append-only session event log (M2-7).
 *
 * The evidence substrate for scoring, replay, and debugging (invariant 8,
 * ADR-003). Two properties are load-bearing and everything else follows:
 *
 *   1. Append-only. There is no update and no delete on this interface. Not
 *      "we don't call them" — they do not exist.
 *   2. Strictly increasing `seq` per session, assigned HERE, server-side. A
 *      client-assigned sequence would be a client-controlled ordering of the
 *      evidence its own score is computed from.
 *
 * Reconnects replay events, so append is idempotent on `idempotencyKey`. A
 * duplicate returns the ORIGINAL event rather than erroring — the client cannot
 * distinguish "you already sent this" from "accepted", which is what makes
 * blind retry safe.
 */

export interface AppendRequest {
  sessionId: string;
  type: EventType;
  actor: Actor;
  scenarioVersionId: string;
  payload: Record<string, unknown>;
  traceId: string;
  /** Stable across retries of the same logical event. */
  idempotencyKey: string;
  occurredAt?: string;
}

export interface AppendResult {
  event: SessionEvent;
  /** True when this key had already been appended. */
  duplicate: boolean;
}

export interface EventLog {
  append(req: AppendRequest): Promise<AppendResult>;
  /** Events for a session in seq order, optionally from a lower bound (inclusive). */
  read(sessionId: string, fromSeq?: number): Promise<SessionEvent[]>;
  /** Highest assigned seq, or -1 for an empty session. */
  latestSeq(sessionId: string): Promise<number>;
}

/**
 * Content hash over the semantic fields of an event.
 *
 * Excludes `seq` and `occurredAt` deliberately: the hash answers "is this the
 * same evidence?", and the evaluator cites it when quoting a moment. Including
 * assignment-time metadata would make identical evidence hash differently.
 */
export function evidenceHash(req: Pick<AppendRequest, "sessionId" | "type" | "actor" | "payload">): string {
  const canonical = JSON.stringify({
    sessionId: req.sessionId,
    type: req.type,
    actor: req.actor,
    payload: sortKeys(req.payload),
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

/**
 * In-memory implementation.
 *
 * Not a stub — this is what the simulator, the replay tests, and local
 * development run against. The Postgres implementation exists for durability,
 * not for correctness; both satisfy the same conformance suite.
 */
export class InMemoryEventLog implements EventLog {
  private readonly events = new Map<string, SessionEvent[]>();
  private readonly byKey = new Map<string, SessionEvent>();

  async append(req: AppendRequest): Promise<AppendResult> {
    const dedupeKey = `${req.sessionId}:${req.idempotencyKey}`;
    const existing = this.byKey.get(dedupeKey);
    if (existing) return { event: existing, duplicate: true };

    const list = this.events.get(req.sessionId) ?? [];
    const event: SessionEvent = {
      sessionId: req.sessionId,
      seq: list.length,
      occurredAt: req.occurredAt ?? new Date().toISOString(),
      type: req.type,
      actor: req.actor,
      scenarioVersionId: req.scenarioVersionId,
      payload: req.payload,
      evidenceHash: evidenceHash(req),
      traceId: req.traceId,
    };

    list.push(event);
    this.events.set(req.sessionId, list);
    this.byKey.set(dedupeKey, event);

    return { event, duplicate: false };
  }

  async read(sessionId: string, fromSeq = 0): Promise<SessionEvent[]> {
    return (this.events.get(sessionId) ?? []).filter((e) => e.seq >= fromSeq);
  }

  async latestSeq(sessionId: string): Promise<number> {
    const list = this.events.get(sessionId);
    return list && list.length > 0 ? list.length - 1 : -1;
  }
}
