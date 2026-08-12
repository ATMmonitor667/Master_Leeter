import {
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
import {
  type MilestoneState,
  type SemanticSnapshot,
  buildSnapshot,
  emptyMilestoneState,
  observe,
} from "../observer/index.js";
import { getHint, selectProbeWording } from "../scenario/probes.js";
import { type IntentClassifier, ruleBasedClassifier } from "./classifier.js";
import { decideAction } from "./gate.js";
import { INITIAL_STATE, applyEvent } from "./state-machine.js";
import { estimateTurnCompletion } from "./turn-completion.js";

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
}

export class InterviewRuntime {
  private state: InterviewState = INITIAL_STATE;
  private candidateState: CandidateState;
  private milestones: MilestoneState = emptyMilestoneState();

  private readonly probeUseCounts: Record<string, number> = {};
  private readonly followUpsUsed: string[] = [];

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

  private readonly classifier: IntentClassifier;
  private readonly now: () => number;

  constructor(private readonly deps: InterviewRuntimeDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.classifier = deps.classifier ?? ruleBasedClassifier;
    this.candidateState = emptyCandidateState(new Date(this.now()).toISOString());
    this.lastCodeActivityMs = this.now();
    this.lastSpokeAtMs = this.now();
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

      case "RUN_COMPLETED": {
        this.pendingRuns.push(event.payload as unknown as RunResult);
        this.scheduleObservation();
        return none;
      }

      case "SPEECH_STARTED":
        this.candidateSpeechStarted = true;
        // New speech invalidates the previous quiet period. Silence is measured
        // from the most recent stop, not the first one in the session.
        this.lastSpeechStoppedAtMs = null;
        return none;

      case "SPEECH_STOPPED":
        // Still not permission to speak — that is the whole thesis, and nothing
        // here changes it (ADR-001). What it now does is note WHEN, because how
        // long the candidate has been quiet is the only evidence that separates
        // a finished thought from a breath (M4-2). The observation is recorded;
        // the decision still belongs to the gate, and only a finalized turn
        // reaches it.
        this.lastSpeechStoppedAtMs = Date.parse(event.occurredAt) || this.now();
        return none;

      case "BARGE_IN":
        this.interviewerCurrentlySpeaking = false;
        this.candidateSpeechStarted = true;
        return none;

      case "SPEECH_FINAL":
        return this.evaluateTurn(event);

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

      case "SESSION_ENDED":
        this.state = applyEvent({ state: this.state, eventType: "SESSION_ENDED" }).state;
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
    const transcript = stringOf(event.payload["transcript"]) ?? "";
    const finalized = event.payload["finalized"] !== false;

    // The only await between a turn arriving and the gate ruling on it. A model
    // classifier suspends here for a few hundred milliseconds, so anything read
    // into `ctx` below is read AFTER that gap, not before it — which is what we
    // want: the gate should judge the world as it is when it decides, not as it
    // was when the candidate stopped talking.
    const classification = await this.classifier.classify({ transcript, finalized });

    // How long the candidate has been quiet, measured between two logged
    // timestamps. Undefined when no speech-stop preceded this turn — a text-only
    // client, or voice that has not reported one — and the estimator reads that
    // as unknown rather than zero.
    const silenceMs = this.silenceBefore(event);

    // M4-2. The classifier judged the words; this weighs them against the clock.
    // The gate is unchanged and still thresholds one number — what changed is
    // that the number is now worth thresholding.
    const completion = estimateTurnCompletion({
      transcript,
      intent: classification.intent,
      textEndProbability: classification.semanticEndProbability,
      ...(silenceMs !== undefined ? { silenceMs } : {}),
      policy: this.deps.policy,
    });

    const turn: Turn = {
      turnId: `turn-${event.seq}`,
      finalized,
      transcript,
      semanticEndProbability: completion.endProbability,
      textEndProbability: completion.textEndProbability,
      ...(silenceMs !== undefined ? { silenceMsBeforeEnd: silenceMs } : {}),
      intent: classification.intent,
      intentProbabilities: classification.intentProbabilities,
      endedAt: event.occurredAt,
    };

    const ctx = this.buildContext(turn);
    const decision = decideAction(ctx, {
      scenario: this.deps.scenario,
      probeUseCounts: this.probeUseCounts,
      followUpsUsed: this.followUpsUsed,
      solvedOptimally: this.solvedOptimally(),
    });

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
      ...(completion.silenceMs !== undefined ? { silenceMs: completion.silenceMs } : {}),
      classifierId: classification.classifierId,
      ...(decision.probeId ? { probeId: decision.probeId } : {}),
      ...(decision.hintLevel ? { hintLevel: decision.hintLevel } : {}),
      ...(decision.factKey ? { factKey: decision.factKey } : {}),
      ...(decision.followUpId ? { followUpId: decision.followUpId } : {}),
      ...(decision.groundedInRevision !== undefined
        ? { groundedInRevision: decision.groundedInRevision }
        : {}),
    }, `action:${turn.turnId}`);

    if (decision.action === "STAY_SILENT") {
      // The common case, and it costs one append and nothing else.
      this.candidateSpeechStarted = false;
      return { decision, utterance: null };
    }

    const utterance = await this.realize(decision, turn);

    this.lastSpokeAtMs = this.now();
    this.candidateSpeechStarted = false;
    // Held until the audio actually finishes. Gate rule 1 reads this to yield
    // the floor when the candidate talks over the interviewer, and a flag that
    // is never set makes that rule unreachable.
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

  /**
   * The interviewer's audio finished playing.
   *
   * M3-5 calls this from the realtime response lifecycle. Until voice exists
   * the caller invokes it immediately after taking the utterance — which is
   * honest, because with no audio there is no window to be barged into. What
   * matters is that the flag is driven by a signal rather than left permanently
   * false, so the barge-in rule is live the moment audio is.
   */
  markSpeechFinished(): void {
    this.interviewerCurrentlySpeaking = false;
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

      let snapshot: SemanticSnapshot | undefined;
      if (code.length > 0) {
        snapshot = await buildSnapshot(
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
          detectedSolutionFamilyId: this.candidateState.detectedSolutionFamilyId,
          implementationProgress: this.candidateState.implementationProgress,
          recentCodeActivity: this.candidateState.recentCodeActivity,
          stuckScore: this.candidateState.stuckScore,
          milestonesReached: this.candidateState.milestonesReached,
        },
        `observation:${pass}`,
      );
    }
  }

  private async append(
    type: SessionEvent["type"],
    actor: SessionEvent["actor"],
    payload: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<void> {
    await this.deps.events.append({
      sessionId: this.deps.sessionId,
      type,
      actor,
      scenarioVersionId: this.deps.scenarioVersionId,
      payload,
      traceId: this.deps.traceId,
      idempotencyKey,
    });
  }
}

function stringOf(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function numberOf(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
