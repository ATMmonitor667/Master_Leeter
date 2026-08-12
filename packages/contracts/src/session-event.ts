import { z } from "zod";
import { InterviewActionSchema, InterviewStateSchema } from "./interview-state.js";

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
  /** Candidate spoke over the interviewer; output audio was cut. */
  "BARGE_IN",

  // ── Interviewer output ───────────────────────────────────────────────────
  "ACTION_DECIDED",
  "BRIEF_DELIVERED",
  "CLARIFICATION_ANSWERED",
  "PROBE_ASKED",
  "HINT_GIVEN",
  "FOLLOW_UP_PRESENTED",

  // ── Code and notes ───────────────────────────────────────────────────────
  "CODE_DELTA",
  "SEMANTIC_SNAPSHOT",
  "NOTE_DELTA",
  "RUN_REQUESTED",
  "RUN_COMPLETED",
  "MILESTONE",

  // ── Observer ─────────────────────────────────────────────────────────────
  "CANDIDATE_STATE_UPDATED",

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

/**
 * Event types a CLIENT is allowed to emit.
 *
 * A strict subset of `EVENT_TYPES`, and the narrowing is load-bearing.
 *
 * `EVENT_TYPES` is one flat namespace that mixes two different things: records
 * of what the candidate did, and records of what the system concluded. The
 * envelope below used to accept the whole enum, which meant a browser could
 * append `RUN_COMPLETED`, `MILESTONE`, or `HINT_GIVEN` straight into the
 * append-only log. `actor` is server-assigned so the authorship was never
 * forgeable — but nothing downstream reads `actor`. The evaluator switches on
 * `type` alone, and `InterviewRuntime.ingest` folds a `RUN_COMPLETED` into the
 * observer wherever it came from, firing `BASE_TESTS_PASS`, clearing
 * `stuckScore`, and flipping `solvedOptimally`.
 *
 * With one user on localhost that is not an attacker story. It is an integrity
 * one: invariant 8 makes this log the evidence substrate for scoring and
 * replay, and a client bug that injected a spurious milestone would be
 * permanent, by design. Thresholds tuned against it (M4-5b) would be tuned
 * against noise.
 *
 * So the client may state what it *did* — typed, ran, spoke, interrupted — and
 * nothing about what any of it *meant*. Conclusions are the server's to draw.
 *
 * Adding a type here is a real decision: it must have exactly one server-side
 * consumer, and `client-events.test.ts` fails until that is declared.
 */
export const CLIENT_EVENT_TYPES = [
  "CODE_DELTA",
  "NOTE_DELTA",
  "RUN_REQUESTED",
  "SPEECH_STARTED",
  "SPEECH_STOPPED",
  "SPEECH_FINAL",
  "BARGE_IN",
] as const;

export const ClientEventTypeSchema = z.enum(CLIENT_EVENT_TYPES);
export type ClientEventType = z.infer<typeof ClientEventTypeSchema>;

/**
 * Types only the server may author.
 *
 * Derived rather than listed, so a new entry in `EVENT_TYPES` is server-only by
 * default. The safe direction: forgetting to classify a new type withholds a
 * capability from the client instead of silently granting one.
 */
export const SERVER_ONLY_EVENT_TYPES = EVENT_TYPES.filter(
  (t): t is Exclude<EventType, ClientEventType> =>
    !(CLIENT_EVENT_TYPES as readonly string[]).includes(t),
);

/**
 * Client → server envelope.
 *
 * Reconnects WILL replay events. `idempotencyKey` is how the server drops
 * duplicates safely; `clientSeq` is how it detects gaps and requests replay.
 */
export const ClientEventSchema = z.object({
  sessionId: z.string().uuid(),
  clientSeq: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1),
  /** Narrowed on purpose — see CLIENT_EVENT_TYPES. */
  type: ClientEventTypeSchema,
  occurredAt: z.string().datetime(),
  payload: z.record(z.unknown()),
});
export type ClientEvent = z.infer<typeof ClientEventSchema>;

/** Server → client. Status only — never the problem statement, never evaluator reasoning. */
export const ServerMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ACK"),
    clientSeq: z.number().int().nonnegative(),
    seq: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("STATE"),
    state: InterviewStateSchema,
    remainingSeconds: z.number().int().nonnegative(),
    interviewerStatus: z.enum(["LISTENING", "WAITING", "SPEAKING"]),
  }),
  z.object({ kind: z.literal("RUN_RESULT"), result: RunResultSchema }),
  z.object({
    kind: z.literal("ACTION"),
    action: InterviewActionSchema,
    /** Present only for actions that produce speech. */
    utteranceId: z.string().optional(),
  }),
  z.object({ kind: z.literal("REPLAY_FROM"), seq: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("ERROR"), code: z.string(), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
