import type { InterviewScenarioVersion, SessionEvent } from "@master-leeter/contracts";
import { selectProbeWording } from "../scenario/probes.js";

export interface ReviewEntry {
  seq: number;
  occurredAt: string;
  turnId: string;
  transcript: string;
  action: string;
  utterance: string;
  reason: string;
  classifierId: string;
  semanticEndProbability: number | null;
  textEndProbability: number | null;
  silenceMs: number | null;
  turnEndReason: string;
  groundedInRevision: number | null;
  codeRevisionLag: number | null;
  codeObservationAgeMs: number | null;
  judgment: "";
  notes: "";
}

/** Build the replayable, annotation-ready M4-5b review rows. */
export function buildSessionReview(
  events: readonly SessionEvent[],
  scenario: InterviewScenarioVersion,
): ReviewEntry[] {
  const transcripts = new Map<string, string>(
    events
      .filter((event) => event.type === "SPEECH_FINAL")
      .map((event) => [`turn-${event.seq}`, text(event.payload["transcript"]) ?? ""] as const),
  );
  const probeUses = new Map<string, number>();
  let briefCount = 0;

  return events
    .filter(
      (event) =>
        event.type === "ACTION_DECIDED" &&
        text(event.payload["action"]) !== "STAY_SILENT" &&
        text(event.payload["action"]) !== "TRANSITION_STAGE" &&
        event.payload["freshnessRejected"] !== true,
    )
    .map((event) => {
      const payload = event.payload;
      const action = text(payload["action"]) ?? "UNKNOWN";
      const turnId = text(payload["turnId"]) ?? (action === "DELIVER_BRIEF" ? "opening" : "");
      const utterance = resolveUtterance(action, payload, scenario, probeUses, briefCount);
      if (action === "DELIVER_BRIEF") briefCount++;

      return {
        seq: event.seq,
        occurredAt: event.occurredAt,
        turnId,
        transcript: transcripts.get(turnId) ?? "",
        action,
        utterance,
        reason: text(payload["reason"]) ?? "",
        classifierId: text(payload["classifierId"]) ?? "rule",
        semanticEndProbability: number(payload["semanticEndProbability"]),
        textEndProbability: number(payload["textEndProbability"]),
        silenceMs: number(payload["silenceMs"]),
        turnEndReason: text(payload["turnEndReason"]) ?? "",
        groundedInRevision: number(payload["groundedInRevision"]),
        codeRevisionLag: number(payload["codeRevisionLag"]),
        codeObservationAgeMs: number(payload["codeObservationAgeMs"]),
        judgment: "",
        notes: "",
      };
    });
}

function resolveUtterance(
  action: string,
  payload: Record<string, unknown>,
  scenario: InterviewScenarioVersion,
  probeUses: Map<string, number>,
  briefCount: number,
): string {
  switch (action) {
    case "DELIVER_BRIEF":
      return briefCount === 0
        ? scenario.oralBrief.openingScript
        : (scenario.oralBrief.repeatVariants[(briefCount - 1) % scenario.oralBrief.repeatVariants.length] ??
            scenario.oralBrief.openingScript);
    case "ANSWER_CLARIFICATION":
      return scenario.facts.find((fact) => fact.key === text(payload["factKey"]))?.value ?? "";
    case "ASK_PROBE": {
      const id = text(payload["probeId"]);
      const probe = scenario.probes.find((candidate) => candidate.id === id);
      if (!probe || !id) return "";
      const use = probeUses.get(id) ?? 0;
      probeUses.set(id, use + 1);
      return selectProbeWording(probe, use);
    }
    case "GIVE_HINT_L1":
    case "GIVE_HINT_L2":
      return scenario.hintLadder.find((hint) => hint.level === number(payload["hintLevel"]))?.text ?? "";
    case "PRESENT_FOLLOW_UP":
      return scenario.followUps.find((followUp) => followUp.id === text(payload["followUpId"]))?.oralDelta ?? "";
    case "ACKNOWLEDGE_BRIEFLY":
      return "[brief model acknowledgement — raw audio/text is not retained]";
    default:
      return `[${action}]`;
  }
}

export function reviewAsTsv(entries: readonly ReviewEntry[]): string {
  const columns: Array<keyof ReviewEntry> = [
    "seq",
    "occurredAt",
    "turnId",
    "transcript",
    "action",
    "utterance",
    "reason",
    "classifierId",
    "semanticEndProbability",
    "textEndProbability",
    "silenceMs",
    "turnEndReason",
    "groundedInRevision",
    "codeRevisionLag",
    "codeObservationAgeMs",
    "judgment",
    "notes",
  ];
  const row = (values: readonly unknown[]) => values.map(cell).join("\t");
  return `${row(columns)}\n${entries.map((entry) => row(columns.map((key) => entry[key]))).join("\n")}\n`;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\t/g, " ").replace(/\r?\n/g, " ");
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
