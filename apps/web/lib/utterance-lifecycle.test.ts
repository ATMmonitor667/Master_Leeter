import { describe, expect, it } from "vitest";
import { UtteranceLifecycle } from "./utterance-lifecycle";

/**
 * The property under test: an utterance is COMPLETED only when its source
 * finished honestly AND playback drained. Every other ending is named.
 */

function model(id = "utt-1") {
  return new UtteranceLifecycle(id, "ANSWER_CLARIFICATION", "MODEL", 0);
}

function cached(id = "utt-1") {
  return new UtteranceLifecycle(id, "DELIVER_BRIEF", "CACHED", 0);
}

describe("completion needs both halves of delivery", () => {
  it("completes after the source finishes and playback drains, in that order", () => {
    const u = model();
    u.apply({ type: "REQUESTED" }, 10);
    u.apply({ type: "AUDIO_RECEIVED", seconds: 1.5 }, 900);
    u.apply({ type: "PLAYBACK_STARTED" }, 930);
    expect(u.phase).toBe("PLAYING");
    // Generation finished; the speaker has not.
    expect(u.apply({ type: "SOURCE_COMPLETE" }, 1_000)).toBeNull();
    const report = u.apply({ type: "PLAYBACK_DRAINED" }, 2_500);
    expect(report?.outcome).toBe("COMPLETED");
    expect(report?.firstAudio).toBe(true);
    expect(report?.receivedAudioMs).toBe(1_500);
    expect(report?.durationMs).toBe(2_500);
  });

  it("completes when playback had already drained before the source finished", () => {
    const u = cached();
    u.apply({ type: "AUDIO_RECEIVED", seconds: 0.4 }, 0);
    u.apply({ type: "PLAYBACK_STARTED" }, 0);
    u.apply({ type: "PLAYBACK_DRAINED" }, 400);
    expect(u.underruns).toBe(1);
    expect(u.apply({ type: "SOURCE_COMPLETE" }, 450)?.outcome).toBe("COMPLETED");
  });

  it("treats a mid-stream drain as an underrun, not an ending", () => {
    const u = model();
    u.apply({ type: "AUDIO_RECEIVED", seconds: 0.2 }, 0);
    u.apply({ type: "PLAYBACK_STARTED" }, 0);
    expect(u.apply({ type: "PLAYBACK_DRAINED" }, 200)).toBeNull();
    expect(u.terminal).toBe(false);
    expect(u.underruns).toBe(1);
  });
});

describe("faults end honestly", () => {
  it("fails an empty provider turn instead of calling it delivered", () => {
    const u = model();
    u.apply({ type: "REQUESTED" }, 0);
    const report = u.apply({ type: "SOURCE_COMPLETE" }, 2_000);
    expect(report?.outcome).toBe("FAILED");
    expect(report?.reason).toBe("EMPTY_RESPONSE");
    expect(report?.firstAudio).toBe(false);
  });

  it("fails a cached tail that died after the prefix played, with what was played", () => {
    const u = cached();
    u.apply({ type: "AUDIO_RECEIVED", seconds: 2 }, 0);
    u.apply({ type: "PLAYBACK_STARTED" }, 0);
    const report = u.apply({ type: "FAIL", reason: "CACHED_TAIL_TRUNCATED", unplayedSeconds: 0.5 }, 1_500);
    expect(report?.outcome).toBe("FAILED");
    expect(report?.firstAudio).toBe(true);
    expect(report?.playedAudioMs).toBe(1_500);
  });

  it("cancels, rather than interrupts, when the candidate spoke before any audio", () => {
    const u = model();
    u.apply({ type: "REQUESTED" }, 0);
    const report = u.apply({ type: "INTERRUPT" }, 800);
    expect(report?.outcome).toBe("CANCELLED");
    expect(report?.firstAudio).toBe(false);
  });

  it("interrupts after audio and records how much was never played", () => {
    const u = model();
    u.apply({ type: "AUDIO_RECEIVED", seconds: 3 }, 0);
    u.apply({ type: "PLAYBACK_STARTED" }, 0);
    const report = u.apply({ type: "INTERRUPT", unplayedSeconds: 2 }, 1_000);
    expect(report?.outcome).toBe("INTERRUPTED");
    expect(report?.playedAudioMs).toBe(1_000);
  });
});

describe("duplicate and out-of-order signals", () => {
  it("ignores everything after a terminal outcome", () => {
    const u = model();
    u.apply({ type: "AUDIO_RECEIVED", seconds: 1 }, 0);
    u.apply({ type: "PLAYBACK_STARTED" }, 0);
    const first = u.apply({ type: "INTERRUPT" }, 100);
    expect(first?.outcome).toBe("INTERRUPTED");
    // Late provider completion, a stray onended, a second barge-in.
    expect(u.apply({ type: "SOURCE_COMPLETE" }, 200)).toBeNull();
    expect(u.apply({ type: "PLAYBACK_DRAINED" }, 300)).toBeNull();
    expect(u.apply({ type: "INTERRUPT" }, 400)).toBeNull();
    expect(u.outcome).toBe(first);
  });

  it("ignores a drain with nothing scheduled", () => {
    const u = model();
    u.apply({ type: "REQUESTED" }, 0);
    expect(u.apply({ type: "PLAYBACK_DRAINED" }, 10)).toBeNull();
    expect(u.underruns).toBe(0);
  });

  it("keeps the first REQUESTED and does not move backwards", () => {
    const u = model();
    u.apply({ type: "AUDIO_RECEIVED", seconds: 1 }, 0);
    u.apply({ type: "REQUESTED" }, 10);
    expect(u.phase).toBe("FIRST_AUDIO");
  });

  it("allows a source switch only before any audio exists", () => {
    const u = cached();
    expect(u.switchSource("MODEL")).toBe(true);
    expect(u.source).toBe("MODEL");
    u.apply({ type: "AUDIO_RECEIVED", seconds: 0.1 }, 0);
    expect(u.switchSource("CACHED")).toBe(false);
  });
});
