"use client";

export type InterviewerState = "LISTENING" | "WAITING" | "SPEAKING";

const COPY: Record<InterviewerState, { label: string; color: string }> = {
  LISTENING: { label: "Listening", color: "var(--ok)" },
  WAITING: { label: "Waiting", color: "var(--muted)" },
  SPEAKING: { label: "Speaking", color: "var(--accent)" },
};

/**
 * The entire interviewer presence in the UI.
 *
 * Three words and a dot. No avatar, no chat transcript, no scrolling history of
 * what was said — a transcript would turn a listening exercise back into a
 * reading one, which is the thing this product exists not to be.
 *
 * It also shows nothing about what the interviewer is *thinking*. Exposing
 * "considering a probe" would let the candidate play the gate instead of the
 * interview.
 */
export function InterviewerStatus({ state }: { state: InterviewerState }) {
  const { label, color } = COPY[state];

  return (
    <div
      aria-live="polite"
      aria-label={`Interviewer ${label}`}
      className="interviewer-status"
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: color,
          // Only the speaking state animates. A pulsing dot while the candidate
          // is thinking reads as impatience.
          animation: state === "SPEAKING" ? "pulse 1.2s ease-in-out infinite" : undefined,
        }}
      />
      <span>{label}</span>
    </div>
  );
}
