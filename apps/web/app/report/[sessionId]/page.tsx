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
        <div className="report-state"><div><div className="report-spinner" />
          <p>{state.kind === "pending" && state.status === "RUNNING"
              ? "Working through the session…"
              : "Preparing your report…"}</p>
        </div></div>
      </Shell>
    );
  }

  if (state.kind === "error") {
    return (
      <Shell>
        <div className="report-state" style={{ color: "var(--err)" }}>{state.message}</div>
      </Shell>
    );
  }

  const { report } = state;
  const startedAt = report.dimensions.flatMap((d) => d.evidence).at(0)?.occurredAt ?? report.generatedAt;
  const ranked = [...report.dimensions].sort((a, b) => b.score - a.score);
  const strongest = ranked[0];
  const focus = ranked.at(-1);

  return (
    <Shell>
      <nav className="report-nav">
        <div className="brand"><span className="brand-mark">ML</span><span className="brand-name">Master Leeter</span></div>
        <button className="secondary-button" onClick={() => { window.location.href = "/"; }}>New interview</button>
      </nav>

      <header className="report-hero">
        <div>
          <div className="eyebrow">Session debrief</div>
          <h1>Your interview, with receipts.</h1>
          <p>
            This report scores observable practice behavior—what you asked, wrote, ran, and said.
            It is evidence for your next practice session, not a prediction of an employer&apos;s decision.
          </p>
        </div>
        <div className="score-orb" aria-label={`Overall score ${report.overall.toFixed(2)}`}>
          <div><div className="score-value">{report.overall.toFixed(2)}</div><div className="score-label">Overall</div></div>
        </div>
      </header>

      <div className="report-meta">
        <span>{report.dimensions.length} rubric dimensions</span>
        <span>{report.probesAsked.length} interviewer probes</span>
        <span>{report.rubricId} · v{report.rubricVersion}</span>
      </div>

      <section className="report-highlights" aria-label="Session highlights">
        <div className="highlight-card positive">
          <span className="highlight-label">Strongest signal</span>
          <strong>{strongest?.dimension.replaceAll("_", " ") ?? "Not enough evidence"}</strong>
          <span>{strongest ? `${strongest.score.toFixed(1)} / 5` : "—"}</span>
        </div>
        <div className="highlight-card focus">
          <span className="highlight-label">Best next focus</span>
          <strong>{focus?.dimension.replaceAll("_", " ") ?? "Gather more evidence"}</strong>
          <span>{focus ? `${focus.score.toFixed(1)} / 5` : "—"}</span>
        </div>
        <div className="highlight-card neutral">
          <span className="highlight-label">Interview footprint</span>
          <strong>{report.probesAsked.length + report.hintsUsed.length} interventions</strong>
          <span>{report.hintsUsed.length === 0 ? "Solved without hints" : `${report.hintsUsed.length} hints used`}</span>
        </div>
      </section>

      <div className="dimension-grid">
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
        <dl className="drill-grid" style={{ margin: 0 }}>
          {(
            [
              ["Communication", report.drills.communication],
              ["Algorithmic", report.drills.algorithmic],
              ["Testing", report.drills.testing],
            ] as const
          ).map(([label, drill]) => (
            <div key={label} className="drill">
              <dt>{label}</dt>
              <dd>{drill}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="report-shell">{children}</main>;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="report-panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
