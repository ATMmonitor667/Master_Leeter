/**
 * Per-utterance latency ledger (V0).
 *
 * ── Why this is the first change and not the last ──────────────────────────
 *
 * The latency study assembles a 3.9–5.2 s budget from the code, ADR-001's
 * spike numbers, and documented provider behaviour. It is a derivation, not a
 * measurement, and it contains one term — transcript finalization — marked
 * *unmeasured* on the critical path, with a plausible range spanning 250 ms to
 * over a second. Every recommendation after it is ordered by numbers that could
 * be wrong in either direction. So: measure first, and measure where the
 * candidate's ear is, which is here and not on the server.
 *
 * ── Deliberately pure ──────────────────────────────────────────────────────
 *
 * Marks in, ledger out. No `fetch`, no clock of its own, no `AudioContext` —
 * the same split `vad.ts` and `playback.ts` use, for the same reason: the part
 * that can be verified in CI should not be sitting inside the part that cannot.
 *
 * ── What it reports, and what it refuses to ────────────────────────────────
 *
 * The product metric is `firstSamplePlayedMs − quietOnsetMs`: last candidate
 * sample to first audible interviewer sample. Everything else is there to say
 * which stage ate the time. The ledger sends MARKS rather than the differences,
 * because which differences are worth taking is a question the analysis should
 * be able to change its mind about without shipping a new client.
 *
 * All marks come from one browser clock, so only differences within a ledger
 * mean anything. Nothing here is ever compared against a server timestamp.
 *
 * ── Every turn, including the ones that failed ─────────────────────────────
 *
 * A ledger now closes at the utterance's TERMINAL outcome rather than at its
 * first sample, and it is reported whatever that outcome was. Reporting only
 * successful turns hides exactly the worst cases: the brief that never played,
 * the answer that stalled halfway. Utterances with no candidate turn in front
 * of them (the opening brief) are reported too, without a quiet onset, so
 * authorization-to-audible can be measured separately from end-of-turn-to-
 * audible.
 */

export const LATENCY_MARKS = [
  /** VAD's BACKDATED quiet onset, not the moment it decided. The human clock starts here. */
  "quietOnsetMs",
  /** The VAD declared the end, one hangover later. */
  "vadEndDetectedMs",
  "activityEndSentMs",
  /** First interim transcript chunk for this turn. */
  "firstInterimTranscriptMs",
  /** The LAST final transcript chunk before authorization (overwritten on each final chunk). */
  "transcriptFinalMs",
  /** ACTION arrived: the gate had already decided by now. */
  "authorizationReceivedMs",
  "speechRequestedMs",
  "audioFetchStartedMs",
  "firstAudioByteMs",
  /** What the candidate actually experiences. */
  "firstSamplePlayedMs",
] as const;

export type LatencyMark = (typeof LATENCY_MARKS)[number];

/** Marks owned by the utterance itself rather than by the candidate's turn. */
const UTTERANCE_MARKS: ReadonlySet<LatencyMark> = new Set<LatencyMark>([
  "authorizationReceivedMs",
  "speechRequestedMs",
  "audioFetchStartedMs",
  "firstAudioByteMs",
  "firstSamplePlayedMs",
]);

/** Which path produced the audio — the comparison V3 exists to make. */
export type SpeechSource = "CACHED_AUDIO" | "REALTIME_MODEL";

/**
 * Every optional mark is `?: number | undefined` rather than `?: number`.
 *
 * `exactOptionalPropertyTypes` is on, and these are pass-through values built by
 * spreading a partially-filled record — the same reason `GeminiClientOptions`
 * spells its optionals out this way. "Absent" and "present but undefined" mean
 * the same thing for a mark that was never taken.
 */
export interface LatencyLedger {
  utteranceId: string;
  action: string;
  source: SpeechSource;
  /** Absent when no candidate turn preceded the utterance (e.g. the brief). */
  quietOnsetMs?: number | undefined;
  vadEndDetectedMs?: number | undefined;
  activityEndSentMs?: number | undefined;
  firstInterimTranscriptMs?: number | undefined;
  /** The LAST final transcript chunk before authorization. */
  transcriptFinalMs?: number | undefined;
  /** How many final transcript chunks arrived in this turn. */
  transcriptChunks?: number | undefined;
  authorizationReceivedMs?: number | undefined;
  speechRequestedMs?: number | undefined;
  audioFetchStartedMs?: number | undefined;
  firstAudioByteMs?: number | undefined;
  firstSamplePlayedMs?: number | undefined;
  /** Server-measured delta: ingest of SPEECH_FINAL to gate decision. Never cross-clock. */
  serverDecisionMs?: number | undefined;
  /** Server-measured delta: classifier call duration. Subset of serverDecisionMs. */
  classifierMs?: number | undefined;
  /** Which classifier branch produced the decision (populated in P5). */
  classifierSource?: string | undefined;
  /** Whether prosodic prediction pulled the turn end forward (populated in P4). */
  prosodyPull?: boolean | undefined;
  /** Summed duration of relayed tool calls during this utterance. */
  toolMs?: number | undefined;
  toolCalls?: number | undefined;
  toolFailures?: number | undefined;
  /** How the utterance ended. Present on every reported ledger. */
  outcome?: "COMPLETED" | "INTERRUPTED" | "FAILED" | "CANCELLED" | undefined;
  outcomeReason?: string | undefined;
  terminalMs?: number | undefined;
  underruns?: number | undefined;
  receivedAudioMs?: number | undefined;
  playedAudioMs?: number | undefined;
}

/** The parts of an utterance's terminal report the ledger records. */
export interface LedgerTerminal {
  outcome: NonNullable<LatencyLedger["outcome"]>;
  reason?: string | undefined;
  underruns: number;
  receivedAudioMs: number;
  playedAudioMs: number;
}

export interface LatencyLedgerOptions {
  /** Called once per utterance, when it reaches a terminal outcome. */
  onComplete: (ledger: LatencyLedger) => void;
  /**
   * How long a ledger may sit unfinished before it is dropped.
   *
   * Every utterance should reach a terminal outcome (the voice session's
   * watchdogs guarantee one), so this is a backstop against a caller bug, not
   * a measurement path. A ledger nobody closed must not be reported as a very
   * slow one.
   */
  staleAfterMs?: number;
}

/**
 * Collects marks for the utterance currently in flight.
 *
 * Single-slot on purpose. The Response Gate authorizes one utterance at a time
 * and `firstSamplePlayed` closes it before another can open, so a second
 * in-flight ledger would mean the gate's window had been violated — which is
 * worth surfacing rather than accommodating.
 *
 * The awkward part, stated plainly: the boundary marks (`quietOnsetMs` through
 * `transcriptFinalMs`) happen BEFORE the server mints an utterance id, so they
 * are buffered against the turn and adopted by whichever utterance the
 * authorization turns out to be. That is a real assumption — that the
 * authorization the client receives answers the most recent quiet period — and
 * it is the same assumption `turn-completion.ts` makes when it measures
 * `silenceMs` from the last speech-stop. If it is ever wrong, the ledger
 * reports a gap that is too long rather than too short, which is the safe
 * direction for a number used to justify making things faster.
 */
export class VoiceLatencyLedger {
  private pending: Partial<Record<LatencyMark, number>> = {};
  private pendingChunks = 0;
  private open: LatencyLedger | null = null;
  private openedAtMs = 0;
  private readonly staleAfterMs: number;

  constructor(private readonly opts: LatencyLedgerOptions) {
    // Long enough for a full spoken brief plus its deadlines.
    this.staleAfterMs = opts.staleAfterMs ?? 180_000;
  }

  /**
   * Record a mark that happens before an utterance exists.
   *
   * A second `quietOnsetMs` replaces the first: the candidate spoke again, so
   * the previous quiet period is no longer the one any answer would be
   * answering. `transcriptFinalMs` is always overwritten — the last final chunk
   * is the one the server transcript was complete for, and `transcriptChunks`
   * counts how many arrived. Every other mark is kept on first write, because a
   * stage that reports twice for one turn is reporting a retry, and the first
   * attempt is when the clock actually started.
   */
  mark(name: LatencyMark, atMs: number): void {
    if (name === "quietOnsetMs") {
      this.pending = { quietOnsetMs: atMs };
      this.pendingChunks = 0;
      return;
    }

    // Once the open utterance is audible, candidate-turn marks belong to the
    // NEXT turn: the ledger now stays open through a long brief, and a turn
    // the candidate takes during it must not be folded into this one.
    const toOpen =
      this.open !== null &&
      (UTTERANCE_MARKS.has(name) || this.open.firstSamplePlayedMs === undefined);

    if (name === "transcriptFinalMs") {
      if (toOpen && this.open) {
        this.open.transcriptFinalMs = atMs;
        this.open.transcriptChunks = (this.open.transcriptChunks ?? 0) + 1;
      } else {
        this.pending.transcriptFinalMs = atMs;
        this.pendingChunks += 1;
      }
      return;
    }

    if (toOpen && this.open) {
      if (this.open[name] === undefined) this.open[name] = atMs;
      return;
    }
    if (this.pending[name] === undefined) this.pending[name] = atMs;
  }

  /**
   * The server authorized an utterance; adopt the marks collected so far.
   *
   * Always opens. Without a quiet onset — an utterance the interviewer opens
   * on its own, such as the brief — the ledger still measures authorization to
   * audible playback and the outcome; `responseLatencyMs` stays null, so no
   * multi-minute "latency" enters the end-of-turn distribution.
   */
  authorized(utteranceId: string, action: string, source: SpeechSource, atMs: number): boolean {
    this.expire(atMs);

    const quietOnsetMs = this.pending.quietOnsetMs;
    this.open = {
      utteranceId, action, source,
      ...(quietOnsetMs !== undefined ? { quietOnsetMs } : {}),
      ...stripOnset(this.pending),
      ...(this.pendingChunks > 0 ? { transcriptChunks: this.pendingChunks } : {}),
    };
    this.open.authorizationReceivedMs = atMs;
    this.openedAtMs = atMs;
    this.pending = {};
    this.pendingChunks = 0;
    return true;
  }

  /** The path changed after authorization — a cache miss fell back to the model. */
  setSource(source: SpeechSource): void {
    if (this.open) this.open.source = source;
  }

  /** Store server-measured deltas from the ACTION message. */
  setServerTiming(decisionMs: number | undefined, classifierMs: number | undefined, classifierSource?: string): void {
    if (!this.open) return;
    if (decisionMs !== undefined) this.open.serverDecisionMs = decisionMs;
    if (classifierMs !== undefined) this.open.classifierMs = classifierMs;
    if (classifierSource) this.open.classifierSource = classifierSource;
  }

  /**
   * The first sample reached the speaker. The metric's end mark; the ledger
   * stays open until the utterance's outcome is known.
   */
  firstSamplePlayed(atMs: number): void {
    if (this.open && this.open.firstSamplePlayedMs === undefined) {
      this.open.firstSamplePlayedMs = atMs;
    }
  }

  /** A relayed tool call finished (or failed) during this utterance. */
  toolCall(ms: number, ok: boolean): void {
    if (!this.open) return;
    this.open.toolMs = (this.open.toolMs ?? 0) + Math.max(0, ms);
    this.open.toolCalls = (this.open.toolCalls ?? 0) + 1;
    if (!ok) this.open.toolFailures = (this.open.toolFailures ?? 0) + 1;
  }

  /**
   * The utterance ended. This closes and reports the ledger, whatever the
   * outcome — a failed or interrupted turn is evidence, not noise. Analysis
   * separates them by `outcome`; `responseLatencyMs` stays null for a turn
   * that never played a sample.
   */
  terminal(report: LedgerTerminal, atMs: number): void {
    const ledger = this.open;
    if (!ledger) return;
    this.open = null;
    ledger.outcome = report.outcome;
    if (report.reason) ledger.outcomeReason = report.reason.slice(0, 64);
    ledger.terminalMs = atMs;
    ledger.underruns = report.underruns;
    ledger.receivedAudioMs = report.receivedAudioMs;
    ledger.playedAudioMs = report.playedAudioMs;
    this.opts.onComplete(ledger);
  }

  /** Drop the open ledger without reporting it. */
  abandon(): void {
    this.open = null;
  }

  private expire(atMs: number): void {
    if (this.open && atMs - this.openedAtMs > this.staleAfterMs) this.open = null;
  }
}

function stripOnset(
  marks: Partial<Record<LatencyMark, number>>,
): Omit<Partial<Record<LatencyMark, number>>, "quietOnsetMs"> {
  const rest: Partial<Record<LatencyMark, number>> = { ...marks };
  delete rest.quietOnsetMs;
  return rest;
}

/**
 * The three largest terms in a ledger, named.
 *
 * §6.1's acceptance criterion is "a full ledger for every utterance, and the
 * three largest terms are named" — so naming them is code rather than a thing
 * someone does by eye in a spreadsheet afterwards.
 */
export function largestStages(ledger: LatencyLedger, count = 3): Array<{ stage: string; ms: number }> {
  const order: LatencyMark[] = [
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
  ];

  const present = order
    .map((mark) => ({ mark, at: ledger[mark] }))
    .filter((entry): entry is { mark: LatencyMark; at: number } => typeof entry.at === "number");

  const stages: Array<{ stage: string; ms: number }> = [];
  for (let i = 1; i < present.length; i += 1) {
    const from = present[i - 1];
    const to = present[i];
    if (!from || !to) continue;
    stages.push({ stage: `${from.mark} → ${to.mark}`, ms: to.at - from.at });
  }

  return stages.sort((a, b) => b.ms - a.ms).slice(0, count);
}

/** The product metric, or null when the utterance was never heard. */
export function responseLatencyMs(ledger: LatencyLedger): number | null {
  if (ledger.firstSamplePlayedMs === undefined || ledger.quietOnsetMs === undefined) return null;
  return ledger.firstSamplePlayedMs - ledger.quietOnsetMs;
}

/** Authorization received to first audible sample: excludes endpointing and the gate. */
export function authorizationLatencyMs(ledger: LatencyLedger): number | null {
  if (ledger.firstSamplePlayedMs === undefined || ledger.authorizationReceivedMs === undefined) return null;
  return ledger.firstSamplePlayedMs - ledger.authorizationReceivedMs;
}
