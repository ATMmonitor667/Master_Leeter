"use client";

import {
  DIMENSION_LABELS,
  MOMENT_LABELS,
  type DimensionScore,
  confidenceLabel,
  relativeTime,
  scoreLabel,
} from "../lib/report";

const TONE_COLOR = {
  high: "var(--ok)",
  medium: "var(--warn)",
  low: "var(--muted)",
} as const;

/**
 * One rubric dimension, with the evidence behind it.
 *
 * The evidence is not a footnote or a disclosure triangle — it sits directly
 * under the score, always expanded. A report whose justification is one click
 * away is a report people read as a verdict, and this product's whole claim is
 * that its scores are auditable.
 *
 * Confidence is rendered as words next to the score rather than a number
 * somewhere else, because "2.5, little evidence" and "2.5, well evidenced" are
 * different claims and should not look alike.
 */
export function DimensionCard({
  dimension,
  startedAt,
}: {
  dimension: DimensionScore;
  startedAt: string;
}) {
  const confidence = confidenceLabel(dimension.confidence);

  return (
    <section className="dimension-card">
      <header className="dimension-header">
        <h3>
          {DIMENSION_LABELS[dimension.dimension] ?? dimension.dimension}
        </h3>
        <div className="dimension-score">
          <span style={{ fontFamily: "var(--mono)", fontSize: 18 }}>
            {dimension.score.toFixed(1)}
          </span>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>{scoreLabel(dimension.score)}</span>
          <span style={{ color: TONE_COLOR[confidence.tone], fontSize: 11 }}>· {confidence.text}</span>
        </div>
      </header>

      <p style={{ color: "var(--muted)", margin: "10px 0 0", lineHeight: 1.55 }}>{dimension.rationale}</p>

      {dimension.evidence.length > 0 ? (
        <ul className="evidence-list">
          {dimension.evidence.map((moment) => (
            <li
              key={`${moment.seq}-${moment.evidenceHash}`}
              className="evidence-row"
            >
              <span className="evidence-time">
                {relativeTime(moment.occurredAt, startedAt)}
              </span>
              <span>
                <span style={{ color: "var(--muted)" }}>
                  {MOMENT_LABELS[moment.kind] ?? moment.kind}
                  {moment.codeRevision !== undefined ? ` · rev ${moment.codeRevision}` : ""}
                  {" — "}
                </span>
                {moment.summary}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ color: "var(--muted)", fontSize: 12, marginTop: 12, fontStyle: "italic" }}>
          {/* Saying so is more honest than an empty section that looks like a
              rendering bug. */}
          No evidence was captured for this dimension, so the score above is a weak signal.
        </p>
      )}
    </section>
  );
}
