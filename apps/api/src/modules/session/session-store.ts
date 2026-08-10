import { randomUUID } from "node:crypto";
import type { InterviewMode, InterviewPolicy, InterviewState } from "@master-leeter/contracts";
import { INITIAL_STATE, policyFor } from "../orchestrator/index.js";
import type { LoadedScenario } from "../scenario/loader.js";

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
  /** Stable across retries. Two creates with the same key return the same session. */
  idempotencyKey: string;
}

export interface SessionStore {
  create(req: CreateSessionRequest): Promise<InterviewSession>;
  get(id: string): Promise<InterviewSession | null>;
  /** Idempotent. Ending an ended session returns it unchanged. */
  end(id: string, at?: string): Promise<InterviewSession>;
  transition(id: string, state: InterviewState): Promise<InterviewSession>;
  addPause(id: string, seconds: number): Promise<InterviewSession>;
}

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, InterviewSession>();
  private readonly byIdempotencyKey = new Map<string, string>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  async create(req: CreateSessionRequest): Promise<InterviewSession> {
    const existingId = this.byIdempotencyKey.get(req.idempotencyKey);
    if (existingId) {
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
      traceId: randomUUID(),
      createdAt: this.now(),
      startedAt: null,
      endedAt: null,
      // The scenario's own estimate wins over the policy default — a 25-minute
      // scenario should not be given 40 minutes because Mock mode says so.
      expectedSeconds: req.scenario.version.target.expectedMinutes * 60,
      pausedSeconds: 0,
    };

    this.sessions.set(session.id, session);
    this.byIdempotencyKey.set(req.idempotencyKey, session.id);
    return session;
  }

  async get(id: string): Promise<InterviewSession | null> {
    return this.sessions.get(id) ?? null;
  }

  /** Every session belonging to a user. Drives account-scope deletion (M7-3). */
  async idsForUser(userId: string): Promise<string[]> {
    return [...this.sessions.values()].filter((s) => s.userId === userId).map((s) => s.id);
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
    const updated: InterviewSession = {
      ...session,
      state,
      startedAt: session.startedAt ?? this.now(),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  async addPause(id: string, seconds: number): Promise<InterviewSession> {
    const session = this.require(id);
    const updated = { ...session, pausedSeconds: session.pausedSeconds + seconds };
    this.sessions.set(id, updated);
    return updated;
  }

  private require(id: string): InterviewSession {
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
