import { createHash } from "node:crypto";
import type { InterviewScenarioVersion, InterviewerTone } from "@master-leeter/contracts";
import type { RenderedSpeech, TtsRenderer } from "./tts.js";

/**
 * The interviewer's voice, rendered ahead of time (V3).
 *
 * Two things live here and they are deliberately the same file, because they
 * only make sense together: the enumeration of everything a pinned scenario
 * version permits the interviewer to say, and the cache of that set as audio.
 *
 * ── Why enumeration is possible ────────────────────────────────────────────
 *
 * `runtime.realize()` is the only function in this system that turns a gate
 * decision into words, and every branch of it reads a string out of the pinned
 * scenario. So the set below is not an approximation of what the interviewer
 * might say — it is the exact image of `realize`, and `utterance-audio.test.ts`
 * asserts that by walking the scenario rather than by listing strings.
 *
 * If someone adds a branch to `realize` that composes a sentence, the pre-render
 * silently stops covering it and the line falls back to the realtime model. That
 * is the correct failure — slower, never wrong — but it is also a sign that
 * invariant 3 has been broken somewhere else, and the coverage metric below is
 * what surfaces it.
 *
 * ── What is deliberately not in the set ────────────────────────────────────
 *
 * `ACKNOWLEDGE_BRIEFLY` has no authored text; `realize` returns `text: ""` for
 * it precisely so there is nothing behind it to leak. It stays on the model
 * path, which is the honest hybrid: cached audio for the authored 90%, a live
 * model for the handful of utterances that are not authored content.
 *
 * Hidden tests, solution families, examples, recognition signals and rubric
 * content are absent for the obvious reason. Nothing that is not spoken by
 * `realize` is rendered, because a rendered line is a line that can be played.
 */

/**
 * Everything the interviewer is permitted to say in this scenario version.
 *
 * Deduplicated, because a fact value and a hint occasionally coincide and
 * rendering the same sentence twice is a wasted API call and a second copy in
 * memory. Order is stable so a prewarm log reads the same way twice.
 */
export function authoredUtterances(scenario: InterviewScenarioVersion): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (text: string | undefined): void => {
    if (!text) return;
    const trimmed = text.trim();
    if (trimmed === "" || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  // DELIVER_BRIEF — the opening script first, then the reviewed repeat variants.
  add(scenario.oralBrief.openingScript);
  for (const variant of scenario.oralBrief.repeatVariants) add(variant);

  // ASK_PROBE — every authored variant, since `selectProbeWording` rotates
  // through them by use count and any of them can be the one spoken.
  for (const probe of scenario.probes) {
    for (const variant of probe.authoredVariants) add(variant);
  }

  // ANSWER_CLARIFICATION — the canonical fact values. Disclosure level is NOT
  // filtered on: a fact the candidate is not yet entitled to hear is one the
  // gate will not authorize, and pre-rendering it changes nothing about who can
  // ask for the bytes (see `UtteranceAudioCache` — lookup is by exact authorized
  // text, never by fact key).
  for (const fact of scenario.facts) add(fact.value);

  // GIVE_HINT_L1..L4 — the whole ladder. Policy caps which levels are reachable
  // per mode, but the scenario version is pinned and the policy is not what this
  // cache is keyed on.
  for (const hint of scenario.hintLadder) add(hint.text);

  // PRESENT_FOLLOW_UP
  for (const followUp of scenario.followUps) add(followUp.oralDelta);

  return out;
}

export interface CachedAudio extends RenderedSpeech {
  /** Hash of the exact text this was rendered from. The cache key, minus the renderer and tone. */
  textHash: string;
}

export interface PrewarmReport {
  rendererId: string;
  scenarioVersionId: string;
  tone: InterviewerTone;
  requested: number;
  rendered: number;
  cached: number;
  failed: number;
  elapsedMs: number;
  /** First failure, for the boot log. Not an array: one example is enough to debug. */
  sampleError?: string;
}

/**
 * Verify that a rendered audio buffer actually says the authored words.
 *
 * P3.3: after trimming, the audio is transcribed and the word sequence is
 * compared with the authored text. This catches style directions being spoken
 * aloud ("say calmly: walk me through...") and words being altered by synthesis.
 *
 * The verifier is injected, so tests can provide a fake. The real implementation
 * sends the audio to a Gemini text model for verbatim transcription.
 */
export type UtteranceTranscriber = (pcm: Buffer, sampleRate: number) => Promise<string>;

export interface UtteranceAudioCacheOptions {
  renderer: TtsRenderer;
  /**
   * How many renders run at once.
   *
   * Small on purpose. This is a free-tier quota shared with the classifier, and
   * prewarm runs while the candidate is reading the workspace — it has seconds
   * to spare and no reason to spend the whole rate limit in one burst.
   */
  concurrency?: number;
  /**
   * When set, every newly rendered audio is transcribed and the word sequence
   * must match the authored text. Mismatches are rejected (the line falls back
   * to the model path) and the reason is logged.
   *
   * Mandatory when using non-NORMAL tones — style directions can be spoken
   * aloud and a pre-rendered line is played verbatim to candidates.
   */
  transcriber?: UtteranceTranscriber;
  /**
   * Receives rejection details when verification fails. Never receives the
   * authored text — only the hash and tone.
   */
  onVerifyRejected?: (info: { textHash: string; tone: InterviewerTone; reason: string }) => void;
  now?: () => number;
}

/**
 * Rendered audio, keyed by renderer, tone, and the exact text.
 *
 * ── Why the key is the text hash rather than the scenario version ──────────
 *
 * The obvious key is `(scenarioVersionId, voiceId, ttsModel)` plus some id for
 * the line. Hashing the text subsumes all of that and is strictly better in two
 * ways: two scenario versions that share an unchanged probe wording share one
 * render, and a line whose text is edited cannot collide with the render of the
 * old text — which is the failure that would have the interviewer confidently
 * speaking a sentence that no longer exists in the scenario.
 *
 * The renderer id is in the key because a voice change or a model change must
 * not be served from a cache rendered by the previous one.
 *
 * The tone is in the key because the same text at EXTRA_NICE and MEAN are
 * different audio — the synthesis instruction differs, and P3.3 verification
 * confirms both are correct for their respective renders.
 *
 * ── Lookup is by text, and that is the security property ───────────────────
 *
 * Nothing here is addressable by fact key, probe id, or hint level. The only
 * way to obtain bytes is to already hold the exact authored string, and the
 * only component that holds it is the server, at the moment the gate authorized
 * that specific utterance. The browser never sends a key of any kind — it asks
 * for "the audio for the utterance you authorized", and the session module
 * resolves that to text on its side. So this cache cannot be browsed.
 */
export class UtteranceAudioCache {
  private readonly entries = new Map<string, CachedAudio>();
  private readonly inFlight = new Map<string, Promise<CachedAudio>>();
  private readonly renderer: TtsRenderer;
  private readonly concurrency: number;
  private readonly transcriber: UtteranceTranscriber | undefined;
  private readonly onVerifyRejected: UtteranceAudioCacheOptions["onVerifyRejected"];
  private readonly now: () => number;

  constructor(opts: UtteranceAudioCacheOptions) {
    this.renderer = opts.renderer;
    this.concurrency = Math.max(1, opts.concurrency ?? 3);
    this.transcriber = opts.transcriber;
    this.onVerifyRejected = opts.onVerifyRejected;
    this.now = opts.now ?? (() => Date.now());
  }

  get rendererId(): string {
    return this.renderer.id;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Audio for exactly this text at the given tone, if it has already been rendered.
   *
   * Synchronous and never renders. A miss at speaking time must fall straight
   * through to the realtime model rather than block the interviewer for however
   * long a synthesis round trip takes — a cache that occasionally costs three
   * seconds is worse than no cache, because the failure is invisible until a
   * candidate is sitting in it.
   */
  get(text: string, tone?: InterviewerTone): CachedAudio | undefined {
    return this.entries.get(this.keyFor(text, tone));
  }

  /**
   * Render this line unless it is already present. Used by prewarm and by tests.
   *
   * Deduplicates concurrent calls for the same text, so a prewarm racing a
   * second prewarm (two tabs, a reconnect) renders each line once.
   *
   * Rejects rather than resolving to null on a synthesis failure. `prewarm` is
   * the thing that must never throw, and it can only put a useful message in
   * its report if the error reaches it — a renderer that swallowed the reason
   * would leave "some lines failed" as the entire diagnosis.
   */
  async ensure(text: string, tone?: InterviewerTone): Promise<CachedAudio> {
    const key = this.keyFor(text, tone);
    const existing = this.entries.get(key);
    if (existing) return existing;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const task = this.renderer
      .render(text, tone === undefined ? {} : { tone })
      .then(async (speech) => {
        // P3.3: Trim leading and trailing silence
        const trimmed = trimSilence(speech.pcm, speech.sampleRate);

        // P3.3: Verify transcription matches authored text (when a verifier is set)
        if (this.transcriber) {
          const transcribed = await this.transcriber(trimmed, speech.sampleRate);
          if (!wordsMatch(text, transcribed)) {
            const textHash = hashText(text);
            this.onVerifyRejected?.({
              textHash,
              tone: tone ?? "NORMAL",
              reason: "transcription word sequence did not match authored text",
            });
            throw new Error(`TTS verification failed for text hash ${textHash}`);
          }
        }

        const entry: CachedAudio = { ...speech, pcm: trimmed, textHash: hashText(text) };
        this.entries.set(key, entry);
        return entry;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, task);
    return task;
  }

  /**
   * Render everything this scenario version permits, before the interview runs.
   *
   * Never throws and never rejects. A prewarm that fails leaves an interviewer
   * that is as slow as `main` and exactly as correct, so the caller logs the
   * report and carries on — refusing to start a session because a synthesis
   * quota was exhausted would trade a latency regression for an outage.
   */
  async prewarm(scenario: InterviewScenarioVersion, tone?: InterviewerTone): Promise<PrewarmReport> {
    const started = this.now();
    const lines = authoredUtterances(scenario);

    let rendered = 0;
    let failed = 0;
    let cached = 0;
    let sampleError: string | undefined;

    // A hand-rolled pool rather than `Promise.all` over everything: the whole
    // point of the concurrency cap is that it is a cap.
    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, lines.length) }, async () => {
      for (;;) {
        const index = cursor++;
        const text = lines[index];
        if (text === undefined) return;

        if (this.entries.has(this.keyFor(text, tone))) {
          cached += 1;
          continue;
        }

        try {
          await this.ensure(text, tone);
          rendered += 1;
        } catch (err) {
          failed += 1;
          sampleError ??= (err as Error)?.message ?? String(err);
        }
      }
    });

    await Promise.all(workers);

    return {
      rendererId: this.renderer.id,
      scenarioVersionId: scenario.id,
      tone: tone ?? "NORMAL",
      requested: lines.length,
      rendered,
      cached,
      failed,
      elapsedMs: this.now() - started,
      ...(sampleError ? { sampleError } : {}),
    };
  }

  /**
   * How much of this scenario at the given tone the cache can actually speak, 0–1.
   *
   * The number V3's acceptance criterion is stated against, and the one that
   * degrades quietly if someone adds an unauthored branch to `realize`.
   */
  coverage(scenario: InterviewScenarioVersion, tone?: InterviewerTone): number {
    const lines = authoredUtterances(scenario);
    if (lines.length === 0) return 1;
    const present = lines.filter((line) => this.entries.has(this.keyFor(line, tone))).length;
    return present / lines.length;
  }

  private keyFor(text: string, tone?: InterviewerTone): string {
    return `${this.renderer.id}::${tone ?? "NORMAL"}::${hashText(text)}`;
  }
}

/**
 * Hash of the normalized text.
 *
 * Trimmed, because `realize` returns authored strings verbatim and a trailing
 * newline in a content file must not produce a second render of the same
 * sentence. Nothing else is normalized: case and punctuation change how a line
 * is spoken, so two strings that differ in them are two different utterances.
 */
export function hashText(text: string): string {
  return createHash("sha256").update(text.trim(), "utf8").digest("hex");
}

// ── P3.3: Silence trim ──────────────────────────────────────────────────────

/**
 * Amplitude threshold for "voiced" in a 16-bit PCM buffer.
 *
 * -45 dBFS: 10^(-45/20) * 32768 ≈ 184. Anything below this in a sample is
 * treated as silence for the purpose of finding where speech begins and ends.
 */
const SILENCE_THRESHOLD = 184;

/**
 * Remove leading and trailing silence from a PCM16 buffer.
 *
 * - Leading: find the first sample above the threshold; keep 20 ms of lead-in
 *   before it so the attack is not clipped.
 * - Trailing: find the last sample above the threshold; keep 80 ms of tail
 *   after it so the release is not cut.
 *
 * A buffer that is entirely below the threshold is returned unchanged — it may
 * legitimately be a pause the persona expects to say nothing over.
 */
function trimSilence(pcm: Buffer, sampleRate: number): Buffer {
  const leadInSamples = Math.ceil(sampleRate * 0.020);
  const trailSamples = Math.ceil(sampleRate * 0.080);
  const sampleCount = Math.floor(pcm.length / 2);

  let firstVoiced = -1;
  for (let i = 0; i < sampleCount; i++) {
    if (Math.abs(pcm.readInt16LE(i * 2)) >= SILENCE_THRESHOLD) {
      firstVoiced = i;
      break;
    }
  }

  if (firstVoiced === -1) return pcm;

  let lastVoiced = firstVoiced;
  for (let i = sampleCount - 1; i >= firstVoiced; i--) {
    if (Math.abs(pcm.readInt16LE(i * 2)) >= SILENCE_THRESHOLD) {
      lastVoiced = i;
      break;
    }
  }

  const startSample = Math.max(0, firstVoiced - leadInSamples);
  const endSample = Math.min(sampleCount, lastVoiced + 1 + trailSamples);

  return pcm.subarray(startSample * 2, endSample * 2);
}

// ── P3.3: Word-sequence comparison ─────────────────────────────────────────

/**
 * Normalize text to a comparable word sequence.
 *
 * Lowercase, strip punctuation, collapse whitespace. Numbers are left as
 * digits — a full number-to-words conversion is fragile and the authored lines
 * are not expected to contain numerals that TTS would change in transcription.
 */
function normalizeWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function wordsMatch(authored: string, transcribed: string): boolean {
  return normalizeWords(authored) === normalizeWords(transcribed);
}
