import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@master-leeter/contracts";
import { summarize, voiceLatencyReport } from "./voice-latency.js";

function latencyEvent(overrides: Record<string, unknown> = {}): SessionEvent {
  return {
    id: "evt-1",
    sessionId: "s1",
    seq: 1,
    occurredAt: new Date().toISOString(),
    type: "VOICE_LATENCY_MEASURED",
    actor: "SYSTEM",
    scenarioVersionId: "v1",
    payload: {
      utteranceId: "utt-turn-1",
      action: "ASK_PROBE",
      source: "REALTIME_MODEL",
      quietOnsetMs: 0,
      vadEndDetectedMs: 150,
      transcriptFinalMs: 300,
      authorizationReceivedMs: 350,
      speechRequestedMs: 400,
      firstAudioByteMs: 550,
      firstSamplePlayedMs: 600,
      ...overrides,
    },
    traceId: "trace-1",
    evidenceHash: "h1",
  } as unknown as SessionEvent;
}

describe("voiceLatencyReport", () => {
  it("returns empty report when no latency events exist", () => {
    const report = voiceLatencyReport([]);
    expect(report.samples).toHaveLength(0);
    expect(report.overall).toBeNull();
    expect(report.unmeasured).toBe(0);
  });

  it("computes responseLatencyMs as firstSamplePlayedMs − quietOnsetMs", () => {
    const event = latencyEvent({ quietOnsetMs: 100, firstSamplePlayedMs: 700 });
    const report = voiceLatencyReport([event]);
    expect(report.samples[0]?.responseLatencyMs).toBe(600);
  });

  it("increments unmeasured when quietOnsetMs is missing", () => {
    const event = latencyEvent();
    (event.payload as Record<string, unknown>)["quietOnsetMs"] = undefined;
    const report = voiceLatencyReport([event]);
    expect(report.samples).toHaveLength(0);
    expect(report.unmeasured).toBe(1);
  });

  it("increments unmeasured when firstSamplePlayedMs is missing", () => {
    const event = latencyEvent();
    (event.payload as Record<string, unknown>)["firstSamplePlayedMs"] = undefined;
    const report = voiceLatencyReport([event]);
    expect(report.samples).toHaveLength(0);
    expect(report.unmeasured).toBe(1);
  });

  it("groups samples by action", () => {
    const events = [
      latencyEvent({ action: "ASK_PROBE", quietOnsetMs: 0, firstSamplePlayedMs: 400 }),
      latencyEvent({ action: "ASK_PROBE", quietOnsetMs: 0, firstSamplePlayedMs: 600 }),
      latencyEvent({ action: "GIVE_HINT_L1", quietOnsetMs: 0, firstSamplePlayedMs: 800 }),
    ];
    const report = voiceLatencyReport(events);
    expect(report.byAction["ASK_PROBE"]?.count).toBe(2);
    expect(report.byAction["GIVE_HINT_L1"]?.count).toBe(1);
  });

  it("groups samples by source", () => {
    const events = [
      latencyEvent({ source: "CACHED_AUDIO", quietOnsetMs: 0, firstSamplePlayedMs: 200 }),
      latencyEvent({ source: "CACHED_AUDIO", quietOnsetMs: 0, firstSamplePlayedMs: 250 }),
      latencyEvent({ source: "REALTIME_MODEL", quietOnsetMs: 0, firstSamplePlayedMs: 700 }),
    ];
    const report = voiceLatencyReport(events);
    expect(report.bySource["CACHED_AUDIO"]?.count).toBe(2);
    expect(report.bySource["REALTIME_MODEL"]?.count).toBe(1);
  });

  it("populates stages sorted by duration descending", () => {
    const event = latencyEvent({
      quietOnsetMs: 0,
      vadEndDetectedMs: 50,
      transcriptFinalMs: 300,
      firstSamplePlayedMs: 500,
    });
    const report = voiceLatencyReport([event]);
    const stages = report.samples[0]?.stages ?? [];
    expect(stages.length).toBeGreaterThan(0);
    for (let i = 1; i < stages.length; i++) {
      expect(stages[i - 1]!.ms).toBeGreaterThanOrEqual(stages[i]!.ms);
    }
  });

  it("computes overall summary across all samples", () => {
    const events = [100, 200, 300, 400, 500].map((ms) =>
      latencyEvent({ quietOnsetMs: 0, firstSamplePlayedMs: ms }),
    );
    const report = voiceLatencyReport(events);
    expect(report.overall?.count).toBe(5);
    expect(report.overall?.minMs).toBe(100);
    expect(report.overall?.maxMs).toBe(500);
  });

  it("includes firstInterimTranscriptMs as a mark between activityEndSentMs and transcriptFinalMs", () => {
    const event = latencyEvent({
      quietOnsetMs: 0,
      vadEndDetectedMs: 100,
      activityEndSentMs: 120,
      firstInterimTranscriptMs: 200,
      transcriptFinalMs: 350,
      firstSamplePlayedMs: 600,
    });
    const report = voiceLatencyReport([event]);
    const stageNames = report.samples[0]?.stages.map((s) => s.stage) ?? [];

    const activityToInterim = stageNames.find(
      (s) => s.includes("activityEndSentMs") && s.includes("firstInterimTranscriptMs"),
    );
    const interimToFinal = stageNames.find(
      (s) => s.includes("firstInterimTranscriptMs") && s.includes("transcriptFinalMs"),
    );

    expect(activityToInterim).toBeDefined();
    expect(interimToFinal).toBeDefined();
  });

  it("computes stageMeansMs across all samples", () => {
    const events = [
      latencyEvent({ quietOnsetMs: 0, vadEndDetectedMs: 100, firstSamplePlayedMs: 500 }),
      latencyEvent({ quietOnsetMs: 0, vadEndDetectedMs: 200, firstSamplePlayedMs: 700 }),
    ];
    const report = voiceLatencyReport(events);
    expect(report.stageMeansMs.length).toBeGreaterThan(0);
    for (let i = 1; i < report.stageMeansMs.length; i++) {
      expect(report.stageMeansMs[i - 1]!.meanMs).toBeGreaterThanOrEqual(
        report.stageMeansMs[i]!.meanMs,
      );
    }
  });

  it("ignores non-latency events in the log", () => {
    const other: SessionEvent = {
      id: "evt-other",
      sessionId: "s1",
      seq: 0,
      occurredAt: new Date().toISOString(),
      type: "SPEECH_FINAL",
      actor: "CANDIDATE",
      scenarioVersionId: "v1",
      payload: { transcript: "hello" },
      traceId: "trace-1",
      evidenceHash: "h0",
    } as unknown as SessionEvent;

    const report = voiceLatencyReport([other, latencyEvent()]);
    expect(report.samples).toHaveLength(1);
  });
});

describe("summarize", () => {
  it("returns null for empty input", () => {
    expect(summarize([])).toBeNull();
  });

  it("computes correct p50 and p95 for small n (nearest-rank)", () => {
    // 10 values: nearest-rank p50 = ceil(0.5*10)=5 → sorted[4]=500
    // nearest-rank p95 = ceil(0.95*10)=10 → sorted[9]=1000
    const result = summarize([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
    expect(result?.p50Ms).toBe(500);
    expect(result?.p95Ms).toBe(1000);
  });

  it("handles single-element arrays", () => {
    const result = summarize([42]);
    expect(result?.p50Ms).toBe(42);
    expect(result?.p95Ms).toBe(42);
    expect(result?.minMs).toBe(42);
    expect(result?.maxMs).toBe(42);
  });
});
