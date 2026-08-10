import { ClientEventSchema, type ServerMessage } from "@master-leeter/contracts";
import type { EventLog } from "./event-log.js";
import { type SessionStore, remainingSeconds } from "./session-store.js";

/**
 * Session channel protocol (M2-2).
 *
 * Deliberately transport-independent. WebSockets are an implementation detail;
 * the interesting behavior is reconnect semantics, and testing that through a
 * real socket would mean testing the socket instead of the protocol.
 *
 * The three situations this exists to survive:
 *
 *   1. Duplicate delivery. The client retried; the event already landed. ACK it
 *      as though it were new — the client must not be able to tell, or blind
 *      retry stops being safe.
 *   2. Gaps. Client sequence jumped, so something was lost in flight. Ask for
 *      replay from the last contiguous point rather than accepting a hole in the
 *      evidence.
 *   3. Reconnect. Browser refreshed mid-interview. Resume from the last
 *      acknowledged sequence with editor revision, timer, and stage intact.
 */

export interface ChannelDeps {
  sessions: SessionStore;
  eventLog: EventLog;
  now?: () => number;
}

export interface HandleResult {
  messages: ServerMessage[];
  /** False when the event was rejected outright (unknown session, bad payload). */
  accepted: boolean;
}

export class SessionChannel {
  /** Highest contiguous clientSeq received per session. */
  private readonly lastClientSeq = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: ChannelDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Applies one client event.
   *
   * Returns messages to send rather than sending them, so the caller owns the
   * transport and the tests own the assertions.
   */
  async handleClientEvent(raw: unknown): Promise<HandleResult> {
    const parsed = ClientEventSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        accepted: false,
        messages: [{ kind: "ERROR", code: "INVALID_EVENT", message: parsed.error.message }],
      };
    }

    const event = parsed.data;
    const session = await this.deps.sessions.get(event.sessionId);
    if (!session) {
      return {
        accepted: false,
        messages: [{ kind: "ERROR", code: "UNKNOWN_SESSION", message: event.sessionId }],
      };
    }

    if (session.endedAt) {
      // The live phase is over. Late events are dropped rather than appended —
      // the evaluator is already reading this log and its input must not move.
      return {
        accepted: false,
        messages: [{ kind: "ERROR", code: "SESSION_ENDED", message: event.sessionId }],
      };
    }

    const expected = (this.lastClientSeq.get(event.sessionId) ?? -1) + 1;

    if (event.clientSeq > expected) {
      // Something was lost. Refuse to append past the hole — an event log with a
      // gap is worse than one that is briefly behind, because the gap is
      // invisible to everything downstream.
      return {
        accepted: false,
        messages: [{ kind: "REPLAY_FROM", seq: expected }],
      };
    }

    const { event: appended, duplicate } = await this.deps.eventLog.append({
      sessionId: event.sessionId,
      type: event.type,
      actor: "CANDIDATE",
      scenarioVersionId: session.scenarioVersionId,
      payload: event.payload,
      traceId: session.traceId,
      idempotencyKey: event.idempotencyKey,
      occurredAt: event.occurredAt,
    });

    // A replayed event must not rewind the counter; a duplicate is not evidence
    // that later events were lost.
    if (event.clientSeq >= expected) {
      this.lastClientSeq.set(event.sessionId, event.clientSeq);
    }

    const messages: ServerMessage[] = [
      { kind: "ACK", clientSeq: event.clientSeq, seq: appended.seq },
    ];

    // Duplicates are acknowledged but produce no downstream effect.
    return { accepted: !duplicate, messages };
  }

  /**
   * Resume state after a reconnect.
   *
   * The client sends the last seq it acknowledged; it gets everything after that
   * plus a fresh state snapshot. A browser refresh mid-interview should cost the
   * candidate nothing but a moment.
   */
  async resume(sessionId: string, lastAckedSeq: number): Promise<HandleResult> {
    const session = await this.deps.sessions.get(sessionId);
    if (!session) {
      return {
        accepted: false,
        messages: [{ kind: "ERROR", code: "UNKNOWN_SESSION", message: sessionId }],
      };
    }

    const missed = await this.deps.eventLog.read(sessionId, lastAckedSeq + 1);

    return {
      accepted: true,
      messages: [
        ...missed.map<ServerMessage>((e) => ({ kind: "ACK", clientSeq: -1, seq: e.seq })),
        {
          kind: "STATE",
          state: session.state,
          remainingSeconds: remainingSeconds(session, this.now()),
          interviewerStatus: "LISTENING",
        },
      ],
    };
  }

  /** Called on disconnect so a reconnecting client is not treated as having gaps. */
  forget(sessionId: string): void {
    this.lastClientSeq.delete(sessionId);
  }
}
