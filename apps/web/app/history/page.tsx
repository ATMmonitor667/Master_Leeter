"use client";

import { useCallback, useEffect, useState } from "react";
import { AccountMenu } from "../../components/AccountMenu";
import { apiFetch, SignInRequired } from "../../lib/auth";

interface SessionSummary {
  sessionId: string;
  mode: "LEARNING" | "MOCK" | "STRICT";
  state: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  expectedSeconds: number;
  remainingSeconds: number;
}

interface SessionPage {
  sessions: SessionSummary[];
  nextCursor: string | null;
}

export default function HistoryPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (next?: string) => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: "20", ...(next ? { cursor: next } : {}) });
      const response = await apiFetch(`/v1/interview-sessions?${query}`);
      if (!response.ok) throw new Error(`History is unavailable (${response.status}).`);
      const page = await response.json() as SessionPage;
      setSessions((current) => next ? [...current, ...page.sessions] : page.sessions);
      setCursor(page.nextCursor);
    } catch (cause) {
      if (cause instanceof SignInRequired) {
        window.location.replace("/login?next=%2Fhistory");
        return;
      }
      setError(cause instanceof Error ? cause.message : "History is unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return <main className="history-shell">
    <nav className="history-nav">
      <a href="/" className="brand"><span className="brand-mark">ML</span><span className="brand-name">Master Leeter</span></a>
      <AccountMenu />
    </nav>
    <header className="history-heading">
      <div><div className="eyebrow">Your practice record</div><h1>Interview history</h1></div>
      <a className="primary-button" href="/#start">New interview <span>→</span></a>
    </header>

    {error && <div className="error-banner" role="alert">{error}</div>}
    {!loading && sessions.length === 0 && !error && <section className="history-empty">
      <h2>No interviews yet.</h2>
      <p>Your active and completed interviews will appear here.</p>
      <a className="secondary-button" href="/#start">Configure your first interview</a>
    </section>}

    <section className="history-list" aria-busy={loading} aria-label="Interview history">
      {sessions.map((session) => {
        const completed = Boolean(session.endedAt);
        const destination = completed ? `/report/${session.sessionId}` : `/interview/${session.sessionId}`;
        return <article className="history-card" key={session.sessionId}>
          <div>
            <span className={`history-status ${completed ? "complete" : "active"}`}>{completed ? "Completed" : "In progress"}</span>
            <h2>{session.mode[0] + session.mode.slice(1).toLowerCase()} interview</h2>
            <p>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(session.createdAt))}</p>
          </div>
          <div className="history-meta">
            <span>{completed ? "Report ready or processing" : `${Math.ceil(session.remainingSeconds / 60)} min remaining`}</span>
            <span className="meta-mono">{session.sessionId.slice(0, 8).toUpperCase()}</span>
          </div>
          <a className="secondary-button" href={destination}>{completed ? "View report" : "Resume"} <span>→</span></a>
        </article>;
      })}
      {loading && <div className="history-loading" role="status">Loading interview history…</div>}
    </section>
    {cursor && !loading && <button className="secondary-button history-more" onClick={() => void load(cursor)}>Load older interviews</button>}
  </main>;
}
