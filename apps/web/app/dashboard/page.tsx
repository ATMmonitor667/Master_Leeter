"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Navigation, Footer } from "../../components/Shell";
import { CorePoster } from "../../components/landing/CognitionCore";
import { Icon, type IconName } from "../../components/ui/Icon";
import { Skeleton } from "../../components/ui/Primitives";
import { apiFetch, SignInRequired } from "../../lib/api-client";
import s from "./Dashboard.module.css";

/**
 * Practice overview. Everything here is computed from the session list the
 * history page already uses. A value that cannot be measured from that list is
 * shown as unknown, never as zero and never as an estimate.
 */

interface SessionSummary {
  sessionId: string;
  format?: "VOICE" | "CHAT";
  style?: "SUPPORTIVE" | "NEUTRAL" | "TOUGH" | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  remainingSeconds: number;
}

const PAGE = 50;
const title = (session: SessionSummary) =>
  `${session.format === "CHAT" ? "Chat" : "Voice"} interview${session.style ? ` · ${session.style.toLowerCase()}` : ""}`;
const when = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

function practiced(sessions: SessionSummary[]): string | null {
  const timed = sessions.filter((session) => session.startedAt && session.endedAt);
  if (timed.length === 0) return null;
  const seconds = timed.reduce((sum, session) =>
    sum + Math.max(0, (Date.parse(session.endedAt ?? "") - Date.parse(session.startedAt ?? "")) / 1000), 0);
  if (seconds < 60) return "< 1 min";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function StatCard({ label, value, explanation, icon, order }: {
  label: string; value: string | null; explanation: string; icon: IconName; order: number;
}) {
  return (
    <article className={s.stat} data-card="tilt" data-enter={order}>
      <span className={s.statLabel}><span className={s.chip} aria-hidden><Icon name={icon} /></span>{label}</span>
      <strong className={s.statValue}>{value ?? "—"}</strong>
      <p>{explanation}</p>
    </article>
  );
}

export default function DashboardPage() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [partial, setPartial] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await apiFetch(`/v1/interview-sessions?limit=${PAGE}`);
      if (!response.ok) throw new Error(`Your sessions are unavailable (${response.status}).`);
      const page = (await response.json()) as { sessions: SessionSummary[]; nextCursor: string | null };
      setSessions(page.sessions);
      setPartial(Boolean(page.nextCursor));
    } catch (cause) {
      if (cause instanceof SignInRequired) { window.location.replace("/login?next=%2Fdashboard"); return; }
      setError(cause instanceof Error ? cause.message : "Your sessions are unavailable.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const loading = sessions === null && !error;
  const list = sessions ?? [];
  const resumable = list.find((session) => !session.endedAt && session.remainingSeconds > 0);
  const completed = list.filter((session) => session.endedAt);
  const scope = partial ? `In your ${list.length} most recent sessions.` : "Across all your sessions.";
  const time = practiced(completed);

  return (
    <section className={s.page}>
      <Navigation />
      <header className={s.heading} data-enter>
        <div>
          <div className="eyebrow">Practice / Overview</div>
          <h1>Ready for your next round?</h1>
        </div>
        <Link className="primary-button" href="/start">New interview <Icon name="arrow" /></Link>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          {error} <button className="secondary-button" onClick={() => void load()}>Retry</button>
        </div>
      )}

      <div className={s.top}>
        <article className={s.next} data-card="signal tilt" data-enter="1" aria-busy={loading}>
          <div className="eyebrow">Your next session</div>
          {loading ? <Skeleton height={72} /> : resumable ? (
            <>
              <h2>Continue your interview</h2>
              <p>
                <span className={s.dot} aria-hidden /> Resume available · {title(resumable)} · about {Math.ceil(resumable.remainingSeconds / 60)} min remaining
              </p>
              <Link className="primary-button" href={`/interview/${resumable.sessionId}`}>Resume session <Icon name="arrow" /></Link>
            </>
          ) : (
            <>
              <h2>{list.length === 0 && !error ? "Start your first interview" : "Start a new interview"}</h2>
              <p>Choose voice or chat, a problem, an interviewer style and a length. It takes under a minute to set up.</p>
              <Link className="primary-button" href="/start">Configure <Icon name="arrow" /></Link>
            </>
          )}
        </article>
        <div className={s.art} data-card="tilt" data-enter="2"><CorePoster /></div>
      </div>

      <section className={s.stats} aria-label="At a glance">
        <StatCard label="Completed sessions" icon="check" order={2}
          value={sessions ? (partial ? `${completed.length}+` : String(completed.length)) : null}
          explanation={sessions ? (partial ? `Counted in your ${list.length} most recent sessions; older ones are in History.` : "Interviews you finished.") : "Not loaded yet."} />
        <StatCard label="Time practiced" icon="clock" order={3} value={sessions ? time : null}
          explanation={sessions ? (time ? `Measured from start to end of completed interviews. ${scope}` : "Appears once you complete an interview.") : "Not loaded yet."} />
        <StatCard label="Next focus" icon="notes" order={4} value={null}
          explanation="Suggested drills are not built yet. Open a report to see what to practise next." />
      </section>

      <section className={s.recent} data-card="quiet" data-enter="5" aria-label="Recent practice">
        <header>
          <h2>Recent practice</h2>
          <Link href="/history">View all <Icon name="arrow" /></Link>
        </header>
        {loading && <><Skeleton /><Skeleton /><Skeleton /></>}
        {sessions && list.length === 0 && (
          <p className={s.empty}>No interviews yet. Your active and completed interviews will appear here.</p>
        )}
        {list.slice(0, 5).map((session) => {
          const done = Boolean(session.endedAt);
          return (
            <article key={session.sessionId} className={s.row}>
              <span className={s.mode} aria-hidden><Icon name={session.format === "CHAT" ? "notes" : "mic"} /></span>
              <div>
                <strong>{title(session)}</strong>
                <span>{when(session.createdAt)}</span>
              </div>
              <span className={s.status} data-done={done}>{done ? "Completed" : "In progress"}</span>
              <Link className="secondary-button" href={done ? `/report/${session.sessionId}` : `/interview/${session.sessionId}`}>
                {done ? (session.format === "CHAT" ? "View conversation" : "View report") : "Resume"} <Icon name="arrow" />
              </Link>
            </article>
          );
        })}
      </section>

      <p className={s.utility}>
        <Link href="/start">Check your microphone</Link> · <Link href="/history">Export or delete sessions</Link> · <Link href="/privacy">Privacy</Link>
      </p>
      <Footer />
    </section>
  );
}
