/**
 * Connection lease and timer pausing (M7-1).
 *
 * A 40-minute session will drop. What happens next is the difference between a
 * technical fault and a ruined interview, so the rules are explicit:
 *
 *   - A brief blip does NOT pause the clock. Networks hiccup constantly, and a
 *     timer that stopped and started every few seconds would be more unsettling
 *     than a timer that occasionally loses two seconds.
 *   - A sustained disconnect DOES pause it, and the paused time is credited
 *     back. Nobody should lose interview minutes to a dropped WebSocket.
 *   - Reconnecting never advances the interview state. The candidate resumes
 *     exactly where they were; the scenario never silently moves on.
 *
 * Deliberately not Redis-backed yet. The lease is per-process state, which is
 * correct for a single-node MVP and is the first thing to move when sessions
 * need to survive a node restart.
 */

/** Below this, a disconnect is a blip and the clock keeps running. */
export const GRACE_SECONDS = 10;

export interface LeaseState {
  connected: boolean;
  /** Epoch ms of the disconnect currently in progress, if any. */
  disconnectedAt: number | null;
  /** Total seconds credited back so far. */
  pausedSeconds: number;
  /** Disconnects seen, including blips. Surfaced in the report as a caveat. */
  dropCount: number;
}

export function newLease(): LeaseState {
  return { connected: true, disconnectedAt: null, pausedSeconds: 0, dropCount: 0 };
}

export function onDisconnect(lease: LeaseState, nowMs: number): LeaseState {
  // Already disconnected: keep the original timestamp. Two close-together
  // close events must not restart the grace window and lose the credit.
  if (!lease.connected) return lease;

  return {
    ...lease,
    connected: false,
    disconnectedAt: nowMs,
    dropCount: lease.dropCount + 1,
  };
}

export interface ReconnectResult {
  lease: LeaseState;
  /** Seconds credited back by this reconnect. Zero for a blip. */
  creditedSeconds: number;
}

export function onReconnect(lease: LeaseState, nowMs: number): ReconnectResult {
  if (lease.connected || lease.disconnectedAt === null) {
    return { lease, creditedSeconds: 0 };
  }

  const downSeconds = Math.max(0, Math.round((nowMs - lease.disconnectedAt) / 1000));

  // Only the time beyond the grace window is credited. Crediting from the first
  // millisecond would let a flaky connection quietly extend the interview.
  const credited = downSeconds > GRACE_SECONDS ? downSeconds - GRACE_SECONDS : 0;

  return {
    lease: {
      ...lease,
      connected: true,
      disconnectedAt: null,
      pausedSeconds: lease.pausedSeconds + credited,
    },
    creditedSeconds: credited,
  };
}

/**
 * Whether the clock should currently be running.
 *
 * Used for the live timer while a disconnect is still in progress — the credit
 * is only applied on reconnect, but the candidate should not watch their time
 * drain while staring at a "reconnecting" banner.
 */
export function isTimerRunning(lease: LeaseState, nowMs: number): boolean {
  if (lease.connected || lease.disconnectedAt === null) return true;
  return (nowMs - lease.disconnectedAt) / 1000 <= GRACE_SECONDS;
}

/** Seconds currently owed but not yet credited, for the in-progress disconnect. */
export function pendingCredit(lease: LeaseState, nowMs: number): number {
  if (lease.connected || lease.disconnectedAt === null) return 0;
  const down = Math.max(0, Math.round((nowMs - lease.disconnectedAt) / 1000));
  return down > GRACE_SECONDS ? down - GRACE_SECONDS : 0;
}

/**
 * Whether a session has been gone long enough to treat as abandoned.
 *
 * Ending it automatically is deliberate: an interview left open forever
 * produces no report, and the evaluator can only run on a session that has
 * actually finished.
 */
export const ABANDON_SECONDS = 15 * 60;

export function isAbandoned(lease: LeaseState, nowMs: number): boolean {
  if (lease.connected || lease.disconnectedAt === null) return false;
  return (nowMs - lease.disconnectedAt) / 1000 >= ABANDON_SECONDS;
}
