import type { SessionEvent } from "@master-leeter/contracts";

/**
 * Evaluation view of an interview.
 *
 * The live interview logs what was said as TRANSCRIPT_TURN events and what the
 * software cued as CUE events. The evaluator's evidence extraction and citation
 * checks are written against the canonical evidence types, so this pure
 * projection re-expresses them *for grading input only*; the durable log is
 * never rewritten. Every projected event keeps the source event's seq and
 * evidenceHash, so a citation still points at a real log entry.
 *
 * The interviewer's own words are not graded. They are carried on the
 * candidate's next turn as `inResponseTo`, so an answer can be read in context.
 */
export function evaluationView(events: SessionEvent[]): SessionEvent[] {
  const view: SessionEvent[] = [];
  let lastInterviewerLine = "";
  for (const event of events) {
    if (event.payload["redacted"] === true) { view.push(event); continue; }
    if (event.type === "TRANSCRIPT_TURN") {
      const text = typeof event.payload["text"] === "string" ? event.payload["text"] : "";
      if (event.payload["speaker"] === "INTERVIEWER") { lastInterviewerLine = text; continue; }
      if (text.trim()) {
        view.push({ ...event, type: "SPEECH_FINAL", actor: "CANDIDATE",
          payload: { transcript: text, source: event.payload["medium"] === "CHAT" ? "TEXT" : "VOICE", inResponseTo: lastInterviewerLine } });
      }
      continue;
    }
    if (event.type === "CUE") {
      if (event.payload["kind"] === "HINT") {
        view.push({ ...event, type: "HINT_GIVEN", actor: "INTERVIEWER",
          payload: { level: typeof event.payload["n"] === "number" ? event.payload["n"] : 1 } });
      }
      continue;
    }
    view.push(event);
  }
  return view;
}
