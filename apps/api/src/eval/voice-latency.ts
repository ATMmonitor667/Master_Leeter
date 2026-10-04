import type { SessionEvent } from "@master-leeter/contracts";

/**
 * Response latency, read back off a session's event log (V0).
 *
 * ── Why latency is reported here and not next to the sim metrics ───────────
 *
 * `metrics.ts` scores bot trajectories: did the interviewer speak when it
 * should have, stay silent when it should have. Those are decisions. This is
 * execution — how long it took to carry out a decision that had already been
 * made — and the latency study is emphatic that conflating the two is the
 * original sin behind the reported symptom. A gate that correctly decides to
 * probe and then takes four seconds to say it scores perfectly on one and
 * terribly on the other.
 *
 * ── Read both numbers or neither ───────────────────────────────────────────
 *
 * §8: latency and interruption quality trade off directly. A system reaches
 * 100 ms by interrupting constantly and 0% false cutoffs by never speaking, so
 * a latency figure quoted on its own is not evidence of anything. This module
 * reports latency; the false-cutoff rate comes from human review of recorded
 * sessions and there is no substitute for it. The report should carry both.
 */

export interface VoiceLatencySample {
  utteranceId: string;
  action: string;
  source: "CACHED_AUDIO" | "REALTIME_MODEL";
  /** `firstSamplePlayedMs − quietOnsetMs`: the number the candidate experiences. */
  responseLatencyMs: number;
  /** Named stage gaps, largest first. Empty when only the endpoints were marked. */
  stages: Array<{ stage: string; ms: number }>;
}

export interface LatencySummary {
  count: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

export interface VoiceLatencyReport {
  samples: readonly VoiceLatencySample[];
  overall: LatencySummary | null;
  byAction: Record<string, LatencySummary>;
  bySource: Record<string, LatencySummary>;
  /**
   * Mean duration of each stage, largest first.
   *
   * The output §6.1 asks for in as many words: "the three largest terms are
   * named". Take the top three of this.
   */
  stageMeansMs: Array<{ stage: string; meanMs: number; n: number }>;
  /**
   * Utterances that were authorized but produced no measurement.
   *
   * Not a rounding error and not safe to ignore. A barge-in is a legitimate
   * reason; a systematically dropped one is a hole in the evidence, and this
   * count is what tells the two apart.
   */
  unmeasured: number;
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

/**
 * Build the report from an event log.
 *
 * Pure, and reads only `VOICE_LATENCY_MEASURED`. Nothing here can influence an
 * interview, which is the point — a measurement that fed back into a decision
 * would make the session a function of how fast the machine ran and replay
 * would stop being exact.
 */
export function voiceLatencyReport(events: readonly SessionEvent[]): VoiceLatencyReport {
  const samples: VoiceLatencySample[] = [];
  let unmeasured = 0;

  for (const event of events) {
    if (event.type !== "VOICE_LATENCY_MEASURED") continue;

    const payload = event.payload as Record<string, unknown>;
    const quietOnsetMs = num(payload["quietOnsetMs"]);
    const firstSamplePlayedMs = num(payload["firstSamplePlayedMs"]);

    if (quietOnsetMs === null || firstSamplePlayedMs === null) {
      unmeasured += 1;
      continue;
    }

    samples.push({
      utteranceId: String(payload["utteranceId"] ?? ""),
      action: String(payload["action"] ?? "UNKNOWN"),
      source: payload["source"] === "CACHED_AUDIO" ? "CACHED_AUDIO" : "REALTIME_MODEL",
      responseLatencyMs: firstSamplePlayedMs - quietOnsetMs,
      stages: stagesOf(payload),
    });
  }

  const byAction: Record<string, LatencySummary> = {};
  for (const [action, group] of groupBy(samples, (s) => s.action)) {
    const summary = summarize(group.map((s) => s.responseLatencyMs));
    if (summary) byAction[action] = summary;
  }

  const bySource: Record<string, LatencySummary> = {};
  for (const [source, group] of groupBy(samples, (s) => s.source)) {
    const summary = summarize(group.map((s) => s.responseLatencyMs));
    if (summary) bySource[source] = summary;
  }

  return {
    samples,
    overall: summarize(samples.map((s) => s.responseLatencyMs)),
    byAction,
    bySource,
    stageMeansMs: stageMeans(samples),
    unmeasured,
  };
}

/**
 * p50 and p95 by nearest-rank, not by interpolation.
 *
 * A real session produces eight to fifteen interviewer utterances. At that n an
 * interpolated p95 is a number between two observations that reads as more
 * precise than the sample supports — and this figure exists to be compared
 * against a 200 ms human baseline, where false precision is worse than none.
 */
export function summarize(values: readonly number[]): LatencySummary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);

  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? 0;
}

function stagesOf(payload: Record<string, unknown>): Array<{ stage: string; ms: number }> {
  const present: Array<{ mark: string; at: number }> = [];
  for (const mark of MARK_ORDER) {
    const at = num(payload[mark]);
    if (at !== null) present.push({ mark, at });
  }

  const stages: Array<{ stage: string; ms: number }> = [];
  for (let i = 1; i < present.length; i += 1) {
    const from = present[i - 1];
    const to = present[i];
    if (!from || !to) continue;
    stages.push({ stage: `${from.mark} → ${to.mark}`, ms: to.at - from.at });
  }

  return stages.sort((a, b) => b.ms - a.ms);
}

function stageMeans(samples: readonly VoiceLatencySample[]): Array<{ stage: string; meanMs: number; n: number }> {
  const totals = new Map<string, { sum: number; n: number }>();

  for (const sample of samples) {
    for (const stage of sample.stages) {
      const entry = totals.get(stage.stage) ?? { sum: 0, n: 0 };
      entry.sum += stage.ms;
      entry.n += 1;
      totals.set(stage.stage, entry);
    }
  }

  return [...totals.entries()]
    .map(([stage, { sum, n }]) => ({ stage, meanMs: sum / n, n }))
    .sort((a, b) => b.meanMs - a.meanMs);
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = out.get(k) ?? [];
    group.push(item);
    out.set(k, group);
  }
  return out;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
