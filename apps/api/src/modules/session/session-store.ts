import { randomUUID } from "node:crypto";
import type { InterviewerTone, InterviewMode, InterviewPolicy, InterviewState } from "@master-leeter/contracts";
import { INITIAL_STATE, policyFor } from "../orchestrator/index.js";
import type { LoadedScenario } from "../scenario/loader.js";

export const DEFAULT_INTERVIEW_SECONDS = 2_700;

/**
 * Session lifecycle (M2-1).
 *
 * A session PINS its scenario version and policy at creation and never
 * re-reads them (invariant 4). The content hash is stored alongside the version
 * id so a session can prove which bytes it ran against — retiring or editing a
 * scenario file afterwards cannot silently change what a past interview meant.
 */

export interface InterviewSession {
  id: string;
  userId: string;
  /** Immutable pin. */
  scenarioVersionId: string;
  scenarioHash: string;
  mode: InterviewMode;
  policy: InterviewPolicy;
  state: InterviewState;
  language: string;
  interviewerTone?: InterviewerTone;
  traceId: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  expectedSeconds: number;
  /** Accumulated pause time, so a voice drop does not eat the candidate's clock. */
  pausedSeconds: number;
}

export interface CreateSessionRequest {
  userId: string;
  scenario: LoadedScenario;
  mode: InterviewMode;
  language?: string;
  interviewerTone?: InterviewerTone;
  /** Preparation is outside this clock. Prepared interviews always pass 2700. */
  expectedSeconds?: number;
  /** Stable across retries. Two creates with the same key return the same session. */
  idempotencyKey: string;
}

export interface SessionStore {
  create(req: CreateSessionRequest): Promise<InterviewSession>;
  findByIdempotencyKey(userId: string, key: string): Promise<InterviewSession | null>;
  idsForUser(userId: string): Promise<string[]>;
  listForUser(
    userId: string,
    limit: number,
    before?: { createdAt: string; id: string },
  ): Promise<InterviewSession[]>;
  /** Question versions previously assigned to this account, excluding deleted sessions. */
  scenarioVersionIdsForUser(userId: string): Promise<string[]>;
  get(id: string): Promise<InterviewSession | null>;
  /** Started sessions whose server-owned interview budget has elapsed. */
  dueForCompletion(at?: string, limit?: number): Promise<InterviewSession[]>;
  /** Ended sessions whose private evidence has exceeded the retention window. */
  expiredEnded(before: string, limit?: number): Promise<InterviewSession[]>;
  /** Immutable private scenario snapshot used to rebuild a runtime after restart. */
  pinnedScenario(id: string): Promise<LoadedScenario | null>;
  /** Idempotent. Ending an ended session returns it unchanged. */
  end(id: string, at?: string): Promise<InterviewSession>;
  transition(id: string, state: InterviewState): Promise<InterviewSession>;
  addPause(id: string, seconds: number): Promise<InterviewSession>;
  /** Hide the session from normal reads before privacy redaction begins. */
  tombstone(id: string, at?: string): Promise<boolean>;
}

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, InterviewSession>();
  private readonly scenarios = new Map<string, LoadedScenario>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly tombstones = new Map<string, string>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  async create(req: CreateSessionRequest): Promise<InterviewSession> {
    const key = JSON.stringify([req.userId, req.idempotencyKey]);
    const existingId = this.byIdempotencyKey.get(key);
    if (existingId) {
      if (this.tombstones.has(existingId)) throw new Error("SESSION_DELETED");
      const existing = this.sessions.get(existingId);
      if (existing) return existing;
    }

    if (req.scenario.version.status !== "ACTIVE") {
      // Draft and retired versions stay loadable so past sessions replay, but
      // they may not start new ones.
      throw new Error(
        `Scenario ${req.scenario.version.id} is ${req.scenario.version.status}; only ACTIVE versions may start a session`,
      );
    }

    const policy = policyFor(req.mode);
    const session: InterviewSession = {
      id: randomUUID(),
      userId: req.userId,
      scenarioVersionId: req.scenario.version.id,
      scenarioHash: req.scenario.contentHash,
      mode: req.mode,
      policy,
      state: INITIAL_STATE,
      language: req.language ?? "python",
      interviewerTone: req.interviewerTone ?? "NORMAL",
      traceId: randomUUID(),
      createdAt: this.now(),
      startedAt: null,
      endedAt: null,
      expectedSeconds: req.expectedSeconds ?? DEFAULT_INTERVIEW_SECONDS,
      pausedSeconds: 0,
    };

    this.sessions.set(session.id, session);
    this.scenarios.set(session.id, structuredClone(req.scenario));
    this.byIdempotencyKey.set(key, session.id);
    return session;
  }

  /** Retry must succeed even when the bank is offline or the question was retired. */
  async findByIdempotencyKey(userId: string, key: string): Promise<InterviewSession | null> {
    const id = this.byIdempotencyKey.get(JSON.stringify([userId, key]));
    return id && !this.tombstones.has(id) ? this.sessions.get(id) ?? null : null;
  }

  async get(id: string): Promise<InterviewSession | null> {
    return this.tombstones.has(id) ? null : this.sessions.get(id) ?? null;
  }

  async dueForCompletion(at = this.now(), limit = 100): Promise<InterviewSession[]> {
    const nowMs = Date.parse(at);
    return [...this.sessions.values()]
      .filter((session) => !this.tombstones.has(session.id) && !session.endedAt &&
        Boolean(session.startedAt) && remainingSeconds(session, nowMs) === 0)
      .slice(0, limit);
  }

  async expiredEnded(before: string, limit = 100): Promise<InterviewSession[]> {
    return [...this.sessions.values()]
      .filter((session) => !this.tombstones.has(session.id) && Boolean(session.endedAt) && session.endedAt! <= before)
      .sort((a, b) => a.endedAt!.localeCompare(b.endedAt!) || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  async pinnedScenario(id: string): Promise<LoadedScenario | null> {
    if (this.tombstones.has(id)) return null;
    const scenario = this.scenarios.get(id);
    return scenario ? structuredClone(scenario) : null;
  }

  /** Every session belonging to a user. Drives account-scope deletion (M7-3). */
  async idsForUser(userId: string): Promise<string[]> {
    return [...this.sessions.values()].filter((s) => s.userId === userId && !this.tombstones.has(s.id)).map((s) => s.id);
  }

  async listForUser(
    userId: string,
    limit: number,
    before?: { createdAt: string; id: string },
  ): Promise<InterviewSession[]> {
    return [...this.sessions.values()]
      .filter((session) => session.userId === userId && !this.tombstones.has(session.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .filter((session) => !before || session.createdAt < before.createdAt ||
        (session.createdAt === before.createdAt && session.id < before.id))
      .slice(0, limit);
  }

  async scenarioVersionIdsForUser(userId: string): Promise<string[]> {
    return [...new Set([...this.sessions.values()]
      .filter((session) => session.userId === userId && !this.tombstones.has(session.id))
      .map((session) => session.scenarioVersionId))];
  }

  async end(id: string, at?: string): Promise<InterviewSession> {
    const session = this.require(id);
    if (session.endedAt) return session;

    const ended: InterviewSession = { ...session, endedAt: at ?? this.now(), state: "EVALUATION" };
    this.sessions.set(id, ended);
    return ended;
  }

  async transition(id: string, state: InterviewState): Promise<InterviewSession> {
    const session = this.require(id);
    if (session.endedAt) return session;
    const updated: InterviewSession = {
      ...session,
      state,
      startedAt: session.startedAt ?? this.now(),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  async addPause(id: string, seconds: number): Promise<InterviewSession> {
    if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error("INVALID_PAUSE");
    const session = this.require(id);
    if (session.endedAt) return session;
    const updated = { ...session, pausedSeconds: session.pausedSeconds + seconds };
    this.sessions.set(id, updated);
    return updated;
  }

  async tombstone(id: string, at = this.now()): Promise<boolean> {
    if (this.tombstones.has(id)) return false;
    if (!this.sessions.has(id)) throw new SessionNotFoundError(id);
    this.tombstones.set(id, at);
    return true;
  }

  private require(id: string): InterviewSession {
    if (this.tombstones.has(id)) throw new SessionNotFoundError(id);
    const session = this.sessions.get(id);
    if (!session) throw new SessionNotFoundError(id);
    return session;
  }
}

/**
 * Remaining interview time.
 *
 * Paused seconds are excluded. A candidate who loses their microphone for two
 * minutes has not spent two minutes of their interview, and restoring that time
 * is the difference between a technical fault and a ruined session.
 */
export function remainingSeconds(session: InterviewSession, nowMs: number): number {
  if (!session.startedAt) return session.expectedSeconds;
  if (session.endedAt) return 0;

  const elapsed = (nowMs - Date.parse(session.startedAt)) / 1000 - session.pausedSeconds;
  return Math.max(0, Math.round(session.expectedSeconds - elapsed));
}
