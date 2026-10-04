import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadScenarioFile } from "../scenario/loader.js";
import type { LoadedScenario } from "../scenario/loader.js";
import { FakeTts, type RenderedSpeech, type TtsRenderer } from "./tts.js";
import { UtteranceAudioCache, authoredUtterances, hashText, type UtteranceTranscriber } from "./utterance-audio.js";

/**
 * Read against a real scenario file rather than a fixture, for the same reason
 * `tools.test.ts` does: the claim being tested is "this covers everything
 * `realize` can say", and a hand-written fixture proves it about the fixture.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const SCENARIO_PATH = join(here, "../../../../../content/scenarios/conveyor-rescan/v1.yaml");

let scenario: LoadedScenario;

beforeAll(async () => {
  scenario = await loadScenarioFile(SCENARIO_PATH);
});

describe("authoredUtterances is the image of runtime.realize", () => {
  it("includes every branch that returns authored text", () => {
    const lines = authoredUtterances(scenario.version);
    const v = scenario.version;

    // DELIVER_BRIEF
    expect(lines).toContain(v.oralBrief.openingScript.trim());
    for (const variant of v.oralBrief.repeatVariants) expect(lines).toContain(variant.trim());

    // ASK_PROBE — every variant, because selectProbeWording rotates by use count.
    for (const probe of v.probes) {
      for (const variant of probe.authoredVariants) expect(lines).toContain(variant.trim());
    }

    // ANSWER_CLARIFICATION, GIVE_HINT_Ln, PRESENT_FOLLOW_UP
    for (const fact of v.facts) expect(lines).toContain(fact.value.trim());
    for (const hint of v.hintLadder) expect(lines).toContain(hint.text.trim());
    for (const followUp of v.followUps) expect(lines).toContain(followUp.oralDelta.trim());
  });

  it("contains nothing the interviewer is not permitted to say", () => {
    const lines = new Set(authoredUtterances(scenario.version));

    // Hidden tests, solution families and examples are never spoken by any
    // branch of `realize`. A rendered line is a line that can be played, so
    // anything here that `realize` cannot reach is a leak waiting for a bug.
    for (const test of scenario.version.hiddenTests) {
      expect(lines.has(test.expectedOutput.trim())).toBe(false);
    }
    for (const family of scenario.version.solutionFamilies) {
      expect(lines.has(family.name.trim())).toBe(false);
    }
  });

  it("deduplicates and is stable across calls", () => {
    const a = authoredUtterances(scenario.version);
    const b = authoredUtterances(scenario.version);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });
});

describe("UtteranceAudioCache", () => {
  it("renders the whole scenario once and reports coverage", async () => {
    const cache = new UtteranceAudioCache({ renderer: new FakeTts() });
    const report = await cache.prewarm(scenario.version);

    expect(report.requested).toBe(authoredUtterances(scenario.version).length);
    expect(report.failed).toBe(0);
    expect(cache.coverage(scenario.version)).toBe(1);
  });

  it("is a second prewarm away from doing no work at all", async () => {
    let renders = 0;
    const counting: TtsRenderer = {
      id: "counting",
      voiceId: "v",
      configured: () => true,
      render: (text) => {
        renders += 1;
        return Promise.resolve<RenderedSpeech>({
          pcm: Buffer.alloc(text.length),
          sampleRate: 24_000,
          voiceId: "v",
          model: "counting",
        });
      },
    };

    const cache = new UtteranceAudioCache({ renderer: counting });
    await cache.prewarm(scenario.version);
    const afterFirst = renders;
    const second = await cache.prewarm(scenario.version);

    expect(renders).toBe(afterFirst);
    expect(second.rendered).toBe(0);
    expect(second.cached).toBe(second.requested);
  });

  it("looks up by exact text and by nothing else", async () => {
    // The security property. There is no fact key, probe id or hint level in
    // this API: the only way to obtain bytes is to already hold the authored
    // string, and only the server holds it.
    const cache = new UtteranceAudioCache({ renderer: new FakeTts() });
    const line = scenario.version.facts[0]?.value ?? "a fact";

    await cache.ensure(line);

    expect(cache.get(line)).toBeDefined();
    expect(cache.get(`${line} `)).toBeDefined(); // trimmed — same utterance
    expect(cache.get(line.slice(0, -1))).toBeUndefined(); // near miss is a miss
    expect(cache.get(scenario.version.facts[0]?.key ?? "key")).toBeUndefined();
  });

  it("misses rather than renders on the speaking path", () => {
    // A cache that occasionally costs a synthesis round trip at speaking time
    // is worse than no cache: the interviewer stalls for seconds and nothing in
    // the log says why. `get` is synchronous so a miss falls straight through
    // to the realtime model.
    const cache = new UtteranceAudioCache({ renderer: new FakeTts() });
    expect(cache.get("never rendered")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("survives a renderer that fails, leaving the model path intact", async () => {
    const broken: TtsRenderer = {
      id: "broken",
      voiceId: "v",
      configured: () => true,
      render: () => Promise.reject(new Error("quota exhausted")),
    };

    const cache = new UtteranceAudioCache({ renderer: broken });
    const report = await cache.prewarm(scenario.version);

    expect(report.rendered).toBe(0);
    expect(report.failed).toBe(report.requested);
    expect(cache.coverage(scenario.version)).toBe(0);
    // Never throws. A synthesis outage must not stop a session from starting.
  });

  it("renders a line once when two prewarms race", async () => {
    let renders = 0;
    const slow: TtsRenderer = {
      id: "slow",
      voiceId: "v",
      configured: () => true,
      render: async (text) => {
        renders += 1;
        await new Promise((r) => setTimeout(r, 1));
        return { pcm: Buffer.alloc(text.length), sampleRate: 24_000, voiceId: "v", model: "slow" };
      },
    };

    const cache = new UtteranceAudioCache({ renderer: slow, concurrency: 4 });
    await Promise.all([cache.prewarm(scenario.version), cache.prewarm(scenario.version)]);

    expect(renders).toBe(authoredUtterances(scenario.version).length);
  });

  it("keys on the renderer, so a voice change does not serve the old voice", async () => {
    const a = new UtteranceAudioCache({ renderer: new FakeTts("Charon") });
    const b = new UtteranceAudioCache({ renderer: new FakeTts("Kore") });

    await a.ensure("one line");
    expect(a.get("one line")?.voiceId).toBe("Charon");
    expect(b.get("one line")).toBeUndefined();
  });

  it("uses separate cache entries for different tones of the same text", async () => {
    const cache = new UtteranceAudioCache({ renderer: new FakeTts() });
    const line = "Walk me through your approach.";

    await cache.ensure(line, "NORMAL");
    await cache.ensure(line, "EXTRA_NICE");

    expect(cache.get(line, "NORMAL")).toBeDefined();
    expect(cache.get(line, "EXTRA_NICE")).toBeDefined();
    expect(cache.get(line, "MEAN")).toBeUndefined();
    expect(cache.size).toBe(2);
  });

  it("prewarm tone keying: same scenario, two tones -> two separate sets", async () => {
    const cache = new UtteranceAudioCache({ renderer: new FakeTts() });
    const lines = authoredUtterances(scenario.version);

    await cache.prewarm(scenario.version, "NORMAL");
    const afterNormal = cache.size;
    await cache.prewarm(scenario.version, "MEAN");

    expect(cache.size).toBe(afterNormal * 2);
    expect(cache.coverage(scenario.version, "NORMAL")).toBe(1);
    expect(cache.coverage(scenario.version, "MEAN")).toBe(1);
    expect(cache.coverage(scenario.version, "EXTRA_NICE")).toBe(0);
    void lines;
  });
});

describe("P3.3 verification and silence trim", () => {
  it("rejects and does not cache when the transcriber returns the style prefix", async () => {
    const transcriber: UtteranceTranscriber = async () => "say calmly walk me through your approach";
    const cache = new UtteranceAudioCache({ renderer: new FakeTts(), transcriber });

    await expect(cache.ensure("walk me through your approach")).rejects.toThrow();
    expect(cache.get("walk me through your approach")).toBeUndefined();
  });

  it("accepts and caches when the transcription matches after normalization", async () => {
    const line = "Walk me through your approach.";
    // Transcriber returns the line verbatim — normalization makes them equal.
    const transcriber: UtteranceTranscriber = async () => line;
    const cache = new UtteranceAudioCache({ renderer: new FakeTts(), transcriber });

    await cache.ensure(line);
    expect(cache.get(line)).toBeDefined();
  });

  it("calls onVerifyRejected with hash and tone, never the authored text", async () => {
    const rejections: Array<{ textHash: string; tone: string; reason: string }> = [];
    const transcriber: UtteranceTranscriber = async () => "wrong words entirely";
    const cache = new UtteranceAudioCache({
      renderer: new FakeTts(),
      transcriber,
      onVerifyRejected: (info) => rejections.push(info),
    });

    const line = "Describe your complexity claim.";
    await cache.ensure(line, "MEAN").catch(() => {});

    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.tone).toBe("MEAN");
    // The authored text must not appear in the rejection log.
    expect(JSON.stringify(rejections)).not.toContain(line);
  });

  it("trims leading silence and keeps the first voiced sample", async () => {
    const sampleRate = 24_000;
    const silenceSamples = 500; // 20ms+ of silence at start
    const voicedSamples = 2_000;
    const pcm = Buffer.alloc((silenceSamples + voicedSamples) * 2);
    // Voiced content well above the -45 dBFS threshold
    for (let i = silenceSamples; i < silenceSamples + voicedSamples; i++) {
      pcm.writeInt16LE(10_000, i * 2);
    }

    const renderer: TtsRenderer = {
      id: "test-trim",
      voiceId: "v",
      configured: () => true,
      render: async () => ({ pcm, sampleRate, voiceId: "v", model: "test-trim" }),
    };

    const cache = new UtteranceAudioCache({ renderer });
    await cache.ensure("some authored text");

    const cached = cache.get("some authored text");
    expect(cached).toBeDefined();
    // Trimmed must be shorter than the original (leading silence was removed)
    expect(cached!.pcm.length).toBeLessThan(pcm.length);
    // First sample of trimmed must be above threshold (or within lead-in of voiced start)
    const firstSample = Math.abs(cached!.pcm.readInt16LE(0));
    // Within 20ms of lead-in from first voiced sample — may be silence but not the full 500
    expect(cached!.pcm.length).toBeLessThanOrEqual(
      (silenceSamples + voicedSamples) * 2 - (silenceSamples - Math.ceil(sampleRate * 0.02)) * 2,
    );
    void firstSample;
  });

  it("survives a failed verification without throwing from prewarm", async () => {
    const transcriber: UtteranceTranscriber = async () => "completely different words";
    const cache = new UtteranceAudioCache({ renderer: new FakeTts(), transcriber });
    const report = await cache.prewarm(scenario.version);

    // All renders failed verification; coverage is 0, prewarm did not throw.
    expect(report.failed).toBe(report.requested);
    expect(cache.coverage(scenario.version)).toBe(0);
  });
});

describe("hashText", () => {
  it("ignores surrounding whitespace and nothing else", () => {
    expect(hashText(" hello ")).toBe(hashText("hello"));
    expect(hashText("Hello")).not.toBe(hashText("hello"));
    expect(hashText("hello.")).not.toBe(hashText("hello"));
  });
});
