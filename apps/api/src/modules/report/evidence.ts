import type { RunResult, SessionEvent } from "@master-leeter/contracts";
import type { RubricDimension } from "./rubric.js";

/**
 * Evidence extraction (M6-2, first half).
 *
 * Deterministic. Reads the immutable event log and produces the facts a score
 * can be justified by — nothing here interprets, judges, or scores.
 *
 * Keeping extraction separate from scoring is what makes reports auditable: two
 * reviewers can disagree about a score while agreeing completely about what
 * happened, and a rubric change re-scores the same evidence rather than
 * re-deriving it.
 */

export interface EvidenceMoment {
  seq: number;
  occurredAt: string;
  kind: string;
  summary: string;
  /** Hash of the source event, so a citation is verifiable against the log. */
  evidenceHash: string;
  /** Code revision this moment refers to, when it refers to code at all. */
  codeRevision?: number;
}

export interface SessionFacts {
  sessionId: string;
  scenarioVersionId: string;

  clarificationsAsked: number;
  clarificationFactKeys: string[];

  probesAsked: string[];
  hintsGiven: number[];
  followUpsPresented: string[];

  runs: RunResult[];
  firstPassSeq: number | null;
  milestonesReached: string[];

  /** Wall-clock seconds from first to last event. */
  durationSeconds: number;
  finalCodeRevision: number;

  moments: EvidenceMoment[];
}

export function extractFacts(events: SessionEvent[]): SessionFacts {
  const first = events[0];
  const last = events[events.length - 1];

  const facts: SessionFacts = {
    sessionId: first?.sessionId ?? "",
    scenarioVersionId: first?.scenarioVersionId ?? "",
    clarificationsAsked: 0,
    clarificationFactKeys: [],
    probesAsked: [],
    hintsGiven: [],
    followUpsPresented: [],
    runs: [],
    firstPassSeq: null,
    milestonesReached: [],
    durationSeconds:
      first && last ? Math.max(0, (Date.parse(last.occurredAt) - Date.parse(first.occurredAt)) / 1000) : 0,
    finalCodeRevision: 0,
    moments: [],
  };

  for (const event of events) {
    const p = event.payload;

    switch (event.type) {
      case "CLARIFICATION_ANSWERED": {
        facts.clarificationsAsked++;
        const key = str(p["factKey"]);
        if (key) facts.clarificationFactKeys.push(key);
        facts.moments.push(moment(event, "clarification", `Asked about ${key ?? "an unlisted detail"}`));
        break;
      }

      case "PROBE_ASKED": {
        const id = str(p["probeId"]);
        if (id) facts.probesAsked.push(id);
        facts.moments.push(
          moment(event, "probe", `Interviewer probed: ${str(p["intent"]) ?? id ?? "unknown"}`),
        );
        break;
      }

      case "HINT_GIVEN": {
        const level = num(p["level"]);
        if (level !== null) facts.hintsGiven.push(level);
        facts.moments.push(moment(event, "hint", `Hint L${level ?? "?"} given`));
        break;
      }

      case "FOLLOW_UP_PRESENTED": {
        const id = str(p["followUpId"]);
        if (id) facts.followUpsPresented.push(id);
        facts.moments.push(moment(event, "follow-up", `Follow-up presented: ${id ?? "unknown"}`));
        break;
      }

      case "RUN_COMPLETED": {
        const result = p as unknown as RunResult;
        facts.runs.push(result);
        if (result.status === "PASSED" && facts.firstPassSeq === null) {
          facts.firstPassSeq = event.seq;
        }
        facts.moments.push(
          moment(event, "run", `Run ${result.status.toLowerCase()} (rev ${result.codeRevision})`, result.codeRevision),
        );
        break;
      }

      case "MILESTONE": {
        const kind = str(p["kind"]);
        if (kind && !facts.milestonesReached.includes(kind)) facts.milestonesReached.push(kind);
        if (kind) facts.moments.push(moment(event, "milestone", kind));
        break;
      }

      case "CODE_DELTA": {
        const revision = num(p["revision"]);
        if (revision !== null) facts.finalCodeRevision = Math.max(facts.finalCodeRevision, revision);
        break;
      }

      case "SPEECH_FINAL": {
        const transcript = str(p["transcript"]);
        // Quoted verbatim. The evaluator cites what the candidate said, never a
        // paraphrase — a paraphrased quote is an unfalsifiable citation.
        if (transcript && transcript.length > 12) {
          facts.moments.push(moment(event, "said", transcript));
        }
        break;
      }

      default:
        break;
    }
  }

  return facts;
}

function moment(
  event: SessionEvent,
  kind: string,
  summary: string,
  codeRevision?: number,
): EvidenceMoment {
  return {
    seq: event.seq,
    occurredAt: event.occurredAt,
    kind,
    summary,
    evidenceHash: event.evidenceHash,
    ...(codeRevision !== undefined ? { codeRevision } : {}),
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/** Moments relevant to a dimension, most recent first, capped for the report. */
export function momentsFor(
  facts: SessionFacts,
  dimension: RubricDimension,
  limit = 4,
): EvidenceMoment[] {
  const kindsByDimension: Record<RubricDimension, string[]> = {
    problemUnderstanding: ["clarification", "said"],
    approach: ["said", "probe"],
    correctness: ["run", "milestone"],
    complexityReasoning: ["said", "probe"],
    testing: ["run"],
    communication: ["said"],
    adaptability: ["follow-up", "probe", "run"],
  };

  const kinds = kindsByDimension[dimension];
  return facts.moments
    .filter((m) => kinds.includes(m.kind))
    .slice(-limit)
    .reverse();
}
