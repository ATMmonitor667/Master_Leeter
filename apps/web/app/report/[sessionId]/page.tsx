"use client";

import { use, useCallback, useEffect, useState } from "react";
import { DimensionCard } from "../../../components/DimensionCard";
import type { SessionReport } from "../../../lib/report";

/**
 * Post-session report (M6-3).
 *
 * Shown only after the live round is over. Detailed coaching during the
 * interview would contaminate the thing being measured, which is why the
 * interviewer wraps up without feedback and this page exists separately.
 *
 * Two presentation rules the design report is firm about:
 *
 *   - Every score shows its evidence, expanded, not hidden behind a click.
 *   - Nothing here infers personality, aptitude, or employability. The rubric
 *     scores observable interview behaviour, and the copy says so plainly.
 */

const API = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:4000";
const POLL_MS = 1500;

type State =
  | { kind: "loading" }
  | { kind: "pending"; status: string }
  | { kind: "ready"; report: SessionReport }
  | { kind: "error"; message: string };

export default function ReportPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);
  const [state, setState] = useState<State>({ kind: "loading" });

  const fetchReport = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`${API}/v1/interview-sessions/${sessionId}/report`);

      if (res.status === 202) {
        const body = await res.json();
        setState({ kind: "pending", status: body.status ?? "QUEUED" });
        return false;
      }
      if (res.status === 404) {
        setState({ kind: "error", message: "This session has not been evaluated yet." });
        return true;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setState({ kind: "error", message: body.error ?? `Report failed (${res.status})` });
        return true;
      }

      const body = await res.json();
      setState({ kind: "ready", report: body.report });
      return true;
    } catch {
      setState({ kind: "error", message: "Could not reach the API." });
      return true;
    }
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;

    // Evaluation is a queue job, so the endpoint answers 202 until it lands.
    // Poll rather than treating in-flight as an error.
    const tick = async () => {
      if (cancelled) return;
      const done = await fetchReport();
      if (!done && !cancelled) setTimeout(tick, POLL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
    };
  }, [fetchReport]);

  if (state.kind === "loading" || state.kind === "pending") {
    return (
      <Shell>
        <p style={{ color: "var(--muted)" }}>
          {state.kind === "pending" && state.status === "RUNNING"
            ? "Working through the session…"
            : "Preparing your report…"}
        </p>
      </Shell>
    );
  }

  if (state.kind === "error") {
    return (
      <Shell>
        <p style={{ color: "var(--err)" }}>{state.message}</p>
      </Shell>
    );
  }

  const { report } = state;
  const startedAt = report.dimensions.flatMap((d) => d.evidence).at(0)?.occurredAt ?? report.generatedAt;

  return (
    <Shell>
      <header style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Interview report</h1>
        <p style={{ color: "var(--muted)", margin: "8px 0 0", lineHeight: 1.6 }}>
          Scored against a practice rubric on what was observable in the session — what you asked,
          wrote, ran and said. It is not a prediction of how any employer would decide.
        </p>

        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 14,
            marginTop: 18,
            padding: "14px 18px",
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "var(--panel)",
          }}
        >
          <span style={{ fontFamily: "var(--mono)", fontSize: 26 }}>{report.overall.toFixed(2)}</span>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>
            weighted across {report.dimensions.length} dimensions
          </span>
          <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 12 }}>
            {report.rubricId} v{report.rubricVersion}
          </span>
        </div>
      </header>

      <div style={{ display: "grid", gap: 12 }}>
        {report.dimensions.map((d) => (
          <DimensionCard key={d.dimension} dimension={d} startedAt={startedAt} />
        ))}
      </div>

      {(report.hintsUsed.length > 0 || report.probesAsked.length > 0) && (
        <Panel title="Interviewer activity">
          <p style={{ margin: 0, color: "var(--muted)" }}>
            {report.probesAsked.length} probe{report.probesAsked.length === 1 ? "" : "s"} ·{" "}
            {report.hintsUsed.length === 0
              ? "no hints used"
              : `hints used: ${report.hintsUsed.map((l) => `L${l}`).join(", ")}`}
          </p>
        </Panel>
      )}

      {report.missedOpportunities.length > 0 && (
        <Panel title="Missed opportunities">
          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
            {report.missedOpportunities.map((m) => (
              <li key={m} style={{ color: "var(--muted)" }}>
                {m}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="Practice next">
        <dl style={{ margin: 0, display: "grid", gap: 12 }}>
          {(
            [
              ["Communication", report.drills.communication],
              ["Algorithmic", report.drills.algorithmic],
              ["Testing", report.drills.testing],
            ] as const
          ).map(([label, drill]) => (
            <div key={label}>
              <dt style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)" }}>
                {label}
              </dt>
              <dd style={{ margin: "4px 0 0" }}>{drill}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main style={{ maxWidth: 800, margin: "0 auto", padding: "56px 24px 96px" }}>{children}</main>;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        marginTop: 12,
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: 16,
        background: "var(--panel)",
      }}
    >
      <h2 style={{ fontSize: 13, margin: "0 0 10px", letterSpacing: "0.02em" }}>{title}</h2>
      {children}
    </section>
  );
}
