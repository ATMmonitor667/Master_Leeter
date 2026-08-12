import {
  type CandidateState,
  type GateDecision,
  type InterviewContext,
  type InterviewMode,
  type InterviewScenarioVersion,
  type InterviewState,
  type Turn,
  type TurnIntent,
  emptyCandidateState,
} from "@master-leeter/contracts";
import { decideAction } from "../modules/orchestrator/gate.js";
import { policyFor } from "../modules/orchestrator/policy.js";
import { estimateTurnCompletion } from "../modules/orchestrator/turn-completion.js";

/**
 * Candidate-bot simulation harness (M1-6).
 *
 * A candidate bot is a TEST FIXTURE, never production code. It emits a scripted
 * stream of turns, code activity, and observer updates so a difficult
 * conversational path can be replayed thousands of times in milliseconds.
 *
 * This exists because the alternative — evaluating silence quality by talking to
 * the thing — is slow, expensive, and unrepeatable. Every trajectory here
 * encodes a moment where a plausible implementation would say something and a
 * good interviewer would not.
 */

export interface ScriptedStep {
  /** Seconds since session start. Must be non-decreasing across a script. */
  at: number;
  label: string;
  state?: InterviewState;
  /**
   * Null means no finalized turn at this moment (e.g. pure code activity).
   *
   * `semanticEndProbability` is the TEXT probability — what a classifier made of
   * the words. The harness runs it through the same M4-2 estimator production
   * uses, so a scripted value is an input to the decision, not the decision.
   */
  turn?: {
    transcript: string;
    intent: TurnIntent;
    semanticEndProbability: number;
    finalized?: boolean;
  } | null;
  /**
   * Quiet time before this turn's transcript was finalized.
   *
   * Optional because most trajectories predate M4-2 and are fixtures for the
   * gate rather than for the estimator; omitting it reproduces the pre-M4-2
   * text-only path exactly. Supplying it is what makes a trajectory a test of
   * turn completion — see `longThinker`, where the pauses are the point.
   */
  silenceMs?: number;
  candidateState?: Partial<CandidateState>;
  codeRevision?: number;
  secondsSinceCodeActivity?: number;
  interviewerCurrentlySpeaking?: boolean;
  candidateSpeechStarted?: boolean;
  /** Marks the moment the observer catches up to the latest revision. */
  observerRevision?: number;
}

export interface CandidateBot {
  name: string;
  mode: InterviewMode;
  /** What this trajectory is testing. Shows up in failure output. */
  tests: string;
  steps: ScriptedStep[];
}

export interface SimStepResult {
  step: ScriptedStep;
  decision: GateDecision;
}

export interface SimResult {
  bot: CandidateBot;
  results: SimStepResult[];
  /** Decisions that produced speech, in order. */
  utterances: SimStepResult[];
  silenceCount: number;
}

const SESSION_ID = "00000000-0000-4000-8000-000000000000";

export function runBot(bot: CandidateBot, scenario: InterviewScenarioVersion): SimResult {
  const policy = policyFor(bot.mode);
  const results: SimStepResult[] = [];

  let state: InterviewState = "ORAL_PROBLEM_DELIVERY";
  let candidateState: CandidateState = emptyCandidateState("2026-08-09T00:00:00.000Z");
  let latestCodeRevision = 0;
  let secondsSinceCodeActivity = 999;
  let lastSpokeAt = 0;
  const probeUseCounts: Record<string, number> = {};
  const followUpsUsed: string[] = [];

  for (const step of bot.steps) {
    if (step.state) state = step.state;
    if (step.codeRevision !== undefined) latestCodeRevision = step.codeRevision;
    if (step.secondsSinceCodeActivity !== undefined) {
      secondsSinceCodeActivity = step.secondsSinceCodeActivity;
    }
    if (step.candidateState) {
      candidateState = { ...candidateState, ...step.candidateState };
    }
    if (step.observerRevision !== undefined) {
      candidateState = { ...candidateState, derivedFromRevision: step.observerRevision };
    }

    // Fused exactly as the runtime fuses it, so the simulator cannot drift into
    // measuring a gate that production does not run.
    const completion = step.turn
      ? estimateTurnCompletion({
          transcript: step.turn.transcript,
          intent: step.turn.intent,
          textEndProbability: step.turn.semanticEndProbability,
          ...(step.silenceMs !== undefined ? { silenceMs: step.silenceMs } : {}),
          policy,
        })
      : null;

    const turn: Turn | null =
      step.turn && completion
        ? {
            turnId: `${bot.name}-${step.at}`,
            finalized: step.turn.finalized ?? true,
            transcript: step.turn.transcript,
            semanticEndProbability: completion.endProbability,
            textEndProbability: completion.textEndProbability,
            ...(completion.silenceMs !== undefined
              ? { silenceMsBeforeEnd: completion.silenceMs }
              : {}),
            intent: step.turn.intent,
            intentProbabilities: { [step.turn.intent]: 0.9 },
            endedAt: new Date(step.at * 1000).toISOString(),
          }
        : null;

    const ctx: InterviewContext = {
      sessionId: SESSION_ID,
      state,
      policy,
      candidateState,
      turn,
      interviewerCurrentlySpeaking: step.interviewerCurrentlySpeaking ?? false,
      candidateSpeechStarted: step.candidateSpeechStarted ?? false,
      secondsSinceInterviewerLastSpoke: step.at - lastSpokeAt,
      secondsSinceCodeActivity,
      remainingSeconds: Math.max(0, policy.expectedMinutes * 60 - step.at),
      hintsUsedCount: candidateState.hintsUsed.length,
      latestCodeRevision,
      scenarioVersionId: scenario.id,
      traceId: `sim-${bot.name}`,
    };

    const decision = decideAction(ctx, {
      scenario,
      probeUseCounts,
      followUpsUsed,
      solvedOptimally: (candidateState.milestonesReached as readonly string[]).includes(
        "BASE_TESTS_PASS",
      ),
      // Every trajectory starts after the problem has been delivered — none of
      // them is a test of the opening, and a bot that re-heard the brief on
      // step one would be measuring something else entirely.
      briefDeliveryCount: 1,
    });

    // Apply the consequences so later steps see a session that actually
    // progressed — budgets spent, probes used, pacing clock reset.
    if (decision.action !== "STAY_SILENT") {
      lastSpokeAt = step.at;
    }
    if (decision.probeId) {
      probeUseCounts[decision.probeId] = (probeUseCounts[decision.probeId] ?? 0) + 1;
      candidateState = {
        ...candidateState,
        probeHistory: [...candidateState.probeHistory, decision.probeId],
      };
    }
    if (decision.hintLevel) {
      candidateState = {
        ...candidateState,
        hintsUsed: [...candidateState.hintsUsed, decision.hintLevel as 1 | 2 | 3 | 4],
      };
    }
    if (decision.followUpId) followUpsUsed.push(decision.followUpId);

    results.push({ step, decision });
  }

  const utterances = results.filter((r) => r.decision.action !== "STAY_SILENT");

  return {
    bot,
    results,
    utterances,
    silenceCount: results.length - utterances.length,
  };
}

/** Formats a run for failure output. A bare boolean assertion is useless here. */
export function describeRun(result: SimResult): string {
  const lines = result.results.map(
    (r) => `  ${String(r.step.at).padStart(4)}s  ${r.decision.action.padEnd(22)} ${r.step.label}\n         ↳ ${r.decision.reason}`,
  );
  return `\n${result.bot.name} (${result.bot.mode})\n${lines.join("\n")}\n`;
}
