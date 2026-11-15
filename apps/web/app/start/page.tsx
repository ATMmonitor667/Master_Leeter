"use client";

import { useEffect, useRef, useState } from "react";
import { Navigation } from "../../components/Shell";
import { Button } from "../../components/ui/Primitives";
import { apiFetch, SignInRequired } from "../../lib/api-client";
import { apiUrl } from "../../lib/public-config";
import styles from "./Setup.module.css";

/**
 * Setup: one screen, one Start.
 *
 * Mode, problem, interviewer style, length, and an optional resume. The problem
 * is rewritten into a fresh story when the session is created, so the catalogue
 * shows only difficulty and topics.
 */

type Format = "VOICE" | "CHAT";
type Style = "SUPPORTIVE" | "NEUTRAL" | "TOUGH";
type Difficulty = "ANY" | "EASY" | "MEDIUM" | "HARD";
interface Catalogue { problems: Array<{ ref: string; difficulty: string; topics: string[] }>; pasteAvailable: boolean }
interface Fact { id: string; category: string; claim: string }
interface Preparation { id: string; status: string; analysis: { facts: Fact[] } | null }

const STYLES: Array<{ id: Style; title: string; text: string }> = [
  { id: "SUPPORTIVE", title: "Supportive", text: "Confirms direction, nudges sooner. 3 hints." },
  { id: "NEUTRAL", title: "Neutral", text: "Even and professional, like most real interviews. 2 hints." },
  { id: "TOUGH", title: "Tough", text: "Terse, pushes on weak reasoning. 1 hint." },
];

function Choice<T extends string | number>({ name, value, current, onChange, title, text }: {
  name: string; value: T; current: T; onChange: (value: T) => void; title: string; text?: string;
}) {
  return (
    <label className={styles.choice} data-checked={current === value}>
      <input type="radio" name={name} checked={current === value} onChange={() => onChange(value)} />
      <strong>{title}</strong>
      {text && <span>{text}</span>}
    </label>
  );
}

export default function SetupPage() {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [format, setFormat] = useState<Format>("VOICE");
  const [style, setStyle] = useState<Style>("NEUTRAL");
  const [minutes, setMinutes] = useState<30 | 45 | 60>(45);
  const [source, setSource] = useState<"BANK" | "PASTE">("BANK");
  const [difficulty, setDifficulty] = useState<Difficulty>("ANY");
  const [pasted, setPasted] = useState("");
  const [resumeText, setResumeText] = useState("");
  const [consent, setConsent] = useState(false);
  const [preparation, setPreparation] = useState<Preparation | null>(null);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [analyzing, setAnalyzing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const key = useRef<string | null>(null);

  useEffect(() => {
    fetch(apiUrl("/v1/problems"), { redirect: "error" })
      .then((response) => { if (!response.ok) throw new Error(); return response.json(); })
      .then((data: Catalogue) => setCatalogue(data))
      .catch(() => setError("Could not reach the interview service. Start the API, then reload."));
    try {
      const saved = JSON.parse(localStorage.getItem("ml-setup") ?? "{}") as { format?: Format; style?: Style; minutes?: 30 | 45 | 60 };
      if (saved.format === "VOICE" || saved.format === "CHAT") setFormat(saved.format);
      if (saved.style && STYLES.some((item) => item.id === saved.style)) setStyle(saved.style);
      if (saved.minutes && [30, 45, 60].includes(saved.minutes)) setMinutes(saved.minutes);
    } catch { /* defaults */ }
  }, []);

  const handle = (cause: unknown, fallback: string) => {
    if (cause instanceof SignInRequired) { window.location.assign("/login?next=/start"); return; }
    setError(cause instanceof Error && cause.message ? cause.message : fallback);
  };

  async function analyzeResume() {
    setAnalyzing(true); setError(null);
    try {
      const response = await apiFetch("/v1/preparations", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ resumeText, consent: true }),
      });
      if (!response.ok) throw new Error("The resume could not be analysed. You can start without it.");
      const next = (await response.json()) as Preparation;
      setPreparation(next);
      setConfirmed(new Set());
    } catch (cause) { handle(cause, "The resume could not be analysed. You can start without it."); }
    finally { setAnalyzing(false); }
  }

  async function start() {
    setStarting(true); setError(null); setActive(null);
    try {
      let preparationId: string | undefined;
      if (preparation && confirmed.size) {
        const response = await apiFetch(`/v1/preparations/${preparation.id}/facts`, {
          method: "PATCH", headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmedFactIds: [...confirmed] }),
        });
        if (response.ok) preparationId = preparation.id;
      }
      key.current ??= crypto.randomUUID();
      const response = await apiFetch("/v1/interview-sessions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key.current },
        body: JSON.stringify({
          format, style, minutes,
          ...(source === "PASTE" ? { pastedProblem: pasted.trim() } : difficulty !== "ANY" ? { difficulty } : {}),
          ...(preparationId ? { preparationId } : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { sessionId?: string; error?: string; message?: string; activeSessionId?: string };
      if (!response.ok || !body.sessionId) {
        key.current = null;
        if (body.error === "ACTIVE_SESSION_EXISTS" && body.activeSessionId) setActive(body.activeSessionId);
        throw new Error(body.message ?? "The interview could not be created. Please retry.");
      }
      try { localStorage.setItem("ml-setup", JSON.stringify({ format, style, minutes })); } catch { /* not persisted */ }
      window.location.assign(`/interview/${body.sessionId}`);
    } catch (cause) {
      handle(cause, "The interview could not be created. Please retry.");
      setStarting(false);
    }
  }

  async function endActive() {
    if (!active) return;
    setStarting(true);
    try {
      await apiFetch(`/v1/interview-sessions/${active}/end`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      setActive(null); setError(null);
      await start();
    } catch (cause) { handle(cause, "That interview could not be ended."); setStarting(false); }
  }

  const pasteReady = source !== "PASTE" || pasted.trim().length >= 40;
  const counts = catalogue ? (["EASY", "MEDIUM", "HARD"] as const).map((d) => [d, catalogue.problems.filter((p) => p.difficulty === d).length] as const) : [];

  return (
    <>
      <Navigation />
      <div className={styles.page}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>New interview</p>
          <h1>Set up the room</h1>
          <p>You talk through a coding problem with an AI interviewer, write Python, and get an evidence-based report afterwards.</p>
        </header>

        <section className={styles.section} aria-labelledby="mode">
          <h2 id="mode">Mode</h2>
          <div className={styles.grid2}>
            <Choice name="format" value="VOICE" current={format} onChange={setFormat} title="Voice" text="Speak with the interviewer, like a real onsite. Needs a microphone." />
            <Choice name="format" value="CHAT" current={format} onChange={setFormat} title="Chat" text="Type with the interviewer. Same interviewer, no microphone." />
          </div>
        </section>

        <section className={styles.section} aria-labelledby="problem">
          <h2 id="problem">Problem</h2>
          <div className={styles.grid2}>
            <Choice name="source" value="BANK" current={source} onChange={setSource} title="Surprise me" text="An original problem, retold in a fresh story each time." />
            <Choice name="source" value="PASTE" current={source} onChange={setSource} title="Paste your own" text="Practise a specific problem. Used for this session only." />
          </div>
          {source === "BANK" ? (
            <div className={styles.inline} role="radiogroup" aria-label="Difficulty">
              <Choice name="difficulty" value="ANY" current={difficulty} onChange={setDifficulty} title="Any difficulty" />
              {counts.filter(([, n]) => n > 0).map(([d]) => (
                <Choice key={d} name="difficulty" value={d} current={difficulty} onChange={setDifficulty} title={d[0] + d.slice(1).toLowerCase()} />
              ))}
            </div>
          ) : (
            <label className={styles.field}>
              <span>Problem statement, with at least one example</span>
              <textarea value={pasted} onChange={(event) => setPasted(event.target.value)} rows={7} maxLength={12_000}
                placeholder="Paste the full problem here. It is rewritten into a new story, and only its examples are used as tests."
                disabled={catalogue ? !catalogue.pasteAvailable : false} />
              {catalogue && !catalogue.pasteAvailable && <small>Pasting needs the text model, which is not configured on the server.</small>}
            </label>
          )}
        </section>

        <section className={styles.section} aria-labelledby="style">
          <h2 id="style">Interviewer style</h2>
          <div className={styles.grid3}>
            {STYLES.map((item) => <Choice key={item.id} name="style" value={item.id} current={style} onChange={setStyle} title={item.title} text={item.text} />)}
          </div>
        </section>

        <section className={styles.section} aria-labelledby="length">
          <h2 id="length">Length</h2>
          <div className={styles.inline}>
            {([30, 45, 60] as const).map((value) => <Choice key={value} name="minutes" value={value} current={minutes} onChange={setMinutes} title={`${value} minutes`} />)}
          </div>
        </section>

        <details className={styles.section}>
          <summary><h2>Resume warm-up <small>optional</small></h2></summary>
          <p className={styles.help}>Paste your resume and the interviewer opens with one question about something you confirm. The text is deleted after 24 hours.</p>
          {!preparation ? (
            <>
              <label className={styles.field}>
                <span>Resume text</span>
                <textarea value={resumeText} onChange={(event) => setResumeText(event.target.value)} rows={5} maxLength={50_000} />
              </label>
              <label className={styles.check}>
                <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
                <span>I agree to this text being processed by the AI model to prepare my interview.</span>
              </label>
              <Button onClick={() => void analyzeResume()} loading={analyzing} disabled={!consent || resumeText.trim().length < 40}>Find talking points</Button>
            </>
          ) : (
            <fieldset className={styles.facts}>
              <legend>Tick what is true and fair to ask about</legend>
              {(preparation.analysis?.facts ?? []).slice(0, 12).map((fact) => (
                <label key={fact.id} className={styles.check}>
                  <input type="checkbox" checked={confirmed.has(fact.id)} onChange={(event) => {
                    const next = new Set(confirmed);
                    if (event.target.checked) next.add(fact.id); else next.delete(fact.id);
                    setConfirmed(next);
                  }} />
                  <span>{fact.claim}</span>
                </label>
              ))}
              {!preparation.analysis?.facts.length && <p className={styles.help}>No talking points were found. The interview will start with the problem.</p>}
            </fieldset>
          )}
        </details>

        <footer className={styles.footer}>
          {error && (
            <p role="alert" className={styles.error}>
              {error}
              {active && (
                <span className={styles.activeActions}>
                  <a href={`/interview/${active}`}>Resume it</a>
                  <button type="button" onClick={() => void endActive()}>End it and start this one</button>
                </span>
              )}
            </p>
          )}
          <Button variant="primary" size="lg" loading={starting} disabled={!catalogue || !pasteReady} onClick={() => void start()}>
            {starting ? "Preparing your problem…" : "Enter the room"}
          </Button>
          <small>{starting ? "Writing a fresh version of the problem. This takes a few seconds." : format === "VOICE" ? "You connect your microphone in the room; the clock starts when you press Start there." : "The clock starts when you press Start in the room."}</small>
        </footer>
      </div>
    </>
  );
}
