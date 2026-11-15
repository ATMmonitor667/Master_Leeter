import { z } from "zod";

/**
 * The append-only session event log.
 *
 * This is the evidence substrate for scoring, replay, and debugging
 * (CLAUDE.md invariant 8, ADR-003). Nothing in the system updates or deletes a
 * persisted event. Ordering is by strictly increasing `seq` within a session.
 */

export const EVENT_ACTORS = ["CANDIDATE", "INTERVIEWER", "SYSTEM"] as const;
export const ActorSchema = z.enum(EVENT_ACTORS);
export type Actor = z.infer<typeof ActorSchema>;

export const EVENT_TYPES = [
  // ── Session lifecycle ────────────────────────────────────────────────────
  "SESSION_STARTED",
  "SESSION_ENDED",
  /** One thing either speaker said, in voice or chat: {speaker, text, medium}. */
  "TRANSCRIPT_TURN",
  /** A cue the interview software sent the interviewer: {kind, n}. */
  "CUE",
  /** Atomic text submission + interviewer response, with a server turn number. */
  "CHAT_TURN",
  /** Confirmed resume facts for a text interview; fully removed by redaction. */
  "CHAT_CONTEXT",
  /** Post-session professor review turn; never read by the live interviewer or grader. */
  "CHAT_REVIEW_TURN",
  "STATE_TRANSITIONED",
  "TIMER_PAUSED",
  "TIMER_RESUMED",

  // ── Speech ───────────────────────────────────────────────────────────────
  /** VAD detected speech start. Emitted WITHOUT creating a model response. */
  "SPEECH_STARTED",
  /** VAD detected speech stop. Still not permission to speak. */
  "SPEECH_STOPPED",
  /** Finalized transcript. The gate only acts on finalized turns. */
  "SPEECH_FINAL",
  /**
   * A held turn's quiet period crossed the policy floor. Server-authored.
   *
   * The gate used to run only on `SPEECH_FINAL`, which meant a turn whose
   * transcript finalized *before* the floor elapsed was judged too early and
   * never looked at again — the interviewer went quiet until the candidate spoke
   * next. Browser transcription finalizes in a few hundred milliseconds and MOCK
   * needs ~2.4s, so that was every think-aloud turn.
   *
   * This exists rather than a bare timer because the timer would break replay.
   * Decisions are a function of the log (MVP definition-of-done #8), so the
   * moment of re-evaluation has to BE in the log. Live, a timer appends this;
   * on replay it is already there and reproduces the same decision.
   */
  "SILENCE_ELAPSED",
  /** Candidate spoke over the interviewer; output audio was cut. */
  "BARGE_IN",

  // ── Interviewer output ───────────────────────────────────────────────────
  "ACTION_DECIDED",
  "BRIEF_DELIVERED",
  "CLARIFICATION_ANSWERED",
  "PROBE_ASKED",
  "HINT_GIVEN",
  "FOLLOW_UP_PRESENTED",
  /**
   * How an authorized utterance actually ended: COMPLETED, INTERRUPTED,
   * FAILED or CANCELLED, with whether any audio reached playback. Authorizing
   * speech is not evidence it was heard; this is the record that says what
   * happened after. Reported by the browser, validated against the open
   * authorization, server-appended.
   */
  "UTTERANCE_OUTCOME",

  // ── Code and notes ───────────────────────────────────────────────────────
  "CODE_DELTA",
  "SEMANTIC_SNAPSHOT",
  "NOTE_DELTA",
  "RUN_REQUESTED",
  "RUN_COMPLETED",
  "MILESTONE",

  // ── Observer ─────────────────────────────────────────────────────────────
  "CANDIDATE_STATE_UPDATED",
  /** Compact authoritative runtime state used for restart recovery. */
  "RUNTIME_CHECKPOINT",

  // ── Telemetry ────────────────────────────────────────────────────────────
  /** Client-measured per-utterance latency breakdown. Server-only (never in CLIENT_EVENT_TYPES). */
  "VOICE_LATENCY_MEASURED",

  // ── Faults ───────────────────────────────────────────────────────────────
  "CONNECTION_LOST",
  "CONNECTION_RESTORED",
  "RUNNER_UNAVAILABLE",
  "MODEL_ERROR",
] as const;

export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

export const MILESTONE_KINDS = [
  "FIRST_COMPILES",
  "BASE_TESTS_PASS",
  "COMPLEXITY_CLAIM_MISMATCH",
  "REPEATED_SAME_FAILURE",
  "LARGE_REWRITE",
] as const;
export const MilestoneKindSchema = z.enum(MILESTONE_KINDS);
export type MilestoneKind = z.infer<typeof MilestoneKindSchema>;

/**
 * Normalized run result. Language-specific runner output is normalized here so
 * the observer and evaluator never branch on runtime.
 */
export const RUN_STATUSES = [
  "PASSED",
  "FAILED",
  "COMPILE_ERROR",
  "RUNTIME_ERROR",
  "TIMEOUT",
  "MEMORY_EXCEEDED",
  "INTERNAL_ERROR",
] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunResultSchema = z.object({
  runId: z.string(),
  language: z.string(),
  /** Which code revision was executed. Never report a run against an unknown revision. */
  codeRevision: z.number().int().nonnegative(),
  inputHash: z.string(),
  status: RunStatusSchema,
  exitCode: z.number().int().nullable(),
  cpuTimeMs: z.number().nonnegative(),
  memoryKb: z.number().nonnegative(),
  /** Truncated server-side. Never render raw terminal escapes to the client. */
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  visibleTestsPassed: z.number().int().nonnegative().optional(),
  visibleTestsTotal: z.number().int().nonnegative().optional(),
});
export type RunResult = z.infer<typeof RunResultSchema>;

/**
 * The event envelope.
 *
 * `payload` is intentionally loose at the contract boundary — each module
 * narrows it with its own schema. What is NOT loose: seq, ordering, actor,
 * pinned scenario version, evidence hash, and trace ID. Those are what make the
 * log replayable and auditable.
 */
export const SessionEventSchema = z.object({
  sessionId: z.string().uuid(),
  /** Strictly increasing within a session. Gaps are a bug; duplicates are ignored. */
  seq: z.number().int().nonnegative(),
  occurredAt: z.string().datetime(),
  type: EventTypeSchema,
  actor: ActorSchema,
  /** Immutable version pin. A session's events never span two scenario versions. */
  scenarioVersionId: z.string(),
  payload: z.record(z.unknown()),
  /** Content hash of the payload. Lets the evaluator cite evidence tamper-evidently. */
  evidenceHash: z.string(),
  traceId: z.string(),
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;
