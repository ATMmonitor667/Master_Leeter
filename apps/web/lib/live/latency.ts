/**
 * Per-turn latency: the end of the candidate's speech to the first interviewer
 * audio (R8). "End of speech" is the last microphone frame loud enough to be
 * speech, measured in this browser, so both marks share one clock.
 *
 * Shown in the dev overlay (?debug=1) and uploaded for the report's dev view.
 */
export interface LatencyStats { last: number | null; p50: number | null; p95: number | null; turns: number }

export class LatencyTracker {
  private readonly samples: number[] = [];
  private awaiting = false;

  /** The candidate spoke; the next interviewer audio answers them. */
  candidateSpoke(): void { this.awaiting = true; }

  /** First audio of an interviewer turn. Returns the latency when it answered speech. */
  firstAudio(lastVoiceAt: number, now = performance.now()): number | null {
    if (!this.awaiting || !lastVoiceAt) return null;
    this.awaiting = false;
    const ms = Math.round(now - lastVoiceAt);
    // A reply to a text cue, or audio long after speech, is not a turn latency.
    if (ms < 0 || ms > 15_000) return null;
    this.samples.push(ms);
    return ms;
  }

  stats(): LatencyStats {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const at = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : null);
    return { last: this.samples.at(-1) ?? null, p50: at(0.5), p95: at(0.95), turns: sorted.length };
  }
}
