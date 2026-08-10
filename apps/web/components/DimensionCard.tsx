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
    <section
      style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: 16,
        background: "var(--panel)",
      }}
    >
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>
          {DIMENSION_LABELS[dimension.dimension] ?? dimension.dimension}
        </h3>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 18 }}>
            {dimension.score.toFixed(1)}
          </span>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>{scoreLabel(dimension.score)}</span>
          <span style={{ color: TONE_COLOR[confidence.tone], fontSize: 11 }}>· {confidence.text}</span>
        </div>
      </header>

      <p style={{ color: "var(--muted)", margin: "10px 0 0", lineHeight: 1.55 }}>{dimension.rationale}</p>

      {dimension.evidence.length > 0 ? (
        <ul style={{ listStyle: "none", padding: 0, margin: "14px 0 0", display: "grid", gap: 8 }}>
          {dimension.evidence.map((moment) => (
            <li
              key={`${moment.seq}-${moment.evidenceHash}`}
              style={{
                display: "grid",
                gridTemplateColumns: "48px 1fr",
                gap: 10,
                fontSize: 13,
                padding: "8px 10px",
                background: "var(--bg)",
                borderRadius: 6,
                border: "1px solid var(--border)",
              }}
            >
              <span style={{ fontFamily: "var(--mono)", color: "var(--muted)" }}>
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
