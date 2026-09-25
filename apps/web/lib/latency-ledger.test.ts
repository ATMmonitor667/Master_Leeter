import { describe, expect, it } from "vitest";
import {
  VoiceLatencyLedger,
  largestStages,
  responseLatencyMs,
  type LatencyLedger,
} from "./latency-ledger";

function ledgerWithSink() {
  const completed: LatencyLedger[] = [];
  const ledger = new VoiceLatencyLedger({ onComplete: (l) => completed.push(l) });
  return { ledger, completed };
}

describe("the metric is measured from the quiet onset, not from the decision", () => {
  it("reports last candidate sample to first audible sample", () => {
    const { ledger, completed } = ledgerWithSink();

    // 1000 is the BACKDATED onset; the VAD only declared it at 1350.
    ledger.mark("quietOnsetMs", 1_000);
    ledger.mark("vadEndDetectedMs", 1_350);
    ledger.authorized("utt-1", "ASK_PROBE", "CACHED_AUDIO", 1_500);
    ledger.firstSamplePlayed(1_620);

    expect(completed).toHaveLength(1);
    // 620ms, which includes the hangover. Hiding the 350 inside the detector
    // would measure the system's patience rather than the candidate's wait.
    expect(responseLatencyMs(completed[0]!)).toBe(620);
  });
});

describe("what it refuses to measure", () => {
  it("does not open a ledger for an utterance with no candidate turn in front of it", () => {
    // DELIVER_BRIEF opens the interview. There is no quiet onset behind it, and
    // timing it would put a multi-minute "latency" in the distribution.
    const { ledger, completed } = ledgerWithSink();

    expect(ledger.authorized("utt-brief", "DELIVER_BRIEF", "CACHED_AUDIO", 5_000)).toBe(false);
    ledger.firstSamplePlayed(5_100);

    expect(completed).toHaveLength(0);
  });

  it("drops an utterance the candidate talked over", () => {
    const { ledger, completed } = ledgerWithSink();

    ledger.mark("quietOnsetMs", 1_000);
    ledger.authorized("utt-1", "ASK_PROBE", "CACHED_AUDIO", 1_400);
    ledger.abandon();
    ledger.firstSamplePlayed(1_500);

    expect(completed).toHaveLength(0);
  });

  it("expires a ledger nobody closed rather than reporting it as very slow", () => {
    const { ledger, completed } = ledgerWithSink();

    ledger.mark("quietOnsetMs", 0);
    ledger.authorized("utt-1", "ASK_PROBE", "CACHED_AUDIO", 100);

    ledger.mark("quietOnsetMs", 200_000);
    ledger.authorized("utt-2", "ASK_PROBE", "CACHED_AUDIO", 200_400);
    ledger.firstSamplePlayed(200_500);

    expect(completed).toHaveLength(1);
    expect(completed[0]?.utteranceId).toBe("utt-2");
  });
});

describe("marks", () => {
  it("takes the most recent quiet onset, because the earlier one is answered by nothing", () => {
    const { ledger, completed } = ledgerWithSink();

    ledger.mark("quietOnsetMs", 1_000);
    ledger.mark("quietOnsetMs", 4_000); // the candidate spoke again
    ledger.authorized("utt-1", "ASK_PROBE", "REALTIME_MODEL", 4_500);
    ledger.firstSamplePlayed(4_900);

    expect(responseLatencyMs(completed[0]!)).toBe(900);
  });

  it("keeps the first write of non-transcript marks, so a retry does not restart the clock", () => {
    const { ledger, completed } = ledgerWithSink();

    ledger.mark("quietOnsetMs", 0);
    ledger.mark("vadEndDetectedMs", 400);
    ledger.mark("vadEndDetectedMs", 900); // second report of the same stage
    ledger.authorized("utt-1", "ASK_PROBE", "CACHED_AUDIO", 1_000);
    ledger.firstSamplePlayed(1_100);

    expect(completed[0]?.vadEndDetectedMs).toBe(400);
  });

  it("overwrites transcriptFinalMs on each final chunk, keeping the last one", () => {
    const { ledger, completed } = ledgerWithSink();

    ledger.mark("quietOnsetMs", 0);
    ledger.mark("transcriptFinalMs", 400);
    ledger.mark("transcriptFinalMs", 900); // later final chunk — this is the one that matters
    ledger.authorized("utt-1", "ASK_PROBE", "CACHED_AUDIO", 1_000);
    ledger.firstSamplePlayed(1_100);

    expect(completed[0]?.transcriptFinalMs).toBe(900);
  });

  it("counts how many final transcript chunks arrived in the turn", () => {
    const { ledger, completed } = ledgerWithSink();

    ledger.mark("quietOnsetMs", 0);
    ledger.mark("transcriptFinalMs", 300);
    ledger.mark("transcriptFinalMs", 600);
    ledger.mark("transcriptFinalMs", 900);
    ledger.authorized("utt-1", "ASK_PROBE", "REALTIME_MODEL", 1_000);
    ledger.firstSamplePlayed(1_100);

    expect(completed[0]?.transcriptChunks).toBe(3);
  });

  it("records which path spoke, including a fallback decided after authorization", () => {
    const { ledger, completed } = ledgerWithSink();

    ledger.mark("quietOnsetMs", 0);
    ledger.authorized("utt-1", "ASK_PROBE", "CACHED_AUDIO", 500);
    ledger.setSource("REALTIME_MODEL"); // the cache missed
    ledger.firstSamplePlayed(2_000);

    expect(completed[0]?.source).toBe("REALTIME_MODEL");
  });

  it("a new quietOnsetMs resets the pending chunk count", () => {
    const { ledger, completed } = ledgerWithSink();

    ledger.mark("quietOnsetMs", 0);
    ledger.mark("transcriptFinalMs", 200);
    ledger.mark("transcriptFinalMs", 400); // 2 chunks for the first quiet period

    ledger.mark("quietOnsetMs", 1_000); // candidate spoke again — chunk count resets
    ledger.mark("transcriptFinalMs", 1_300);
    ledger.authorized("utt-1", "ASK_PROBE", "CACHED_AUDIO", 1_500);
    ledger.firstSamplePlayed(1_600);

    expect(completed[0]?.transcriptChunks).toBe(1);
  });
});

describe("largestStages", () => {
  it("names the three biggest gaps, which is §6.1's acceptance criterion", () => {
    const ledger: LatencyLedger = {
      utteranceId: "utt-1",
      action: "ASK_PROBE",
      source: "REALTIME_MODEL",
      quietOnsetMs: 0,
      vadEndDetectedMs: 350,
      transcriptFinalMs: 1_100,
      authorizationReceivedMs: 3_500,
      speechRequestedMs: 3_550,
      firstSamplePlayedMs: 5_000,
    };

    const stages = largestStages(ledger);
    expect(stages[0]?.stage).toBe("transcriptFinalMs → authorizationReceivedMs");
    expect(stages[0]?.ms).toBe(2_400); // the policy silence hold, exactly
    expect(stages[1]?.ms).toBe(1_450);
    expect(stages).toHaveLength(3);
  });

  it("skips missing marks instead of reporting a gap of zero", () => {
    const ledger: LatencyLedger = {
      utteranceId: "utt-1",
      action: "ASK_PROBE",
      source: "CACHED_AUDIO",
      quietOnsetMs: 0,
      firstSamplePlayedMs: 600,
    };

    expect(largestStages(ledger)).toEqual([{ stage: "quietOnsetMs → firstSamplePlayedMs", ms: 600 }]);
  });
});

describe("responseLatencyMs", () => {
  it("is null for an utterance that was never heard", () => {
    expect(
      responseLatencyMs({
        utteranceId: "u",
        action: "ASK_PROBE",
        source: "CACHED_AUDIO",
        quietOnsetMs: 0,
      }),
    ).toBeNull();
  });
});
