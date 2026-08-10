import type { InterviewState, SessionEvent } from "@master-leeter/contracts";
import type { EventLog } from "./event-log.js";

/**
 * Session resume (M7-1).
 *
 * Reconstructs everything a refreshed browser needs from the append-only event
 * log. Not from a cache, not from localStorage — from the same evidence the
 * evaluator will read.
 *
 * That matters beyond convenience: if the log cannot rebuild the candidate's
 * screen, it cannot be trusted to justify their score either. Resume is a
 * standing test of whether the event log is actually complete.
 */

export interface ResumeState {
  sessionId: string;
  state: InterviewState;
  /** Latest code the server has seen, and which revision it is. */
  code: string;
  codeRevision: number;
  notes: string;
  /** Last server sequence, so the client knows where to continue from. */
  lastSeq: number;
  runsCompleted: number;
  /** Milestones already reached, so the UI does not re-announce them. */
  milestones: string[];
  /** True when the live phase is already over — send them to the report. */
  ended: boolean;
}

export async function reconstruct(
  eventLog: EventLog,
  sessionId: string,
  fallbackState: InterviewState,
): Promise<ResumeState | null> {
  const events = await eventLog.read(sessionId);
  if (events.length === 0) return null;

  const resume: ResumeState = {
    sessionId,
    state: fallbackState,
    code: "",
    codeRevision: 0,
    notes: "",
    lastSeq: events[events.length - 1]?.seq ?? -1,
    runsCompleted: 0,
    milestones: [],
    ended: false,
  };

  for (const event of events) {
    applyEvent(resume, event);
  }

  return resume;
}

function applyEvent(resume: ResumeState, event: SessionEvent): void {
  const payload = event.payload;

  switch (event.type) {
    case "CODE_DELTA": {
      const revision = numberOf(payload["revision"]);
      const text = stringOf(payload["text"]);

      // Guard against out-of-order replay. A late-arriving older delta must not
      // overwrite newer code — the candidate would watch their work vanish.
      if (revision !== null && text !== null && revision >= resume.codeRevision) {
        resume.code = text;
        resume.codeRevision = revision;
      }
      break;
    }

    case "NOTE_DELTA": {
      const text = stringOf(payload["text"]);
      if (text !== null) resume.notes = text;
      break;
    }

    case "STATE_TRANSITIONED": {
      const to = stringOf(payload["to"]);
      if (to) resume.state = to as InterviewState;
      break;
    }

    case "RUN_COMPLETED":
      resume.runsCompleted += 1;
      break;

    case "MILESTONE": {
      const kind = stringOf(payload["kind"]);
      if (kind && !resume.milestones.includes(kind)) resume.milestones.push(kind);
      break;
    }

    case "SESSION_ENDED":
      resume.ended = true;
      resume.state = "EVALUATION";
      break;

    default:
      break;
  }
}

function stringOf(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function numberOf(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
