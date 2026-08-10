/**
 * Deletion (M7-3).
 *
 * The awkward part of this feature is that the event log is append-only
 * (invariant 8) and a deletion request says "remove my data". Those look
 * contradictory, and resolving them badly gives you either a system that cannot
 * honour a deletion request or an audit trail that can be quietly rewritten.
 *
 * The resolution is redaction, not erasure. A deleted session keeps its
 * skeleton — sequence numbers, event types, timestamps — and loses every
 * payload that could identify or quote the person. The shape of the evidence
 * survives so ordering and hashes still make sense; the content does not.
 *
 * Two properties this preserves that a DELETE would destroy:
 *
 *   - Sequence integrity. Removing rows leaves gaps, and a gap is
 *     indistinguishable from data loss, so every future audit becomes suspect.
 *   - Honesty. A tombstone records that something was deleted and when. Silent
 *     erasure means nobody can tell the difference between "never happened" and
 *     "removed on request".
 */

import type { EventType, SessionEvent } from "@master-leeter/contracts";
import type { EventLog } from "../session/event-log.js";

export const DELETION_SCOPES = ["SESSION", "ACCOUNT"] as const;
export type DeletionScope = (typeof DELETION_SCOPES)[number];

export interface DeletionRequest {
  scope: DeletionScope;
  userId: string;
  /** Present for SESSION scope. */
  sessionId?: string;
  requestedAt: string;
  reason?: string;
}

export interface DeletionReceipt {
  scope: DeletionScope;
  userId: string;
  sessionIds: string[];
  eventsRedacted: number;
  reportsDeleted: number;
  audioDeleted: number;
  completedAt: string;
  /** What could not be reached, and why. Honesty beats a clean-looking receipt. */
  unreachable: string[];
}

/**
 * Payload fields that carry the person, rather than the shape of what happened.
 *
 * Everything not on this list survives redaction: a run's status and timing say
 * that a test failed, which is not personal. The stdout of their code might be.
 */
const IDENTIFYING_FIELDS = new Set([
  "transcript",
  "text",
  "stdout",
  "stderr",
  "source",
  "notes",
  "input",
  "audioUrl",
  "utterance",
]);

export const REDACTED = "[redacted]" as const;

/**
 * Redacts one event in place of deleting it.
 *
 * Note what is kept: seq, type, actor, timestamps, scenario version. A report
 * regenerated after redaction will correctly say "this session cannot be
 * re-scored because its content was removed" rather than silently producing a
 * different number.
 */
export function redactEvent(event: SessionEvent): SessionEvent {
  const payload: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(event.payload)) {
    payload[key] = IDENTIFYING_FIELDS.has(key) ? REDACTED : value;
  }

  return {
    ...event,
    payload: { ...payload, redacted: true },
    // The hash is deliberately NOT recomputed. It still attests to the original
    // content, so a later audit can prove the log was redacted rather than
    // fabricated — without the original content being recoverable from it.
    evidenceHash: event.evidenceHash,
  };
}

/** Event types whose entire payload goes, because none of it is structural. */
const FULLY_REDACTED: ReadonlySet<EventType> = new Set<EventType>([
  "SPEECH_FINAL",
  "CLARIFICATION_ANSWERED",
  "PROBE_ASKED",
  "HINT_GIVEN",
  "FOLLOW_UP_PRESENTED",
  "BRIEF_DELIVERED",
  "NOTE_DELTA",
  "CODE_DELTA",
]);

export function redactionFor(event: SessionEvent): SessionEvent {
  if (FULLY_REDACTED.has(event.type)) {
    return { ...event, payload: { redacted: true }, evidenceHash: event.evidenceHash };
  }
  return redactEvent(event);
}

/**
 * Storage a deletion has to reach.
 *
 * Modelled as an interface so every store that holds candidate data must
 * declare itself here. Adding a new store without implementing this is a
 * compile error, which is the only reliable way to stop a deletion request
 * silently missing something.
 */
export interface Deletable {
  readonly name: string;
  deleteForSession(sessionId: string): Promise<number>;
  deleteForUser(userId: string): Promise<number>;
}

export interface DeletionDeps {
  eventLog: EventLog & { redact?(sessionId: string): Promise<number> };
  /** Sessions belonging to a user. */
  sessionsOf(userId: string): Promise<string[]>;
  /** Reports, recordings, analytics — anything holding derived data. */
  stores: Deletable[];
  now?: () => string;
}

export async function executeDeletion(
  request: DeletionRequest,
  deps: DeletionDeps,
): Promise<DeletionReceipt> {
  const now = deps.now ?? (() => new Date().toISOString());

  const sessionIds =
    request.scope === "SESSION"
      ? request.sessionId
        ? [request.sessionId]
        : []
      : await deps.sessionsOf(request.userId);

  const receipt: DeletionReceipt = {
    scope: request.scope,
    userId: request.userId,
    sessionIds,
    eventsRedacted: 0,
    reportsDeleted: 0,
    audioDeleted: 0,
    completedAt: now(),
    unreachable: [],
  };

  for (const sessionId of sessionIds) {
    if (deps.eventLog.redact) {
      receipt.eventsRedacted += await deps.eventLog.redact(sessionId);
    } else {
      receipt.unreachable.push(`event log does not support redaction (${sessionId})`);
    }

    for (const store of deps.stores) {
      try {
        const removed = await store.deleteForSession(sessionId);
        if (store.name === "reports") receipt.reportsDeleted += removed;
        if (store.name === "audio") receipt.audioDeleted += removed;
      } catch (err) {
        // Recorded, not swallowed. A receipt claiming success it did not achieve
        // is worse than one admitting a store was unreachable.
        receipt.unreachable.push(`${store.name}: ${(err as Error).message}`);
      }
    }
  }

  if (request.scope === "ACCOUNT") {
    for (const store of deps.stores) {
      try {
        await store.deleteForUser(request.userId);
      } catch (err) {
        receipt.unreachable.push(`${store.name} (account): ${(err as Error).message}`);
      }
    }
  }

  receipt.completedAt = now();
  return receipt;
}
