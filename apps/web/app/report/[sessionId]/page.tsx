"use client";
import styles from "../../Screens.module.css";
import { Navigation, Footer } from "../../../components/Shell";
import { relativeTime } from "../../../lib/report";

import { use, useCallback, useEffect, useState } from "react";
import { DimensionCard } from "../../../components/DimensionCard";
import type { IndependentGrade, SessionReport } from "../../../lib/report";
import { apiFetch } from "../../../lib/api-client";

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

const POLL_MS = 1500;

type State =
  | { kind: "loading" }
  | { kind: "pending"; status: string }
  | { kind: "ready"; report: SessionReport }
  | { kind: "error"; message: string };

export default function ReportPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = use(params);
  const [state, setState] = useState<State>({ kind: "loading" });

  const fetchReport = useCallback(async (): Promise<boolean> => {
    try {
      const res = await apiFetch(`/v1/interview-sessions/${sessionId}/report`);

      if (res.status === 202) {
        const body = await res.json();
        setState({ kind: "pending", status: body.status ?? "QUEUED" });
        return false;
      }
      if (res.status === 404) {
        setState({
          kind: "error",
          message: "This session has not been evaluated yet.",
        });
        return true;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setState({
          kind: "error",
          message: body.error ?? `Report failed (${res.status})`,
        });
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
        <div className="report-state">
          <div>
            <div className="report-spinner" />
            <h1>
              {state.kind === "pending" && state.status === "RUNNING"
                ? "Working through the session…"
                : "Preparing your report…"}
            </h1>
            <p>
              You can leave this page and return from History when the report is
              ready.
            </p>
            <a className="secondary-button" href="/history">
              Open history
            </a>
          </div>
        </div>
      </Shell>
    );
  }

  if (state.kind === "error") {
    return (
      <Shell>
        <div className="report-state report-state-error">
          <h1>Your report is unavailable.</h1>
          <p role="alert">{state.message}</p>
          <button className="primary-button" onClick={() => void fetchReport()}>
            Retry report
          </button>{" "}
          <a className="secondary-button" href="/history">
            Open history
          </a>
        </div>
      </Shell>
    );
  }

  const { report } = state;
  const startedAt =
    report.dimensions
      .flatMap((d) => d.evidence)
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
      .at(0)?.occurredAt ??
    report.generatedAt;
  const ranked = [...report.dimensions].sort((a, b) => b.score - a.score);
  const strongest = ranked[0];
  const focus = ranked.at(-1);

  return (
    <Shell>
      <nav className="report-nav">
        <div className="brand">
          <span className="brand-mark">ML</span>
          <span className="brand-name">Master Leeter</span>
        </div>
        <button
          className="secondary-button"
          onClick={() => {
            window.location.href = "/";
          }}
        >
          New interview
        </button>
      </nav>

      <header className="report-hero">
        {/* Non-interactive on purpose: this sits behind prose. A mesh that
            chases the cursor under text you are trying to read is decoration
            fighting the content. */}

        <div className="report-hero-copy">
          <div className="eyebrow">Session debrief</div>
          <h1>Your interview, with receipts.</h1>
          <p>
            This report estimates observable practice behavior—what you asked,
            wrote, and said. It is evidence for your next practice session, not
            a prediction of an employer&apos;s decision.
          </p>
        </div>
      </header>

      <div className="report-meta">
        <span className="meta-key">SESSION</span>
        <span className="meta-mono">{sessionId.slice(0, 8).toUpperCase()}</span>
        <span className="meta-sep" aria-hidden="true" />
        <span>{report.dimensions.length} rubric dimensions</span>
        <span>{report.probesAsked.length} interviewer probes</span>
        <span className="meta-mono">
          {report.rubricId} · v{report.rubricVersion}
        </span>
      </div>

      <section className="report-highlights" aria-label="Session highlights">
        <div className="highlight-card positive">
          <span className="highlight-label">Strongest signal</span>
          <strong>
            {strongest?.dimension.replaceAll("_", " ") ?? "Not enough evidence"}
          </strong>
          <span>
            {strongest ? `${strongest.score.toFixed(1)} / 4 · estimate` : "—"}
          </span>
        </div>
        <div className="highlight-card focus">
          <span className="highlight-label">Best next focus</span>
          <strong>
            {focus?.dimension.replaceAll("_", " ") ?? "Gather more evidence"}
          </strong>
          <span>
            {focus ? `${focus.score.toFixed(1)} / 4 · estimate` : "—"}
          </span>
        </div>
        <div className="highlight-card neutral">
          <span className="highlight-label">Interview footprint</span>
          <strong>
            {report.probesAsked.length + report.hintsUsed.length} interventions
          </strong>
          <span>
            {report.hintsUsed.length === 0
              ? "No hints recorded"
              : `${report.hintsUsed.length} hints used`}
          </span>
        </div>
      </section>

      <Panel title="What happened">
        <p className="panel-line">
          Captured evidence, in session order. Times are measured from the first
          captured evidence, not the interview start.
        </p>
        <ol className="evidence-timeline">
          {[
            ...new Map(
              report.dimensions
                .flatMap((d) => d.evidence)
                .map((e) => [e.seq, e]),
            ).values(),
          ]
            .sort((a, b) => a.seq - b.seq)
            .map((e) => (
              <li key={e.seq}>
                <span className="evidence-time">
                  {relativeTime(e.occurredAt, startedAt)}
                </span>
                <blockquote>{e.summary}</blockquote>
                <cite>
                  Event {e.seq}
                  {e.codeRevision !== undefined
                    ? ` · code revision ${e.codeRevision}`
                    : ""}
                </cite>
              </li>
            ))}
        </ol>
        {report.dimensions.every((d) => d.evidence.length === 0) && (
          <p>
            No evidence moments are available. Treat estimates as weak signals.
          </p>
        )}
      </Panel>
      <div className="dimension-grid">
        {report.dimensions.map((d) => (
          <DimensionCard
            key={d.dimension}
            dimension={d}
            startedAt={startedAt}
          />
        ))}
      </div>

      {(report.hintsUsed.length > 0 || report.probesAsked.length > 0) && (
        <Panel title="Interviewer activity">
          <p className="panel-line">
            {report.probesAsked.length} probe
            {report.probesAsked.length === 1 ? "" : "s"} ·{" "}
            {report.hintsUsed.length === 0
              ? "no hints used"
              : `hints used: ${report.hintsUsed.map((l) => `L${l}`).join(", ")}`}
          </p>
        </Panel>
      )}

      {report.missedOpportunities.length > 0 && (
        <Panel title="Missed opportunities">
          <ul className="missed-list">
            {report.missedOpportunities.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="Behavior estimate">
        <p className="panel-line">
          {report.overall.toFixed(2)} / 4 · Model estimate of observed behavior.
          Read the evidence above alongside this number.
        </p>
      </Panel>
      {(report.solutionGrade || report.transcriptGrade) && (
        <>
          <p className="grader-note">
            Solution quality and interview reasoning are graded independently
            and are never combined into one score.
          </p>
          <section
            className="grader-grid"
            aria-label="Independent grader results"
          >
            {report.solutionGrade && (
              <GradeCard
                title="Solution quality"
                grade={report.solutionGrade}
              />
            )}
            {report.transcriptGrade && (
              <GradeCard
                title="Interview reasoning"
                grade={report.transcriptGrade}
              />
            )}
          </section>
        </>
      )}

      <Panel title="Practice next">
        <dl className="drill-grid">
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
  return (
    <section className={styles.page}>
      <Navigation />
      <div className="report-shell">{children}</div>
      <Footer />
    </section>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="report-panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function GradeCard({
  title,
  grade,
}: {
  title: string;
  grade: IndependentGrade;
}) {
  return (
    <article className="grader-card">
      <header>
        <div>
          <span className="highlight-label">Independent AI grader</span>
          <h2>{title}</h2>
        </div>
        <div className="grader-score">
          {grade.score === null ? "—" : Math.round(grade.score)}
          <small>/100</small>
        </div>
      </header>
      <p className="grader-note">Model estimate, not an executed test.</p>
      <p>{grade.summary}</p>
      <div className="grader-confidence">
        Confidence {Math.round(grade.confidence * 100)}% ·{" "}
        {grade.status === "SCORED"
          ? "model-estimated"
          : "insufficient evidence"}
      </div>
      <dl className="grader-dimensions">
        {grade.dimensions.map((dimension) => (
          <div key={dimension.key}>
            <dt>{dimension.key.replace(/([A-Z])/g, " $1")}</dt>
            <dd>
              {dimension.score === null ? "—" : Math.round(dimension.score)}
            </dd>
          </div>
        ))}
      </dl>
      {(grade.strengths.length > 0 || grade.improvements.length > 0) && (
        <div className="grader-feedback">
          <div>
            <strong>Supported strengths</strong>
            <ul>
              {grade.strengths.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div>
            <strong>Next improvements</strong>
            <ul>
              {grade.improvements.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {grade.evidence.length > 0 && (
        <ul className="grader-evidence">
          {grade.evidence.map((item) => (
            <li key={`${item.seq}:${item.claim}`}>
              <span>#{item.seq}</span> {item.claim}
              {item.quote ? <q>{item.quote}</q> : null}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
