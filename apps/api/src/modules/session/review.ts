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
  classifierSource: string;
  prosodyProbability: number | null;
  prosodyConfidence: number | null;
  prosodyPull: number | null;
  semanticEndProbability: number | null;
  textEndProbability: number | null;
  silenceMs: number | null;
  turnEndReason: string;
  groundedInRevision: number | null;
  codeRevisionLag: number | null;
  codeObservationAgeMs: number | null;
  responseLatencyMs: number | null;
  speechSource: string;
  largestStage: string;
  judgment: "";
  notes: "";
}

interface LatencyHit {
  responseLatencyMs: number;
  source: string;
  largestStage: string;
}

const MARK_ORDER = [
  "quietOnsetMs",
  "vadEndDetectedMs",
  "activityEndSentMs",
  "firstInterimTranscriptMs",
  "transcriptFinalMs",
  "authorizationReceivedMs",
  "speechRequestedMs",
  "audioFetchStartedMs",
  "firstAudioByteMs",
  "firstSamplePlayedMs",
] as const;

function largestStageOf(payload: Record<string, unknown>): string {
  let best = "";
  let bestMs = -1;
  let prev: { mark: string; at: number } | null = null;
  for (const mark of MARK_ORDER) {
    const at = numOf(payload[mark]);
    if (at === null) { prev = null; continue; }
    if (prev !== null) {
      const ms = at - prev.at;
      if (ms > bestMs) { bestMs = ms; best = `${prev.mark} → ${mark}`; }
    }
    prev = { mark, at };
  }
  return best;
}

function numOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildLatencyMap(events: readonly SessionEvent[]): Map<string, LatencyHit> {
  const map = new Map<string, LatencyHit>();
  for (const event of events) {
    if (event.type !== "VOICE_LATENCY_MEASURED") continue;
    const p = event.payload as Record<string, unknown>;
    const utteranceId = typeof p["utteranceId"] === "string" ? p["utteranceId"] : null;
    if (!utteranceId) continue;
    const quietOnsetMs = numOf(p["quietOnsetMs"]);
    const firstSamplePlayedMs = numOf(p["firstSamplePlayedMs"]);
    if (quietOnsetMs === null || firstSamplePlayedMs === null) continue;
    const turnId = utteranceId.replace(/^utt-/, "");
    map.set(turnId, {
      responseLatencyMs: firstSamplePlayedMs - quietOnsetMs,
      source: typeof p["source"] === "string" ? p["source"] : "",
      largestStage: largestStageOf(p),
    });
  }
  return map;
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
  const latency = buildLatencyMap(events);
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
      const latencyHit = latency.get(turnId);

      return {
        seq: event.seq,
        occurredAt: event.occurredAt,
        turnId,
        transcript: transcripts.get(turnId) ?? "",
        action,
        utterance,
        reason: text(payload["reason"]) ?? "",
        classifierId: text(payload["classifierId"]) ?? "rule",
        classifierSource: text(payload["classifierSource"]) ?? "",
        prosodyProbability: number(payload["prosodyProbability"]),
        prosodyConfidence: number(payload["prosodyConfidence"]),
        prosodyPull: number(payload["prosodyPull"]),
        semanticEndProbability: number(payload["semanticEndProbability"]),
        textEndProbability: number(payload["textEndProbability"]),
        silenceMs: number(payload["silenceMs"]),
        turnEndReason: text(payload["turnEndReason"]) ?? "",
        groundedInRevision: number(payload["groundedInRevision"]),
        codeRevisionLag: number(payload["codeRevisionLag"]),
        codeObservationAgeMs: number(payload["codeObservationAgeMs"]),
        responseLatencyMs: latencyHit?.responseLatencyMs ?? null,
        speechSource: latencyHit?.source ?? "",
        largestStage: latencyHit?.largestStage ?? "",
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
    "classifierSource",
    "prosodyProbability",
    "prosodyConfidence",
    "prosodyPull",
    "semanticEndProbability",
    "textEndProbability",
    "silenceMs",
    "turnEndReason",
    "groundedInRevision",
    "codeRevisionLag",
    "codeObservationAgeMs",
    "responseLatencyMs",
    "speechSource",
    "largestStage",
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
