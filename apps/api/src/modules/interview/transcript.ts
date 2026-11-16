import {
  codeContext, cueText, type RunReport, type SessionEvent, type TranscriptEntry,
} from "@master-leeter/contracts";

/**
 * Read models over the append-only event log.
 *
 * Voice and chat write the same events (TRANSCRIPT_TURN, CUE, CODE_DELTA,
 * RUN_COMPLETED), so restoring a room, building chat history and grading all
 * read one shape.
 */

const text = (value: unknown) => (typeof value === "string" ? value : "");

export function transcriptOf(events: SessionEvent[]): TranscriptEntry[] {
  return events.flatMap((event) => {
    if (event.type !== "TRANSCRIPT_TURN" || event.payload["redacted"] === true) return [];
    const said = text(event.payload["text"]);
    if (!said) return [];
    return [{ seq: event.seq, speaker: event.payload["speaker"] === "INTERVIEWER" ? "INTERVIEWER" as const : "CANDIDATE" as const, text: said, at: event.occurredAt }];
  });
}

export function latestCode(events: SessionEvent[]): { revision: number; text: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "CODE_DELTA" && typeof event.payload["text"] === "string" && typeof event.payload["revision"] === "number") {
      return { revision: event.payload["revision"], text: event.payload["text"] };
    }
  }
  return null;
}

export function latestNotes(events: SessionEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "NOTE_DELTA" && typeof event.payload["text"] === "string") return event.payload["text"];
  }
  return "";
}

export function latestRun(events: SessionEvent[]): RunReport | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const report = events[i]!.payload["report"];
    if (events[i]!.type === "RUN_COMPLETED" && report && typeof report === "object") return report as RunReport;
  }
  return null;
}

export function hintsUsed(events: SessionEvent[]): number {
  return events.filter((e) => e.type === "CUE" && e.payload["kind"] === "HINT").length;
}

export function hasStarted(events: SessionEvent[]): boolean {
  return events.some((e) => e.type === "CUE" && e.payload["kind"] === "START");
}

export interface ModelTurn { role: "user" | "model"; text: string }

/**
 * The conversation as the chat model sees it.
 *
 * Candidate words and software cues are "user"; the interviewer is "model".
 * Only the latest code revision is included, placed just before the final user
 * turn, so the prompt stays small however long the interview runs.
 */
export function conversationOf(events: SessionEvent[]): ModelTurn[] {
  const turns: ModelTurn[] = [];
  const push = (role: ModelTurn["role"], value: string) => {
    if (!value.trim()) return;
    const last = turns.at(-1);
    if (last && last.role === role) last.text += `\n${value}`;
    else turns.push({ role, text: value });
  };
  for (const event of events) {
    if (event.payload["redacted"] === true) continue;
    if (event.type === "TRANSCRIPT_TURN") {
      push(event.payload["speaker"] === "INTERVIEWER" ? "model" : "user", text(event.payload["text"]));
    } else if (event.type === "CUE") {
      const kind = text(event.payload["kind"]);
      if (kind !== "RUN") push("user", cueText(kind, typeof event.payload["n"] === "number" ? event.payload["n"] : undefined));
    } else if (event.type === "RUN_COMPLETED") {
      const report = event.payload["report"] as RunReport | undefined;
      if (report?.summary) push("user", report.summary);
    }
  }
  const code = latestCode(events);
  if (code && code.text.trim()) {
    const context = codeContext(code.revision, code.text);
    const last = turns.at(-1);
    if (last?.role === "user") last.text = `${context}\n\n${last.text}`;
    else push("user", context);
  }
  // The API requires the first turn to be the user's.
  if (turns[0]?.role === "model") turns.unshift({ role: "user", text: cueText("START") });
  return turns;
}
