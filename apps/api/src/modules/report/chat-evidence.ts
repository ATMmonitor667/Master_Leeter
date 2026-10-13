import type { SessionEvent } from "@master-leeter/contracts";

/**
 * Evaluation view of a text interview.
 *
 * A CHAT_TURN is one atomic event, but the evaluator's evidence extraction and
 * citation checks are written against the canonical evidence types. This pure
 * projection re-expresses each coding-phase turn as those types *for grading
 * input only*; the durable log is never rewritten. Every projected event keeps
 * the source event's seq and evidenceHash, so a citation still points at a
 * real, verifiable log entry.
 *
 * Excluded on purpose: resume-phase turns and resume context (no resume score
 * is produced), the professor review (post-session teaching is not evidence),
 * and redacted turns.
 */
const CANDIDATE_TEXT_KINDS = new Set(["MESSAGE", "THOUGHTS", "CODE"]);
const CHAT_ONLY = new Set(["CHAT_TURN", "CHAT_CONTEXT", "CHAT_REVIEW_TURN"]);

export function evaluationView(events: SessionEvent[]): SessionEvent[] {
  if (!events.some((e) => CHAT_ONLY.has(e.type))) return events;
  const view: SessionEvent[] = [];
  let previousReply = "";
  for (const event of events) {
    if (!CHAT_ONLY.has(event.type)) { view.push(event); continue; }
    if (event.type !== "CHAT_TURN" || event.payload["redacted"] === true) continue;
    const p = event.payload;
    const reply = typeof p["reply"] === "string" ? p["reply"] : "";
    if (p["phase"] === "CODING") {
      const derive = (type: SessionEvent["type"], payload: Record<string, unknown>, actor: SessionEvent["actor"]) =>
        view.push({ ...event, type, actor, payload });
      const text = typeof p["text"] === "string" ? p["text"] : "";
      if (CANDIDATE_TEXT_KINDS.has(String(p["kind"])) && text.trim()) {
        derive("SPEECH_FINAL", { transcript: text, source: "TEXT", submission: p["kind"], inResponseTo: previousReply }, "CANDIDATE");
      }
      if (typeof p["code"] === "string") derive("CODE_DELTA", { revision: p["turn"], text: p["code"], source: "TEXT" }, "CANDIDATE");
      if (typeof p["factKey"] === "string") derive("CLARIFICATION_ANSWERED", { factKey: p["factKey"] }, "INTERVIEWER");
      if (typeof p["hintLevel"] === "number") derive("HINT_GIVEN", { level: p["hintLevel"] }, "INTERVIEWER");
      if (typeof p["followUpId"] === "string") derive("FOLLOW_UP_PRESENTED", { followUpId: p["followUpId"] }, "INTERVIEWER");
    }
    previousReply = reply;
  }
  return view;
}
