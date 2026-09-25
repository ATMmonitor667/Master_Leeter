import {
  CandidateStateSchema,
  InterviewStateSchema,
  MilestoneKindSchema,
  RunResultSchema,
  type CandidateState,
  type GateDecision,
  type InterviewContext,
  type InterviewPolicy,
  type InterviewScenarioVersion,
  type InterviewState,
  type MilestoneKind,
  type RunResult,
  type SessionEvent,
  type Turn,
  emptyCandidateState,
} from "@master-leeter/contracts";
import { z } from "zod";
import {
  type MilestoneState,
  type SemanticSnapshot,
  type TranscriptObservation,
  applyComplexityMismatch,
  applyRunResult,
  buildSnapshot,
  emptyMilestoneState,
  observe,
  observeTranscript,
} from "../observer/index.js";
import { getHint, selectProbeWording } from "../scenario/probes.js";
import { type IntentClassifier, type TurnClassification, ruleBasedClassifier } from "./classifier.js";
import { decideAction } from "./gate.js";
import { INITIAL_STATE, applyEvent } from "./state-machine.js";
import { type StageSignals, isReasoningIntent, nextStage } from "./stage-advance.js";
import { estimateTurnCompletion, silenceRequiredFor, type ProsodicEvidence } from "./turn-completion.js";

/**
 * Interview Runtime — the live per-session orchestrator.
 *
 * This is the piece that was missing. The gate, the observer, the state
 * machine, and the scenario engine were all built and individually tested, but
 * nothing held the mutable session state that connects them, so `decideAction`
 * ran only in the simulator. This class is that holder, and it is deliberately
 * the ONLY place where live interview state is mutated.
 *
 * Two boundaries it exists to enforce:
 *
 *   1. **Nothing speaks without a gate decision.** `ingest` is the single
 *      entry point, and the only path from an event to an utterance runs
 *      through `decideAction`. There is no method that emits speech directly.
 *   2. **Observation is never on the critical path.** Code deltas mark state
 *      dirty and return; a single background pass coalesces them. A candidate
 *      typing quickly must never wait on Tree-sitter, and the gate must be able
 *      to notice that the observer is behind (that is what the staleness guard
 *      in rule 8 reads).
 *
 * Transport-free and storage-free by design. It appends through a narrow sink
 * rather than importing the session module, so the orchestrator stays a domain
 * layer that the session module calls into, not the other way round.
 */

/** The slice of the event log the orchestrator is allowed to touch: append only. */
export interface EventSink {
  append(req: {
    sessionId: string;
    type: SessionEvent["type"];
    actor: SessionEvent["actor"];
    scenarioVersionId: string;
    payload: Record<string, unknown>;
    traceId: string;
    idempotencyKey: string;
    occurredAt?: string;
    completedInputSeq?: number;
  }): Promise<{ event: SessionEvent; duplicate: boolean }>;
}

/**
 * What the interviewer should say, when the gate authorized speech.
 *
 * Returned to the caller rather than pushed anywhere. The voice agent (M3) will
 * speak it; the client gets only the action kind and an utterance id. Sending
 * this text down the app channel would render authored problem content into the
 * browser and break invariant 2 — the wording never crosses that boundary.
 */
export interface Utterance {
  utteranceId: string;
  action: GateDecision["action"];
  text: string;
  /** Code revision the wording was grounded in, when it refers to code. */
  groundedInRevision?: number;
}

export interface RuntimeResult {
  decision: GateDecision | null;
  utterance: Utterance | null;
  /** Server-measured deltas for latency ledger. Present only on SPEECH_FINAL turns. */
  serverTiming?: { decisionMs: number; classifierMs: number; classifierSource?: "SPECULATIVE" | "DIRECT" };
}

export interface InterviewRuntimeDeps {
  sessionId: string;
  scenario: InterviewScenarioVersion;
  policy: InterviewPolicy;
  scenarioVersionId: string;
  traceId: string;
  events: EventSink;
  /** Injected so the orchestrator never reaches into the session store. */
  remainingSeconds: () => number;
  classifier?: IntentClassifier;
  now?: () => number;
  /** Monotonic server elapsed clock; defaults to performance.now in production. */
  monotonicNow?: () => number;
  /** Release switch for the shorter turn-end window. */
  prosodyEnabled?: boolean;
  /**
   * Delivers a decision reached off the ingest path.
   *
   * A turn re-judged after its silence floor elapses is decided by a timer, so
   * no caller is awaiting it. Without this the interviewer would decide to
   * speak, log the decision, and never say anything.
   */
  onAuthorized?: (result: RuntimeResult) => void | Promise<void>;
  /** Injected so tests drive the re-evaluation clock instead of sleeping. */
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /**
   * Builds the semantic snapshot. Injected for the same reason as the clock.
   *
   * The staleness guard only fires while the observer is genuinely behind, and
   * a test that reaches that window by racing the microtask queue is measuring
   * how many `await`s happen to sit on the path — one more anywhere in `ingest`
   * flips it. With this the lag is a fact the test states, not an accident.
   */
  buildSnapshot?: typeof buildSnapshot;
  /**
   * Notified after a stage transition has been committed to the log (M1-2b).
   *
   * The orchestrator owns the stage; the session store holds the copy the HTTP
   * surface and the resume path read, and `transition()` is also what starts the
   * interview clock. Injected rather than imported so the orchestrator stays a
   * domain layer that the session module calls into.
   */
  onTransition?: (to: InterviewState, reason: string) => void | Promise<void>;
  /** Atomically persist stage + event when durable lifecycle storage is active. */
  commitTransition?: (from: InterviewState, to: InterviewState, reason: string) => void | Promise<void>;
}

const ProsodySchema = z.object({
  probability: z.number().finite().min(0).max(1),
  confidence: z.number().finite().min(0).max(1),
  reason: z.string().max(200).optional(),
});

const RuntimeCheckpointSchema = z.object({
  version: z.literal(1),
  state: InterviewStateSchema,
  candidateState: CandidateStateSchema,
  milestones: z.object({
    reached: z.array(MilestoneKindSchema),
    consecutiveIdenticalFailures: z.number().int().nonnegative(),
    lastFailureFingerprint: z.string().nullable(),
    lastSnapshotCode: z.string().nullable(),
  }),
  probeUseCounts: z.record(z.number().int().nonnegative()),
  followUpsUsed: z.array(z.string()),
  runsStarted: z.number().int().nonnegative(),
  reasoningTurnsInStage: z.number().int().nonnegative(),
  approachCommitted: z.boolean(),
  latestCodeRevision: z.number().int().nonnegative(),
  latestCode: z.string(),
  previousObservedCode: z.string().nullable(),
  lastCodeActivityMs: z.number().nonnegative(),
  lastSpokeAtMs: z.number().nonnegative(),
  candidateSpeechStarted: z.boolean(),
  lastSpeechStoppedAtMs: z.number().nonnegative().nullable(),
  lastProsody: ProsodySchema.nullable().optional(),
  answeredFactKeys: z.array(z.string()),
  briefDeliveryCount: z.number().int().nonnegative(),
  observationCount: z.number().int().nonnegative(),
});
type RuntimeCheckpoint = z.infer<typeof RuntimeCheckpointSchema>;

export class InterviewRuntime {
  private state: InterviewState = INITIAL_STATE;
  private candidateState: CandidateState;
  private milestones: MilestoneState = emptyMilestoneState();

  private readonly probeUseCounts: Record<string, number> = {};
  private readonly followUpsUsed: string[] = [];

  /**
   * Stage-advancement evidence (M1-2b).
   *
   * Counters rather than derived state because the driver has to answer
   * "has the candidate started testing yet?" without re-reading the log.
   * `reasoningTurnsInStage` resets on every transition — two think-alouds are
   * evidence of leaving CLARIFICATION only if they happened IN clarification.
   */
  private runsStarted = 0;
  private reasoningTurnsInStage = 0;
  private approachCommitted = false;

  /** Latest revision the SERVER has seen. May run ahead of the observer. */
  private latestCodeRevision = 0;
  private latestCode = "";
  private previousObservedCode: string | null = null;
  private lastCodeActivityMs: number;
  private lastSpokeAtMs: number;

  private interviewerCurrentlySpeaking = false;
  private candidateSpeechStarted = false;

  /**
   * When VAD last reported the candidate stopping, or null if they are speaking
   * or never started.
   *
   * Taken from the event's `occurredAt` rather than a wall clock on purpose:
   * turn-completion now depends on this interval, and replay must reproduce the
   * same gate decisions from the log alone (`replay.test.ts`). A wall-clock read
   * would make every decision a function of how fast the replay ran.
   */
  private lastSpeechStoppedAtMs: number | null = null;
  private lastProsody: ProsodicEvidence | null = null;

  /** Coalescing observation loop. At most one pass in flight, ever. */
  private observationDirty = false;
  private observationRunning: Promise<void> | null = null;
  private observationCount = 0;
  /**
   * Runs awaiting observation.
   *
   * A list, not a slot. Two failing runs can land inside one observation
   * window, and dropping the older one would under-count the identical-failure
   * streak — which is the evidence a debugging probe is justified by.
   */
  private readonly pendingRuns: RunResult[] = [];
  /** Finalized turns waiting for the asynchronous transcript observer. */
  private readonly pendingTranscripts: TranscriptObservation[] = [];

  /**
   * A turn the gate held only because not enough silence had elapsed.
   *
   * Kept so it can be judged again once the floor is crossed. Without this the
   * gate ran exactly once per turn, at whatever moment the transcript happened
   * to finalize — a few hundred milliseconds after the candidate stopped, with
   * browser transcription — and MOCK needs ~2.4 s. Every think-aloud turn was
   * therefore judged too early and never reconsidered, so the interviewer stayed
   * silent until the candidate spoke again.
   */
  private heldTurn: { turn: Turn; classification: TurnClassification; attempt: number } | null = null;
  private reevaluationTimer: ReturnType<typeof setTimeout> | null = null;
  /** Turn held only because candidateSpeakingNow was true; re-judged on SPEECH_STOPPED. */
  private speakingNowHeld: { turn: Turn; classification: TurnClassification } | null = null;
  private candidateSpeakingNow = false;
  /** Accumulated transcript across fragments of one logical turn. Reset when gate speaks. */
  private openTurn: { transcript: string } | null = null;
  /** Client silence delta plus server elapsed time; never subtract absolute cross-device clocks. */
  private silenceBasis: { clientSilenceMs: number; receivedMonoMs: number } | null = null;
  /** Live-only work. Neither speculation nor its cache is restored from the event log. */
  private readonly speculativeClassifications = new Map<string, { startedAt: number; result: Promise<TurnClassification | null> }>();
  private speculatedForTurn = false;
  private classifierSource: "SPECULATIVE" | "DIRECT" = "DIRECT";

  /**
   * The decision currently authorizing speech, if any.
   *
   * The voice agent's tools are checked against this: it may fetch the wording
   * for the probe the gate chose and nothing else. Cleared when the utterance
   * finishes, so a model that calls a tool a second later gets a refusal rather
   * than a second turn.
   */
  private authorized: { decision: GateDecision; utteranceId: string } | null = null;

  /** Fact keys already answered aloud, so the agent knows what it has said. */
  private readonly answeredFactKeys: string[] = [];

  /**
   * How many times the brief has been spoken.
   *
   * Zero means the interview has not opened. Above zero, a repeat request is
   * answered from the reviewed variants rather than by paraphrase.
   */
  private briefDeliveryCount = 0;

  /** Bounded log of utterance ids issued by this runtime, for latency report validation. */
  private readonly issuedUtteranceIds: string[] = [];
  private static readonly UTTERANCE_ID_WINDOW = 64;

  private readonly classifier: IntentClassifier;
  private readonly buildSnapshot: typeof buildSnapshot;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly prosodyEnabled: boolean;

  constructor(private readonly deps: InterviewRuntimeDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.monotonicNow = deps.monotonicNow ?? (deps.now ?? (() => performance.now()));
    this.classifier = deps.classifier ?? ruleBasedClassifier;
    this.buildSnapshot = deps.buildSnapshot ?? buildSnapshot;
    this.schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.prosodyEnabled = deps.prosodyEnabled ?? process.env.TURN_END_PROSODY !== "off";
    this.candidateState = emptyCandidateState(new Date(this.now()).toISOString());
    this.lastCodeActivityMs = this.now();
    this.lastSpokeAtMs = this.now();
  }

  /**
   * What the voice tool surface needs to answer a call.
   *
   * Plain data on purpose: the orchestrator does not import the realtime module,
   * so the session module composes this with the scenario and the clock. The
   * layering is the same as everywhere else — the orchestrator is a domain layer
   * that others call into.
   */
  voiceContext(): {
    state: InterviewState;
    candidateState: CandidateState;
    probeUseCounts: Readonly<Record<string, number>>;
    answeredFactKeys: readonly string[];
    authorized: GateDecision | null;
    utteranceId: string | null;
  } {
    const authorized =
      this.authorized && !this.staleGroundingReason(this.authorized.decision)
        ? this.authorized
        : null;
    if (!authorized && this.authorized) this.authorized = null;

    return {
      state: this.state,
      candidateState: this.candidateState,
      probeUseCounts: this.probeUseCounts,
      answeredFactKeys: [...this.answeredFactKeys],
      authorized: authorized?.decision ?? null,
      utteranceId: authorized?.utteranceId ?? null,
    };
  }

  /** Returns true when this runtime minted the given utterance id. Used to gate latency reports. */
  wasUtteranceIssued(utteranceId: string): boolean {
    return this.issuedUtteranceIds.includes(utteranceId);
  }

  /** Read-only view, for tests and for the resume path. Never mutate through this. */
  snapshotState(): {
    state: InterviewState;
    candidateState: CandidateState;
    milestones: readonly MilestoneKind[];
    latestCodeRevision: number;
    observedRevision: number;
  } {
    return {
      state: this.state,
      candidateState: this.candidateState,
      milestones: [...this.milestones.reached],
      latestCodeRevision: this.latestCodeRevision,
      observedRevision: this.candidateState.derivedFromRevision,
    };
  }

  /**
   * Source at `revision`, or null when the server has not seen that revision.
   *
   * RUN_REQUESTED carries only revision + stdin over the socket; the code itself
   * must already be in the log via CODE_DELTA.
   */
  codeAtRevision(revision: number): string | null {
    if (revision !== this.latestCodeRevision) return null;
    return this.latestCode;
  }

  /**
   * Apply one persisted event.
   *
   * Takes the event AFTER it has been appended, not the client's request, so
   * the runtime and the evidence log can never disagree about what happened.
   * Ordering is the log's `seq`, which is the same order the evaluator and any
   * replay will read.
   */
  async ingest(event: SessionEvent): Promise<RuntimeResult> {
    const result = await this.applyCommitted(event);

    // Stage advancement runs on every committed event (M1-2b). Skipped for the
    // two event types that ARE stage changes: re-deriving off an explicit
    // transition would let one instruction cascade into several, and a session
    // that has ended has nowhere left to advance to.
    if (event.type !== "STATE_TRANSITIONED" && event.type !== "SESSION_ENDED") {
      await this.advanceStages();
    }

    await this.persistCheckpoint(`event:${event.seq}`, event.seq);

    return result;
  }

  /**
   * Rebuild mutable policy state from recorded outputs without invoking models,
   * scheduling speech, or appending new evidence.
   */
  restore(events: readonly SessionEvent[]): void {
    let previousSeq = -1;
    for (const event of events) {
      if (event.sessionId !== this.deps.sessionId || event.scenarioVersionId !== this.deps.scenarioVersionId) {
        throw new Error("RUNTIME_HISTORY_PIN_MISMATCH");
      }
      if (event.seq !== previousSeq + 1) throw new Error("RUNTIME_HISTORY_GAP");
      previousSeq = event.seq;
    }

    let checkpointIndex = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === "RUNTIME_CHECKPOINT") {
        this.hydrateCheckpoint(events[i]!.payload);
        checkpointIndex = i;
        break;
      }
    }

    for (const event of events.slice(checkpointIndex + 1)) this.restoreEvent(event);

    // Delivery and authorization are tied to one process's live audio session.
    // Recovery never repeats audio or leaves a stale tool authorization open.
    this.authorized = null;
    this.interviewerCurrentlySpeaking = false;
    this.candidateSpeakingNow = false;
    this.openTurn = null;
    this.silenceBasis = null;
    this.speculativeClassifications.clear();
    this.speculatedForTurn = false;
    this.clearHeldTurn();
    this.observationDirty = false;
    this.pendingRuns.length = 0;
    this.pendingTranscripts.length = 0;
  }

  private hydrateCheckpoint(payload: Record<string, unknown>): void {
    const parsed = RuntimeCheckpointSchema.safeParse(payload);
    if (!parsed.success) throw new Error("INVALID_RUNTIME_CHECKPOINT");
    const checkpoint = parsed.data;
    this.state = checkpoint.state;
    this.candidateState = structuredClone(checkpoint.candidateState);
    this.milestones = structuredClone(checkpoint.milestones);
    this.replaceRecord(this.probeUseCounts, checkpoint.probeUseCounts);
    this.followUpsUsed.splice(0, this.followUpsUsed.length, ...checkpoint.followUpsUsed);
    this.runsStarted = checkpoint.runsStarted;
    this.reasoningTurnsInStage = checkpoint.reasoningTurnsInStage;
    this.approachCommitted = checkpoint.approachCommitted;
    this.latestCodeRevision = checkpoint.latestCodeRevision;
    this.latestCode = checkpoint.latestCode;
    this.previousObservedCode = checkpoint.previousObservedCode;
    this.lastCodeActivityMs = checkpoint.lastCodeActivityMs;
    this.lastSpokeAtMs = checkpoint.lastSpokeAtMs;
    this.candidateSpeechStarted = checkpoint.candidateSpeechStarted;
    this.lastSpeechStoppedAtMs = checkpoint.lastSpeechStoppedAtMs;
    this.lastProsody = this.prosodyEnabled ? checkpoint.lastProsody ?? null : null;
    this.answeredFactKeys.splice(0, this.answeredFactKeys.length, ...checkpoint.answeredFactKeys);
    this.briefDeliveryCount = checkpoint.briefDeliveryCount;
    this.observationCount = checkpoint.observationCount;
  }

  private replaceRecord(target: Record<string, number>, source: Record<string, number>): void {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, source);
  }

  /** Fold only recorded facts. Never classify a historical transcript here. */
  private restoreEvent(event: SessionEvent): void {
    const payload = event.payload;
    switch (event.type) {
      case "CODE_DELTA": {
        const revision = numberOf(payload["revision"]);
        const text = stringOf(payload["text"]);
        if (revision !== null && text !== null && revision >= this.latestCodeRevision) {
          this.latestCodeRevision = revision;
          this.latestCode = text;
          this.lastCodeActivityMs = Date.parse(event.occurredAt) || this.lastCodeActivityMs;
        }
        break;
      }
      case "RUN_REQUESTED":
        this.runsStarted += 1;
        break;
      case "RUN_COMPLETED": {
        this.runsStarted = Math.max(this.runsStarted, 1);
        const run = RunResultSchema.safeParse(payload);
        if (run.success) this.milestones = applyRunResult(this.milestones, run.data).state;
        break;
      }
      case "SPEECH_STARTED":
        this.candidateSpeechStarted = true;
        this.candidateSpeakingNow = true;
        this.lastSpeechStoppedAtMs = null;
        this.lastProsody = null;
        this.silenceBasis = null;
        break;
      case "SPEECH_STOPPED":
        this.candidateSpeakingNow = false;
        this.lastSpeechStoppedAtMs = Date.parse(event.occurredAt) || this.lastSpeechStoppedAtMs;
        this.lastProsody = this.prosodyOf(event);
        break;
      case "SPEECH_FINAL":
        this.candidateSpeechStarted = false;
        break;
      case "BARGE_IN":
        this.candidateSpeechStarted = true;
        this.candidateSpeakingNow = true;
        this.lastProsody = null;
        break;
      case "STATE_TRANSITIONED": {
        const to = stringOf(payload["to"]);
        if (to && InterviewStateSchema.safeParse(to).success) {
          this.state = applyEvent({ state: this.state, eventType: "STATE_TRANSITIONED", requestedState: to as InterviewState }).state;
          this.reasoningTurnsInStage = 0;
        }
        break;
      }
      case "SESSION_ENDED":
        this.state = "EVALUATION";
        break;
      case "ACTION_DECIDED": {
        const intent = stringOf(payload["intent"]);
        if (intent && isReasoningIntent(intent as TurnClassification["intent"])) this.reasoningTurnsInStage += 1;
        if (intent === "APPROACH_COMMITMENT") this.approachCommitted = true;
        if (payload["action"] !== "STAY_SILENT") this.lastSpokeAtMs = Date.parse(event.occurredAt) || this.lastSpokeAtMs;
        break;
      }
      case "BRIEF_DELIVERED": {
        const delivery = numberOf(payload["delivery"]);
        this.briefDeliveryCount = Math.max(this.briefDeliveryCount, delivery ?? 1);
        break;
      }
      case "CLARIFICATION_ANSWERED": {
        const key = stringOf(payload["factKey"]);
        if (key && !this.answeredFactKeys.includes(key)) this.answeredFactKeys.push(key);
        break;
      }
      case "PROBE_ASKED": {
        const id = stringOf(payload["probeId"]);
        if (id) {
          this.probeUseCounts[id] = (this.probeUseCounts[id] ?? 0) + 1;
          this.candidateState = { ...this.candidateState, probeHistory: [...this.candidateState.probeHistory, id] };
        }
        break;
      }
      case "HINT_GIVEN": {
        const level = numberOf(payload["level"]);
        if (level !== null && level >= 1 && level <= 4) {
          this.candidateState = {
            ...this.candidateState,
            hintsUsed: [...this.candidateState.hintsUsed, level as 1 | 2 | 3 | 4],
          };
        }
        break;
      }
      case "FOLLOW_UP_PRESENTED": {
        const id = stringOf(payload["followUpId"]);
        if (id && !this.followUpsUsed.includes(id)) this.followUpsUsed.push(id);
        break;
      }
      case "MILESTONE": {
        const kind = MilestoneKindSchema.safeParse(payload["kind"]);
        if (kind.success && !this.milestones.reached.includes(kind.data)) this.milestones.reached.push(kind.data);
        break;
      }
      case "CANDIDATE_STATE_UPDATED": {
        const restored = CandidateStateSchema.safeParse({
          ...this.candidateState,
          ...payload,
          updatedAt: event.occurredAt,
        });
        if (restored.success) this.candidateState = restored.data;
        this.observationCount += 1;
        if (this.candidateState.derivedFromRevision === this.latestCodeRevision) {
          this.previousObservedCode = this.latestCode;
        }
        break;
      }
      default:
        break;
    }
  }

  private checkpoint(): RuntimeCheckpoint {
    return {
      version: 1,
      state: this.state,
      candidateState: structuredClone(this.candidateState),
      milestones: structuredClone(this.milestones),
      probeUseCounts: { ...this.probeUseCounts },
      followUpsUsed: [...this.followUpsUsed],
      runsStarted: this.runsStarted,
      reasoningTurnsInStage: this.reasoningTurnsInStage,
      approachCommitted: this.approachCommitted,
      latestCodeRevision: this.latestCodeRevision,
      latestCode: this.latestCode,
      previousObservedCode: this.previousObservedCode,
      lastCodeActivityMs: this.lastCodeActivityMs,
      lastSpokeAtMs: this.lastSpokeAtMs,
      candidateSpeechStarted: this.candidateSpeechStarted,
      lastSpeechStoppedAtMs: this.lastSpeechStoppedAtMs,
      lastProsody: this.lastProsody,
      answeredFactKeys: [...this.answeredFactKeys],
      briefDeliveryCount: this.briefDeliveryCount,
      observationCount: this.observationCount,
    };
  }

  private async persistCheckpoint(key: string, completedInputSeq?: number): Promise<void> {
    await this.deps.events.append({
      sessionId: this.deps.sessionId,
      type: "RUNTIME_CHECKPOINT",
      actor: "SYSTEM",
      scenarioVersionId: this.deps.scenarioVersionId,
      payload: this.checkpoint(),
      traceId: this.deps.traceId,
      idempotencyKey: `runtime-checkpoint:${key}`,
      ...(completedInputSeq === undefined ? {} : { completedInputSeq }),
    });
  }

  private async applyCommitted(event: SessionEvent): Promise<RuntimeResult> {
    const none: RuntimeResult = { decision: null, utterance: null };

    switch (event.type) {
      case "CODE_DELTA": {
        const revision = numberOf(event.payload["revision"]);
        const text = stringOf(event.payload["text"]);
        // Out-of-order replay must not rewind the code. Same guard as resume.
        if (revision === null || text === null || revision < this.latestCodeRevision) return none;

        this.latestCodeRevision = revision;
        this.latestCode = text;
        this.lastCodeActivityMs = Date.parse(event.occurredAt) || this.now();
        this.scheduleObservation();
        return none;
      }

      case "RUN_REQUESTED":
        // Nothing to observe — the result is what carries evidence — but asking
        // for a run IS the moment the candidate starts testing, and that is what
        // moves the stage (M1-2b). Counted here rather than on completion so a
        // runner outage cannot pin a candidate in IMPLEMENTATION.
        this.runsStarted += 1;
        return none;

      case "RUN_COMPLETED": {
        // A result with no request seen — a reconnect, or a replay that starts
        // mid-session — still proves a run happened.
        this.runsStarted = Math.max(this.runsStarted, 1);
        this.pendingRuns.push(event.payload as unknown as RunResult);
        this.scheduleObservation();
        return none;
      }

      case "SPEECH_STARTED":
        // The candidate resumed. Whatever was waiting on silence is moot, and
        // acting on it now would answer a thought they have already continued.
        this.clearHeldTurn();
        this.candidateSpeechStarted = true;
        this.candidateSpeakingNow = true;
        // New speech invalidates the previous quiet period. Silence is measured
        // from the most recent stop, not the first one in the session.
        this.lastSpeechStoppedAtMs = null;
        this.lastProsody = null;
        return none;

      case "SPEECH_STOPPED": {
        // Still not permission to speak — that is the whole thesis, and nothing
        // here changes it (ADR-001). What it now does is note WHEN, because how
        // long the candidate has been quiet is the only evidence that separates
        // a finished thought from a breath (M4-2). The observation is recorded;
        // the decision still belongs to the gate, and only a finalized turn
        // reaches it.
        this.candidateSpeakingNow = false;
        this.lastSpeechStoppedAtMs = Date.parse(event.occurredAt) || this.now();
        this.lastProsody = this.prosodyOf(event);
        if (!this.speakingNowHeld) this.speculateFromBoundary(event);
        // A SPEECH_FINAL silenced only because candidateSpeakingNow can now be
        // re-judged: the floor has been yielded, so timing is the only blocker.
        if (this.speakingNowHeld && !this.heldTurn) {
          this.silenceBasis = { clientSilenceMs: 0, receivedMonoMs: this.monotonicNow() };
          this.heldTurn = {
            ...this.speakingNowHeld,
            attempt: 1,
            turn: { ...this.speakingNowHeld.turn,
              ...(this.lastProsody ? { prosody: this.lastProsody } : {}) },
          };
          this.speakingNowHeld = null;
          this.reevaluationTimer = this.schedule(() => {
            void this.onSilenceElapsed().catch(() => this.clearHeldTurn());
          }, 25);
        } else {
          this.speakingNowHeld = null;
        }
        return none;
      }

      case "BARGE_IN":
        this.clearHeldTurn();
        this.interviewerCurrentlySpeaking = false;
        this.candidateSpeechStarted = true;
        this.candidateSpeakingNow = true;
        this.lastProsody = null;
        this.silenceBasis = null;
        return none;

      case "SPEECH_FINAL":
        return this.evaluateTurn(event);

      case "SILENCE_ELAPSED": {
        // Replay reaches the re-judgement through here; live, the timer has
        // already appended this event and called the same path. Either way the
        // decision is a function of the log.
        const loggedSilence = numberOf(event.payload["silenceMs"]);
        const result = await this.reevaluate(
          Date.parse(event.occurredAt) || this.now(),
          loggedSilence !== null && loggedSilence >= 0 ? loggedSilence : undefined,
        );
        return result ?? none;
      }

      case "STATE_TRANSITIONED": {
        const to = stringOf(event.payload["to"]);
        // Throws on a forbidden transition rather than degrading — a stage
        // change that silently does not happen is far worse than a loud error.
        const result = applyEvent({
          state: this.state,
          eventType: "STATE_TRANSITIONED",
          ...(to ? { requestedState: to as InterviewState } : {}),
        });
        this.state = result.state;
        return none;
      }

      case "SESSION_STARTED":
        // The one utterance that is not a response. Routed through the gate like
        // everything else, so it lands in the log with an ACTION_DECIDED behind
        // it rather than as speech nobody authorized.
        return this.openInterview();

      case "SESSION_ENDED":
        this.state = applyEvent({ state: this.state, eventType: "SESSION_ENDED" }).state;
        this.openTurn = null;
        this.silenceBasis = null;
        this.speculativeClassifications.clear();
        this.speculatedForTurn = false;
        return none;

      default:
        return none;
    }
  }

  /** Resolves once no observation pass is pending. Tests await this; production does not. */
  async settled(): Promise<void> {
    while (this.observationRunning) {
      await this.observationRunning;
    }
  }

  // ── The gate path ──────────────────────────────────────────────────────────

  /**
   * A finalized candidate turn: the only event type that can produce speech.
   *
   * Note the order — classify, build context, ask the gate, THEN apply
   * consequences. The gate is handed a snapshot of the world and returns one
   * action; it never mutates anything itself, which is what keeps it replayable.
   */
  private async evaluateTurn(event: SessionEvent): Promise<RuntimeResult> {
    // A new turn supersedes any turn still waiting on silence.
    this.clearHeldTurn();

    const fragment = stringOf(event.payload["transcript"]) ?? "";
    const finalized = event.payload["finalized"] !== false;

    // Assemble multi-fragment turns. The provider can issue a SPEECH_FINAL for
    // each short pause; joining them until the gate authorizes speech means the
    // gate always judges the whole thought, not just the last breath-chunk.
    if (!this.openTurn) {
      this.openTurn = { transcript: fragment };
    } else {
      const joined = [this.openTurn.transcript, fragment].filter(Boolean).join(" ");
      this.openTurn = { transcript: joined.slice(0, TURN_TRANSCRIPT_CAP) };
    }
    const transcript = this.openTurn.transcript;

    const ingestStart = this.monotonicNow();
    const silenceAtFinalMs = this.silenceBefore(event);
    this.silenceBasis = silenceAtFinalMs === undefined ? null
      : { clientSilenceMs: silenceAtFinalMs, receivedMonoMs: ingestStart };

    // The only await between a turn arriving and the gate ruling on it. A model
    // classifier suspends here for a few hundred milliseconds, so anything read
    // into `ctx` below is read AFTER that gap, not before it — which is what we
    // want: the gate should judge the world as it is when it decides, not as it
    // was when the candidate stopped talking.
    const classifierStart = this.monotonicNow();
    const speculative = finalized ? this.speculativeClassifications.get(transcript) : undefined;
    const candidate = speculative && performance.now() - speculative.startedAt <= 30_000
      ? await speculative.result : null;
    const classification = candidate ?? await this.classifier.classify({ transcript, finalized });
    this.classifierSource = candidate ? "SPECULATIVE" : "DIRECT";
    const classifierMs = Math.max(0, Math.round(this.monotonicNow() - classifierStart));

    // Stage evidence from the words, folded BEFORE the gate rules on this turn
    // (M1-2b). Order matters: a candidate who commits to an approach while the
    // session still sits in CLARIFICATION should have that turn judged in
    // APPROACH_EXPLORATION, where probing is legal. Folding it afterwards would
    // cost the interviewer the probe that the commitment itself justified.
    if (finalized) {
      if (isReasoningIntent(classification.intent)) this.reasoningTurnsInStage += 1;
      if (classification.intent === "APPROACH_COMMITMENT") this.approachCommitted = true;
      await this.advanceStages();
    }

    // How long the candidate has been quiet, measured between two logged
    // timestamps. Undefined when no speech-stop preceded this turn — a text-only
    // client, or voice that has not reported one — and the estimator reads that
    // as unknown rather than zero.
    const silenceMs = this.silenceNow();

    const turn: Turn = {
      turnId: `turn-${event.seq}`,
      finalized,
      transcript,
      // Overwritten by `judge`, which owns the fusion. Kept in the shape a Turn
      // requires so the two entry points build one identically.
      semanticEndProbability: 0,
      intent: classification.intent,
      intentProbabilities: classification.intentProbabilities,
      endedAt: event.occurredAt,
      ...(this.lastProsody ? { prosody: this.lastProsody } : {}),
    };

    const result = await this.judge(turn, classification, silenceMs, 0);
    const decisionMs = Math.max(classifierMs, Math.round(this.monotonicNow() - ingestStart));

    // Observation starts only after this turn's gate decision. The transcript
    // can inform a later probe, but it must never race the decision about the
    // very utterance it came from.
    this.pendingTranscripts.push({
      transcript,
      intent: classification.intent,
      observedAt: event.occurredAt,
    });
    this.scheduleObservation();

    return { ...result, serverTiming: { decisionMs, classifierMs, classifierSource: this.classifierSource } };
  }

  private silenceNow(): number | undefined {
    const basis = this.silenceBasis;
    return basis ? Math.max(0, basis.clientSilenceMs + this.monotonicNow() - basis.receivedMonoMs) : undefined;
  }

  private speculateFromBoundary(event: SessionEvent): void {
    if (this.speculatedForTurn || this.classifier.id === ruleBasedClassifier.id) return;
    const status = this.classifier as IntentClassifier & { operationalStatus?: () => { circuit: string } };
    if (status.operationalStatus?.().circuit === "OPEN") return;

    const interim = stringOf(event.payload["interimTranscript"])?.trim().slice(0, 400) ?? "";
    const assembled = this.openTurn?.transcript ?? "";
    const transcript = (interim && assembled && (interim.startsWith(assembled) || assembled.endsWith(interim))
      ? (interim.length >= assembled.length ? interim : assembled)
      : [assembled, interim].filter(Boolean).join(" ")).slice(0, TURN_TRANSCRIPT_CAP).trim();
    if (!transcript) return;

    const now = performance.now();
    for (const [key, value] of this.speculativeClassifications) {
      if (now - value.startedAt > 30_000) this.speculativeClassifications.delete(key);
    }
    while (this.speculativeClassifications.size >= 8) {
      const oldest = this.speculativeClassifications.keys().next().value;
      if (oldest === undefined) break;
      this.speculativeClassifications.delete(oldest);
    }
    // Exact text is required for a hit. Even punctuation can change intent, so
    // a merely similar interim is never substituted for the finalized input.
    const speculativeClassifier = this.classifier as IntentClassifier & {
      classifySpeculative?: (input: { transcript: string; finalized: boolean }) => TurnClassification | Promise<TurnClassification>;
    };
    const result = Promise.resolve().then(() => speculativeClassifier.classifySpeculative
      ? speculativeClassifier.classifySpeculative({ transcript, finalized: true })
      : this.classifier.classify({ transcript, finalized: true })).catch(() => null);
    this.speculativeClassifications.set(transcript, { startedAt: now, result });
    this.speculatedForTurn = true;
  }

  /**
   * Judge a turn against the clock as it stands, and act.
   *
   * Called once when the transcript finalizes and, when that verdict was "held
   * for timing", once more after enough silence has actually elapsed. Both paths
   * share this so a re-judged turn cannot drift from a first-judged one.
   */
  private async judge(
    base: Turn,
    classification: TurnClassification,
    silenceMs: number | undefined,
    attempt: number,
  ): Promise<RuntimeResult> {
    // M4-2. The classifier judged the words; this weighs them against the clock.
    // The gate is unchanged and still thresholds one number — what changed is
    // that the number is now worth thresholding.
    const completion = estimateTurnCompletion({
      transcript: base.transcript,
      intent: base.intent,
      textEndProbability: classification.semanticEndProbability,
      ...(silenceMs !== undefined ? { silenceMs } : {}),
      ...(base.prosody ? { prosody: base.prosody } : {}),
      policy: this.deps.policy,
    });

    const turn: Turn = {
      ...base,
      semanticEndProbability: completion.endProbability,
      textEndProbability: completion.textEndProbability,
      ...(silenceMs !== undefined ? { silenceMsBeforeEnd: silenceMs } : {}),
      ...(base.prosody ? { prosody: base.prosody } : {}),
    };

    const ctx = this.buildContext(turn);
    let decision = decideAction(ctx, {
      scenario: this.deps.scenario,
      probeUseCounts: this.probeUseCounts,
      followUpsUsed: this.followUpsUsed,
      solvedOptimally: this.solvedOptimally(),
      briefDeliveryCount: this.briefDeliveryCount,
    });

    const initiallyStale = this.staleGroundingReason(decision);
    if (initiallyStale) {
      decision = {
        action: "STAY_SILENT",
        reason: initiallyStale,
        decidedByRule: true,
      };
    }

    const freshness = this.groundingMetrics(decision);

    // Every decision is recorded, including silence. "Why didn't it speak at
    // 14:32?" has to be answerable from the log alone, and the classification
    // is persisted alongside so replay stays deterministic once a MODEL
    // classifier replaces the stub (see replay.test.ts).
    await this.append("ACTION_DECIDED", "INTERVIEWER", {
      turnId: turn.turnId,
      action: decision.action,
      reason: decision.reason,
      decidedByRule: decision.decidedByRule,
      intent: classification.intent,
      // The fused number the gate actually thresholded, then the parts it was
      // made of. M4-5b's whole method is reading these back off real sessions
      // and asking which half got it wrong, which needs all three.
      semanticEndProbability: completion.endProbability,
      textEndProbability: completion.textEndProbability,
      turnEndReason: completion.reason,
      ...(completion.prosody ? {
        prosodyProbability: completion.prosody.probability,
        prosodyConfidence: completion.prosody.confidence,
        prosodyPull: completion.prosodyPull,
      } : {}),
      ...(completion.silenceMs !== undefined ? { silenceMs: completion.silenceMs } : {}),
      classifierId: classification.classifierId,
      classifierSource: this.classifierSource,
      ...(decision.probeId ? { probeId: decision.probeId } : {}),
      ...(decision.hintLevel ? { hintLevel: decision.hintLevel } : {}),
      ...(decision.factKey ? { factKey: decision.factKey } : {}),
      ...(decision.followUpId ? { followUpId: decision.followUpId } : {}),
      ...(decision.groundedInRevision !== undefined
        ? { groundedInRevision: decision.groundedInRevision }
        : {}),
      ...(freshness ? freshness : {}),
      ...(attempt > 0 ? { reevaluated: true } : {}),
    }, `action:${turn.turnId}:${attempt}`);

    if (decision.action === "STAY_SILENT") {
      // The common case, and it costs one append and nothing else.
      this.candidateSpeechStarted = false;
      if (this.candidateSpeakingNow && attempt === 0) {
        // Silenced only because the candidate is still speaking. Remember this
        // turn: SPEECH_STOPPED will promote it to heldTurn for re-evaluation.
        this.speakingNowHeld = { turn, classification };
      } else if (attempt < 2) {
        this.holdForSilence(turn, classification, completion, silenceMs, attempt);
      }
      return { decision, utterance: null };
    }

    // Appending yielded to the event log. A code delta can arrive during that
    // await, so re-check at the actual speech boundary rather than assuming the
    // gate's snapshot is still current.
    const staleAtSpeech = this.staleGroundingReason(decision);
    if (staleAtSpeech) {
      const silenced = {
        action: "STAY_SILENT" as const,
        reason: staleAtSpeech,
        decidedByRule: true,
      };
      await this.append(
        "ACTION_DECIDED",
        "INTERVIEWER",
        {
          turnId: turn.turnId,
          ...silenced,
          supersedesAction: decision.action,
          freshnessRejected: true,
          ...this.groundingMetrics(decision),
        },
        `action:${turn.turnId}:${attempt}:freshness`,
      );
      this.candidateSpeechStarted = false;
      return { decision: silenced, utterance: null };
    }

    const utterance = await this.realize(decision, turn);

    // The window in which the voice agent may fetch words. Opened by the gate,
    // closed by markSpeechFinished — nothing else opens it.
    this.authorized = utterance ? { decision, utteranceId: utterance.utteranceId } : null;

    this.lastSpokeAtMs = this.now();
    this.candidateSpeechStarted = false;
    // Held until the audio actually finishes. Gate rule 1 reads this to yield
    // the floor when the candidate talks over the interviewer, and a flag that
    // is never set makes that rule unreachable.
    if (utterance) {
      this.interviewerCurrentlySpeaking = true;
      // The interviewer is responding: the accumulated turn is answered.
      // The next SPEECH_FINAL starts a fresh turn, not a continuation.
      this.openTurn = null;
      this.silenceBasis = null;
      this.speculativeClassifications.clear();
      this.speculatedForTurn = false;
    }

    return { decision, utterance };
  }

  /**
   * Remember a turn the gate held only because the clock had not caught up, and
   * arrange to look at it again.
   *
   * The condition is narrow on purpose. `endProbability === HELD_FLOOR_CEILING`
   * or below, with timing known, is the one case where waiting changes the
   * answer — the words were confident enough and only the silence was short.
   * A turn held because the transcript trailed off mid-thought, or because the
   * model was genuinely unsure, is not improved by waiting, and re-judging it
   * would be a second chance to speak that nothing has justified.
   */
  private holdForSilence(
    turn: Turn,
    classification: TurnClassification,
    completion: { endProbability: number; textEndProbability: number },
    silenceMs: number | undefined,
    attempt: number,
  ): void {
    if (silenceMs === undefined) return;

    const threshold = this.deps.policy.endOfTurnThreshold;

    // Both conditions are the definition of "only the clock said no". Tested on
    // numbers rather than on `completion.reason`, which reads "held:" whenever
    // the ceiling *capped* the estimate — including when the capped value still
    // clears the threshold and the interviewer speaks. A predicate keyed on a
    // human-readable string was going to drift the first time someone improved
    // the wording.
    if (completion.endProbability >= threshold) return;
    if (completion.textEndProbability < threshold) return;

    const required = silenceRequiredFor(this.deps.policy.endOfTurnThreshold, this.deps.policy, turn.prosody);
    if (!Number.isFinite(required)) return;

    // A small margin past the crossing point, so a rounding error does not cost
    // a whole extra round trip.
    const waitMs = required - silenceMs + 25;
    if (waitMs <= 0) return;

    this.heldTurn = { turn, classification, attempt: attempt + 1 };
    this.reevaluationTimer = this.schedule(() => {
      void this.onSilenceElapsed().catch(() => this.clearHeldTurn());
    }, waitMs);
  }

  /**
   * The timer fired: record the moment, then re-judge against it.
   *
   * The append is what keeps this replayable. A bare timer would make the
   * decision a function of how fast the process ran; logging the moment makes it
   * a function of the log again, which is what `replay.test.ts` asserts and what
   * the evaluator depends on.
   */
  private async onSilenceElapsed(): Promise<void> {
    const held = this.heldTurn;
    if (!held) return;

    const occurredAt = new Date(this.now()).toISOString();
    const silenceMs = this.silenceNow();
    await this.append(
      "SILENCE_ELAPSED",
      "SYSTEM",
      { turnId: held.turn.turnId, ...(silenceMs !== undefined ? { silenceMs, basis: "client-delta+server-elapsed" } : {}) },
      `silence:${held.turn.turnId}:${held.attempt}`,
      occurredAt,
    );

    const result = await this.reevaluate(Date.parse(occurredAt), silenceMs);
    await this.persistCheckpoint(`silence:${held.turn.turnId}:${held.attempt}`);
    if (result?.decision && result.decision.action !== "STAY_SILENT") {
      // Nobody is awaiting this call — it came from a timer, not from ingest —
      // so an authorized action has to be handed back explicitly or it would be
      // decided, logged, and never spoken.
      await this.deps.onAuthorized?.(result);
    }
  }

  /**
   * Judge the held turn again, with silence measured to `atMs`.
   *
   * Shared by the live timer and by replay, which reaches it through
   * `ingest(SILENCE_ELAPSED)`. Same inputs, same decision, either way.
   */
  private async reevaluate(atMs: number, loggedSilenceMs?: number): Promise<RuntimeResult | null> {
    const held = this.heldTurn;
    if (!held) return null;

    this.clearHeldTurn();

    const silenceMs = loggedSilenceMs ??
      (this.lastSpeechStoppedAtMs === null ? undefined : Math.max(0, atMs - this.lastSpeechStoppedAtMs));

    return this.judge(held.turn, held.classification, silenceMs, held.attempt);
  }

  private clearHeldTurn(): void {
    this.heldTurn = null;
    this.speakingNowHeld = null;
    if (this.reevaluationTimer !== null) {
      clearTimeout(this.reevaluationTimer);
      this.reevaluationTimer = null;
    }
  }

  /** Stop local reevaluation when this process loses session ownership. */
  dispose(): void { this.clearHeldTurn(); }

  // ── The stage-advancement path (M1-2b) ─────────────────────────────────────

  /**
   * Move the interview forward as far as the evidence justifies.
   *
   * A loop rather than a single step, because one event can legitimately clear
   * more than one stage: a candidate who starts typing while the session is
   * still in CLARIFICATION has passed through APPROACH_EXPLORATION whether or
   * not they said anything in it. Each step is appended separately and each is
   * legal under `ALLOWED_TRANSITIONS`, so the log shows the path taken rather
   * than a jump nobody can account for.
   *
   * Every transition is recorded as a `STATE_TRANSITIONED` event and NOT as an
   * `ACTION_DECIDED` — see the header of `stage-advance.ts` for why routing this
   * through the gate would corrupt the interruption metric.
   */
  private async advanceStages(): Promise<void> {
    // Bounded by the length of the stage path. The transition graph is a
    // forward-only DAG so this cannot cycle, but a bug in a rule should read as
    // a stalled session rather than as a hung request.
    for (let step = 0; step < STAGE_ADVANCE_LIMIT; step++) {
      const advance = nextStage(this.stageSignals());
      if (!advance) return;

      const from = this.state;
      // Throws on a forbidden transition rather than degrading, same as the
      // ingest path. `nextStage` already checked, so reaching the throw means
      // the driver and the contract disagree — which must be loud.
      this.state = applyEvent({
        state: from,
        eventType: "STATE_TRANSITIONED",
        requestedState: advance.to,
      }).state;

      // Evidence of "they stopped asking and started reasoning" belongs to the
      // stage it happened in.
      this.reasoningTurnsInStage = 0;

      if (this.deps.commitTransition) {
        await this.deps.commitTransition(from, advance.to, advance.reason);
      } else {
        await this.append(
          "STATE_TRANSITIONED",
          "SYSTEM",
          { from, to: advance.to, reason: advance.reason },
          // Forward-only transitions mean each stage is entered at most once,
          // so the target state is a stable idempotency key.
          `stage:${advance.to}`,
        );
        await this.deps.onTransition?.(advance.to, advance.reason);
      }
    }
  }

  private stageSignals(): StageSignals {
    return {
      state: this.state,
      policy: this.deps.policy,
      briefDeliveryCount: this.briefDeliveryCount,
      reasoningTurnsInStage: this.reasoningTurnsInStage,
      latestCodeRevision: this.latestCodeRevision,
      // Either the candidate said so, or the transcript observer inferred it.
      approachCommitted: this.approachCommitted || this.candidateState.currentApproach !== null,
      runsStarted: this.runsStarted,
      milestones: this.milestones.reached,
      remainingSeconds: Math.max(0, Math.round(this.deps.remainingSeconds())),
      followUpsPresented: this.followUpsUsed.length,
      followUpsAvailable: this.deps.scenario.followUps.length,
    };
  }

  /**
   * Ask the gate to open the interview.
   *
   * There is no turn here, and that is why the brief rule sits above the turn
   * checks: an interview that waited for the candidate to speak first would
   * never begin, since the candidate is waiting to hear the problem.
   */
  private async openInterview(): Promise<RuntimeResult> {
    const ctx = this.buildContext(null);
    const decision = decideAction(ctx, {
      scenario: this.deps.scenario,
      probeUseCounts: this.probeUseCounts,
      followUpsUsed: this.followUpsUsed,
      solvedOptimally: this.solvedOptimally(),
      briefDeliveryCount: this.briefDeliveryCount,
    });

    if (decision.action === "STAY_SILENT") return { decision, utterance: null };

    await this.append(
      "ACTION_DECIDED",
      "INTERVIEWER",
      { action: decision.action, reason: decision.reason, decidedByRule: decision.decidedByRule },
      "action:opening",
    );

    const utterance = await this.realize(decision, {
      turnId: "opening",
      finalized: true,
      transcript: "",
      semanticEndProbability: 1,
      intent: "THINK_ALOUD",
      intentProbabilities: {},
      endedAt: new Date(this.now()).toISOString(),
    });

    this.authorized = utterance ? { decision, utteranceId: utterance.utteranceId } : null;
    this.lastSpokeAtMs = this.now();
    if (utterance) this.interviewerCurrentlySpeaking = true;

    return { decision, utterance };
  }

  /**
   * Quiet time between the last speech-stop and this finalized transcript.
   *
   * Both timestamps come off logged events, so this is a pure function of the
   * log. Returns undefined when there is no stop to measure from: unknown
   * timing, which the estimator treats as "no timing evidence" rather than as
   * zero silence.
   */
  private silenceBefore(event: SessionEvent): number | undefined {
    if (this.lastSpeechStoppedAtMs === null) return undefined;
    const finalAtMs = Date.parse(event.occurredAt);
    if (!Number.isFinite(finalAtMs)) return undefined;
    return Math.max(0, finalAtMs - this.lastSpeechStoppedAtMs);
  }

  /** Browser measurements are evidence only after strict range validation. */
  private prosodyOf(event: SessionEvent): ProsodicEvidence | null {
    if (!this.prosodyEnabled) return null;
    const raw = event.payload["prosody"];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const candidate = raw as Record<string, unknown>;
    const parsed = ProsodySchema.safeParse({
      probability: candidate["probability"],
      confidence: candidate["confidence"],
      ...(typeof candidate["reason"] === "string"
        ? { reason: candidate["reason"].slice(0, 200) } : {}),
    });
    return parsed.success ? parsed.data : null;
  }

  /**
   * The interviewer's audio finished playing.
   *
   * M3-5 calls this from the realtime response lifecycle. Until voice exists
   * the caller invokes it immediately after taking the utterance — which is
   * honest, because with no audio there is no window to be barged into. What
   * matters is that the flag is driven by a signal rather than left permanently
   * false, so the barge-in rule is live the moment audio is.
   */
  async markSpeechFinished(): Promise<void> {
    const completedUtteranceId = this.authorized?.utteranceId;
    const completedAction = this.authorized?.decision.action;
    this.interviewerCurrentlySpeaking = false;
    // The authorization does not outlive the utterance. A tool call arriving
    // after this is a model trying to take a second turn, and gets refused.
    this.authorized = null;
    if (completedAction === "DELIVER_BRIEF" && this.state === "ORAL_PROBLEM_DELIVERY") {
      await this.advanceStages();
    }
    if (completedUtteranceId) await this.persistCheckpoint(`speech-finished:${completedUtteranceId}`);
  }

  /**
   * Turns an authorized action into authored words and its evidence event.
   *
   * Every branch reads from the pinned scenario. There is no path here that
   * composes a sentence — the model picks among reviewed variants, and probes
   * the author never wrote cannot be asked (invariant 3, ADR-002).
   */
  private async realize(decision: GateDecision, turn: Turn): Promise<Utterance | null> {
    const utteranceId = `utt-${turn.turnId}`;
    this.issuedUtteranceIds.push(utteranceId);
    if (this.issuedUtteranceIds.length > InterviewRuntime.UTTERANCE_ID_WINDOW) {
      this.issuedUtteranceIds.shift();
    }
    const base = { utteranceId, action: decision.action } as const;

    switch (decision.action) {
      case "ANSWER_CLARIFICATION": {
        const fact = this.deps.scenario.facts.find((f) => f.key === decision.factKey);
        if (!fact) return null;
        await this.append(
          "CLARIFICATION_ANSWERED",
          "INTERVIEWER",
          { factKey: fact.key, turnId: turn.turnId },
          `clarification:${turn.turnId}`,
        );
        if (!this.answeredFactKeys.includes(fact.key)) this.answeredFactKeys.push(fact.key);
        return { ...base, text: fact.value };
      }

      case "ASK_PROBE": {
        const probe = this.deps.scenario.probes.find((p) => p.id === decision.probeId);
        if (!probe) return null;

        const useCount = this.probeUseCounts[probe.id] ?? 0;
        const text = selectProbeWording(probe, useCount);

        this.probeUseCounts[probe.id] = useCount + 1;
        this.candidateState = {
          ...this.candidateState,
          probeHistory: [...this.candidateState.probeHistory, probe.id],
        };

        await this.append(
          "PROBE_ASKED",
          "INTERVIEWER",
          {
            probeId: probe.id,
            intent: probe.questionIntent,
            turnId: turn.turnId,
            ...(decision.groundedInRevision !== undefined
              ? { groundedInRevision: decision.groundedInRevision }
              : {}),
          },
          `probe:${turn.turnId}`,
        );

        return {
          ...base,
          text,
          ...(decision.groundedInRevision !== undefined
            ? { groundedInRevision: decision.groundedInRevision }
            : {}),
        };
      }

      case "GIVE_HINT_L1":
      case "GIVE_HINT_L2": {
        const level = decision.hintLevel;
        if (level === undefined) return null;
        const hint = getHint(this.deps.scenario, level);

        this.candidateState = {
          ...this.candidateState,
          hintsUsed: [...this.candidateState.hintsUsed, level as 1 | 2 | 3 | 4],
        };

        await this.append(
          "HINT_GIVEN",
          "INTERVIEWER",
          { level, scoreImpact: hint.scoreImpact, turnId: turn.turnId },
          `hint:${turn.turnId}`,
        );

        return { ...base, text: hint.text };
      }

      case "PRESENT_FOLLOW_UP": {
        const followUp = this.deps.scenario.followUps.find((f) => f.id === decision.followUpId);
        if (!followUp) return null;

        this.followUpsUsed.push(followUp.id);
        await this.append(
          "FOLLOW_UP_PRESENTED",
          "INTERVIEWER",
          { followUpId: followUp.id, turnId: turn.turnId },
          `follow-up:${turn.turnId}`,
        );

        return { ...base, text: followUp.oralDelta };
      }

      case "DELIVER_BRIEF": {
        const brief = this.deps.scenario.oralBrief;
        // First telling is the opening script; later ones rotate through the
        // REVIEWED variants. Nothing here composes a retelling, because a
        // paraphrase is exactly how a second hearing leaks more than the first.
        const variants = brief.repeatVariants;
        const text =
          this.briefDeliveryCount === 0
            ? brief.openingScript
            : (variants[(this.briefDeliveryCount - 1) % variants.length] ?? brief.openingScript);

        this.briefDeliveryCount += 1;

        await this.append(
          "BRIEF_DELIVERED",
          "INTERVIEWER",
          { delivery: this.briefDeliveryCount, repeat: this.briefDeliveryCount > 1 },
          `brief:${this.briefDeliveryCount}`,
        );

        return { ...base, text };
      }

      case "ACKNOWLEDGE_BRIEFLY":
        // No authored content and nothing to cite. The voice agent produces a
        // short neutral acknowledgement from its persona prompt (M3-6); there
        // is deliberately no scenario text behind it to leak.
        return { ...base, text: "" };

      default:
        return null;
    }
  }

  private buildContext(turn: Turn | null): InterviewContext {
    const nowMs = this.now();
    return {
      sessionId: this.deps.sessionId,
      state: this.state,
      policy: this.deps.policy,
      candidateState: this.candidateState,
      turn,
      interviewerCurrentlySpeaking: this.interviewerCurrentlySpeaking,
      candidateSpeechStarted: this.candidateSpeechStarted,
      candidateSpeakingNow: this.candidateSpeakingNow,
      secondsSinceInterviewerLastSpoke: Math.max(0, (nowMs - this.lastSpokeAtMs) / 1000),
      secondsSinceCodeActivity: Math.max(0, (nowMs - this.lastCodeActivityMs) / 1000),
      remainingSeconds: Math.max(0, Math.round(this.deps.remainingSeconds())),
      hintsUsedCount: this.candidateState.hintsUsed.length,
      latestCodeRevision: this.latestCodeRevision,
      scenarioVersionId: this.deps.scenarioVersionId,
      traceId: this.deps.traceId,
    };
  }

  private solvedOptimally(): boolean {
    if (!this.milestones.reached.includes("BASE_TESTS_PASS")) return false;
    const family = this.deps.scenario.solutionFamilies.find(
      (f) => f.id === this.candidateState.detectedSolutionFamilyId,
    );
    return family?.isOptimal ?? false;
  }

  /** Why code-grounded speech is unsafe right now, or null when it is fresh. */
  private staleGroundingReason(decision: GateDecision): string | null {
    if (decision.groundedInRevision === undefined) return null;

    const lag = this.latestCodeRevision - decision.groundedInRevision;
    if (lag !== 0) {
      return `speech-time freshness rejected: grounded revision ${decision.groundedInRevision}, latest ${this.latestCodeRevision}`;
    }

    const observedAt = this.candidateState.codeObservedAt
      ? Date.parse(this.candidateState.codeObservedAt)
      : Number.NaN;
    if (!Number.isFinite(observedAt)) {
      return "speech-time freshness rejected: code observation age unknown";
    }

    const ageSeconds = Math.max(0, (this.now() - observedAt) / 1000);
    if (ageSeconds > this.deps.policy.maxCodeStalenessSeconds) {
      return `speech-time freshness rejected: observation ${ageSeconds.toFixed(1)}s old (max ${this.deps.policy.maxCodeStalenessSeconds}s)`;
    }
    return null;
  }

  /** Persisted on decisions so freshness can be monitored from the event log. */
  private groundingMetrics(decision: GateDecision): Record<string, number> | null {
    if (decision.groundedInRevision === undefined) return null;
    const observedAt = this.candidateState.codeObservedAt
      ? Date.parse(this.candidateState.codeObservedAt)
      : Number.NaN;
    return {
      codeRevisionLag: this.latestCodeRevision - decision.groundedInRevision,
      codeObservationAgeMs: Number.isFinite(observedAt)
        ? Math.max(0, this.now() - observedAt)
        : -1,
    };
  }

  // ── The observation path ───────────────────────────────────────────────────

  /**
   * Marks state dirty and ensures exactly one pass is running.
   *
   * Coalescing rather than queueing: if six deltas land while a parse is in
   * flight, the next pass sees the newest code once. Queueing them would parse
   * five revisions nobody will ever ask about, and would let a fast typist
   * build an unbounded backlog of stale work.
   */
  private scheduleObservation(): void {
    this.observationDirty = true;
    if (this.observationRunning) return;

    this.observationRunning = this.runObservations()
      .catch(() => {
        // A failed parse must not take down the interview. The observer stays
        // behind, the gate's staleness guard notices, and the interviewer stays
        // quiet — which is the correct degraded behavior.
      })
      .finally(() => {
        this.observationRunning = null;
        // A delta that arrived during the final pass still needs a pass.
        if (this.observationDirty) this.scheduleObservation();
      });
  }

  private async runObservations(): Promise<void> {
    while (this.observationDirty) {
      this.observationDirty = false;

      const revision = this.latestCodeRevision;
      const code = this.latestCode;
      const runs = this.pendingRuns.splice(0, this.pendingRuns.length);
      const transcripts = this.pendingTranscripts.splice(0, this.pendingTranscripts.length);

      let snapshot: SemanticSnapshot | undefined;
      if (code.length > 0) {
        snapshot = await this.buildSnapshot(
          code,
          revision,
          this.previousObservedCode === null ? undefined : { code: this.previousObservedCode },
        );
        this.previousObservedCode = code;
      }

      // Fold the snapshot once, then each run in arrival order. Passing the
      // snapshot only on the first fold keeps LARGE_REWRITE from being emitted
      // once per run that happens to share a window with it.
      const emitted: MilestoneKind[] = [];
      let folds = 0;

      const fold = (run?: RunResult): void => {
        const result = observe({
          previous: this.candidateState,
          milestones: this.milestones,
          ...(folds === 0 && snapshot ? { snapshot } : {}),
          ...(run ? { run } : {}),
          secondsSinceCodeActivity: Math.max(0, (this.now() - this.lastCodeActivityMs) / 1000),
          consecutiveFailures: this.milestones.consecutiveIdenticalFailures,
          now: new Date(this.now()).toISOString(),
        });
        this.candidateState = result.state;
        this.milestones = result.milestones;
        emitted.push(...result.emitted);
        folds++;
      };

      if (runs.length === 0) {
        fold();
      } else {
        for (const run of runs) fold(run);
      }

      for (const transcript of transcripts) {
        const result = observeTranscript(
          this.candidateState,
          this.milestones,
          this.deps.scenario,
          transcript,
        );
        this.candidateState = result.state;
        this.milestones = result.milestones;
        emitted.push(...result.emitted);
      }

      // A claim can arrive before code is classifiable, or vice versa. Checking
      // after both queues are folded makes either arrival order equivalent.
      const mismatch = applyComplexityMismatch(
        this.candidateState,
        this.milestones,
        this.deps.scenario,
      );
      this.milestones = mismatch.milestones;
      emitted.push(...mismatch.emitted);
      this.candidateState = {
        ...this.candidateState,
        milestonesReached: [...this.milestones.reached],
      };

      const pass = this.observationCount++;

      if (snapshot) {
        // The compact structural summary, never the source. This is what makes
        // "the interviewer knows about your code" possible without the file
        // entering a model context.
        await this.append(
          "SEMANTIC_SNAPSHOT",
          "SYSTEM",
          {
            revision: snapshot.revision,
            syntaxValid: snapshot.syntaxValid,
            functions: snapshot.functions,
            dataStructures: snapshot.dataStructures,
            callsMade: snapshot.callsMade,
            nonEmptyLines: snapshot.nonEmptyLines,
            changedRegions: snapshot.changedRegions,
            churn: snapshot.churn,
          },
          `snapshot:${pass}`,
        );
      }

      for (const [i, kind] of emitted.entries()) {
        await this.append("MILESTONE", "SYSTEM", { kind, revision }, `milestone:${pass}:${i}`);
      }

      await this.append(
        "CANDIDATE_STATE_UPDATED",
        "SYSTEM",
        {
          derivedFromRevision: this.candidateState.derivedFromRevision,
          codeObservedAt: this.candidateState.codeObservedAt ?? null,
          detectedSolutionFamilyId: this.candidateState.detectedSolutionFamilyId,
          currentApproach: this.candidateState.currentApproach,
          alternativesMentioned: this.candidateState.alternativesMentioned,
          claimedTime: this.candidateState.claimedTime,
          claimedSpace: this.candidateState.claimedSpace,
          understoodConstraints: this.candidateState.understoodConstraints,
          implementationProgress: this.candidateState.implementationProgress,
          recentCodeActivity: this.candidateState.recentCodeActivity,
          stuckScore: this.candidateState.stuckScore,
          milestonesReached: this.candidateState.milestonesReached,
        },
        `observation:${pass}`,
      );

      await this.persistCheckpoint(`observation:${pass}`);

      // BASE_TESTS_PASS is what opens the follow-up stage, and it lands here —
      // one observation pass after the run that earned it. Without this the
      // transition would wait for whatever the candidate happened to do next,
      // which on a solved problem is often nothing at all.
      await this.advanceStages();
    }
  }

  private async append(
    type: SessionEvent["type"],
    actor: SessionEvent["actor"],
    payload: Record<string, unknown>,
    idempotencyKey: string,
    occurredAt?: string,
  ): Promise<void> {
    await this.deps.events.append({
      sessionId: this.deps.sessionId,
      type,
      actor,
      scenarioVersionId: this.deps.scenarioVersionId,
      payload,
      traceId: this.deps.traceId,
      idempotencyKey,
      ...(occurredAt ? { occurredAt } : {}),
    });
  }
}

/**
 * Most stages one event may clear at once.
 *
 * The path from ORAL_PROBLEM_DELIVERY to WRAP_UP is six transitions long; the
 * limit is a guard against a rule bug, not a tuning parameter.
 */
const STAGE_ADVANCE_LIMIT = 8;

/**
 * Maximum assembled transcript length (characters).
 *
 * Fragments beyond this cap are truncated, not dropped — the gate still sees
 * the newest material. The bound keeps context sizes bounded when a candidate
 * thinks aloud at length without the gate ever authorizing a response.
 */
const TURN_TRANSCRIPT_CAP = 800;

function stringOf(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function numberOf(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
