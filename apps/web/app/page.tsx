"use client";

import { useEffect, useRef, useState } from "react";
import { AccountMenu } from "../components/AccountMenu";
import { apiFetch, SignInRequired } from "../lib/auth";
import { apiUrl } from "../lib/public-config";

/**
 * Session setup.
 *
 * The catalogue shows level, topics, and duration — enough to choose, not enough
 * to prepare. Scenarios are identified by an opaque ref rather than their
 * internal id, because an id like `conveyor-rescan@1` names the problem the
 * candidate is about to hear for the first time.
 */

interface CatalogueEntry {
  ref: string;
  level: string;
  topics: string[];
  expectedMinutes: number;
}

type Tone = "EXTRA_NICE" | "NORMAL" | "MEAN";
interface ResumeFact { id: string; category: "SKILL" | "PROJECT" | "EXPERIENCE"; claim: string; evidence: string }
interface Preparation {
  id: string;
  status: "ANALYZING" | "REVIEW" | "CONFIRMED" | "READY";
  analysis: { summary: string; facts: ResumeFact[] } | null;
  sessionId: string | null;
}

const MODES = ["LEARNING", "MOCK", "STRICT"] as const;
const MODE_COPY: Record<(typeof MODES)[number], string> = {
  LEARNING: "More room for hints and a gentler intervention cadence.",
  MOCK: "A balanced, realistic interview with evidence-based feedback.",
  STRICT: "Minimal help, longer silences, and a higher bar for intervention.",
};
const TONES: Array<{ id: Tone; title: string; description: string }> = [
  { id: "EXTRA_NICE", title: "Extra nice", description: "Patient and reassuring, with the same interview rules." },
  { id: "NORMAL", title: "Normal", description: "Neutral, concise, and professional." },
  { id: "MEAN", title: "Mean", description: "Blunt and demanding, without insults or a scoring penalty." },
];

export default function Home() {
  const [scenarios, setScenarios] = useState<CatalogueEntry[]>([]);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [mode, setMode] = useState<(typeof MODES)[number]>("MOCK");
  const [tone, setTone] = useState<Tone>("NORMAL");
  const [resumeText, setResumeText] = useState("");
  const [consent, setConsent] = useState(false);
  const [preparation, setPreparation] = useState<Preparation | null>(null);
  const [confirmedFacts, setConfirmedFacts] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const preparationKey = useRef<string | null>(null);

  useEffect(() => {
    fetch(apiUrl("/v1/scenarios"), { redirect: "error" })
      .then((r) => r.json())
      .then((d) => {
        const entries = (d.scenarios ?? []) as CatalogueEntry[];
        setScenarios(entries);
        setSelectedRef((current) => current ?? entries[0]?.ref ?? null);
      })
      .catch(() => setError("Could not reach the interview service. Please retry."));
  }, []);

  async function analyzeResume() {
    setStarting(true);
    setError(null);
    try {
      preparationKey.current ??= crypto.randomUUID();
      const res = await apiFetch("/v1/preparations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": preparationKey.current,
        },
        body: JSON.stringify({ resumeText, consent, tone }),
      });
      if (!res.ok) throw new Error(`Resume review failed (${res.status}).`);
      let next = await res.json() as Preparation;
      for (let poll = 0; next.status === "ANALYZING" && poll < 40; poll += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        const latest = await apiFetch(`/v1/preparations/${next.id}`);
        if (!latest.ok) throw new Error("Could not read the resume review.");
        next = await latest.json() as Preparation;
      }
      if (next.status === "ANALYZING") throw new Error("Resume review is still running. Try again shortly.");
      setPreparation(next);
      setConfirmedFacts(new Set(next.analysis?.facts.map((fact) => fact.id) ?? []));
      setStarting(false);
    } catch (err) {
      if (err instanceof SignInRequired) { window.location.assign("/login"); return; }
      setError((err as Error).message);
      setStarting(false);
    }
  }

  async function startPrepared(scenarioRef: string) {
    if (!preparation) return;
    setStarting(true);
    setError(null);
    try {
      const reviewed = await apiFetch(`/v1/preparations/${preparation.id}/facts`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmedFactIds: [...confirmedFacts] }),
      });
      if (!reviewed.ok) throw new Error(`Resume confirmation failed (${reviewed.status}).`);
      const completed = await apiFetch(`/v1/preparations/${preparation.id}/complete`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenarioRef, mode, language: "python" }),
      });
      if (!completed.ok) throw new Error(`Interview preparation failed (${completed.status}).`);
      const result = await completed.json() as Preparation;
      if (!result.sessionId) throw new Error("Interview session was not created.");
      window.location.href = `/interview/${result.sessionId}`;
    } catch (err) {
      if (err instanceof SignInRequired) { window.location.assign("/login"); return; }
      setError((err as Error).message);
      setStarting(false);
    }
  }

  async function eraseResume() {
    if (!preparation) return;
    const res = await apiFetch(`/v1/preparations/${preparation.id}/resume`, { method: "DELETE" });
    if (!res.ok) { setError("Could not erase the resume text."); return; }
    setResumeText("");
  }

  const selected = scenarios.find((scenario) => scenario.ref === selectedRef) ?? null;

  return (
    <main className="landing-shell">
      <nav className="landing-nav" aria-label="Product">
        <div className="brand"><span className="brand-mark">ML</span><span className="brand-name">Master Leeter</span></div>
        <span className="pill"><span className="status-dot" /> Voice-first technical practice</span>
        <AccountMenu />
      </nav>

      <section className="landing-hero">
        <div className="landing-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> Practice the room, not the puzzle</div>
          <h1>Get comfortable <span>being challenged.</span></h1>
          <p>
            A technical interview simulator that listens like a real interviewer: the problem is
            spoken, your reasoning matters, and feedback is tied to evidence from the session.
          </p>
          <div className="hero-actions">
            <a href="#start" className="primary-button hero-cta">Choose an interview <span>↘</span></a>
            <span className="hero-note">Original problems · Python · 45 min</span>
          </div>
        </div>
        <div className="hero-console" aria-label="Live interview preview">
          <div className="console-topline">
            <span><span className="live-dot" /> Live interview</span>
            <span className="console-time">38:24</span>
          </div>
          <div className="voice-orbit" aria-hidden="true">
            <span className="orbit-ring orbit-ring-one" />
            <span className="orbit-ring orbit-ring-two" />
            <span className="voice-core"><span className="voice-bars"><i /><i /><i /><i /><i /></span></span>
          </div>
          <div className="console-status">
            <strong>Interviewer is listening</strong>
            <span>Take your time. Think out loud when you&apos;re ready.</span>
          </div>
          <div className="console-code" aria-hidden="true">
            <span><b>01</b><i className="code-purple" /></span>
            <span><b>02</b><i className="code-long" /></span>
            <span><b>03</b><i className="code-blue" /></span>
            <span><b>04</b><i className="code-short" /></span>
          </div>
        </div>
      </section>

      <section id="start" className="setup-section" aria-label="Start an interview">
        <div className="section-heading">
          <div><div className="eyebrow">Configure your room</div><h2>Make this one feel real.</h2></div>
          <p>No question preview. Preparation does not use any of your 45 minutes.</p>
        </div>
        <div className="setup-grid">
        <div className="setup-card preparation-card">
          <header className="setup-card-header">
            <h2>Add resume context</h2>
            <p>Paste your resume, review every extracted fact, and erase the source text whenever you want.</p>
          </header>
          {!preparation ? <>
            <label className="field-label" htmlFor="resume">Resume text</label>
            <textarea
              id="resume"
              className="resume-input"
              value={resumeText}
              maxLength={50000}
              placeholder="Paste your resume here…"
              onChange={(event) => { setResumeText(event.target.value); preparationKey.current = null; }}
              disabled={starting}
            />
            <div className="tone-picker" role="radiogroup" aria-label="Interviewer tone">
              {TONES.map((item) => <button key={item.id} type="button" role="radio" aria-checked={tone === item.id}
                className={`tone-option${tone === item.id ? " active" : ""}`}
                onClick={() => { setTone(item.id); preparationKey.current = null; }}>
                <strong>{item.title}</strong><span>{item.description}</span>
              </button>)}
            </div>
            <label className="consent-row">
              <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
              <span>I consent to processing this text to personalize this interview. I can erase it before or after starting.</span>
            </label>
            <button className="secondary-button" type="button" onClick={analyzeResume}
              disabled={starting || !consent || resumeText.trim().length === 0}>
              {starting ? "Reviewing…" : "Review resume facts"}
            </button>
          </> : <div className="fact-review">
            <div className="review-heading"><strong>Confirm what the interviewer may use</strong><button type="button" onClick={eraseResume}>Erase source text</button></div>
            <p>{preparation.analysis?.summary}</p>
            {(preparation.analysis?.facts ?? []).map((fact) => <label className="fact-row" key={fact.id}>
              <input type="checkbox" checked={confirmedFacts.has(fact.id)} onChange={() => setConfirmedFacts((current) => {
                const next = new Set(current); next.has(fact.id) ? next.delete(fact.id) : next.add(fact.id); return next;
              })} />
              <span><b>{fact.category.toLowerCase()}</b>{fact.claim}<small>Source: “{fact.evidence}”</small></span>
            </label>)}
            {preparation.analysis?.facts.length === 0 && <p className="empty-facts">No supported facts were extracted. You can still continue without resume context.</p>}
          </div>}
        </div>

        <div className="setup-card">
          <header className="setup-card-header">
            <h2>Choose the room</h2>
            <p>One interview engine, three levels of support.</p>
          </header>
          <div className="mode-list" role="radiogroup" aria-label="Interview mode">
            {MODES.map((item) => (
              <button
                key={item}
                type="button"
                role="radio"
                aria-checked={mode === item}
                className={`mode-option${mode === item ? " active" : ""}`}
                onClick={() => setMode(item)}
              >
                <span className="radio-ring" aria-hidden="true" />
                <span>
                  <span className="mode-title">{item[0] + item.slice(1).toLowerCase()}</span>
                  <span className="mode-description">{MODE_COPY[item]}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="setup-card">
          <header className="setup-card-header">
            <h2>Select a session</h2>
            <p>You see only the level and topic mix. The prompt stays oral.</p>
          </header>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <div className="scenario-list">
            {scenarios.map((scenario, index) => (
              <button
                key={scenario.ref}
                className={`scenario-card${selectedRef === scenario.ref ? " selected" : ""}`}
                onClick={() => setSelectedRef(scenario.ref)}
                disabled={starting}
                aria-pressed={selectedRef === scenario.ref}
              >
                <span className="scenario-index">{String(index + 1).padStart(2, "0")}</span>
                <span>
                  <span className="scenario-title">{scenario.level} interview</span>
                  <span className="scenario-topics">{scenario.topics.join(" · ")}</span>
                </span>
                <span className="scenario-meta">
                  <span>{scenario.expectedMinutes} min</span>
                  <span className="scenario-arrow" aria-hidden="true">{selectedRef === scenario.ref ? "✓" : "→"}</span>
                </span>
              </button>
            ))}
            {scenarios.length === 0 && !error && <div className="scenario-skeletons" aria-label="Loading interview sessions"><i /><i /><i /></div>}
          </div>
          <div className="launch-bar">
            <div>
              <span className="launch-label">Ready when you are</span>
              <strong>{selected ? `${selected.level} · 45 minutes` : "Choose a session"}</strong>
            </div>
            <button className="primary-button launch-button" onClick={() => selected && startPrepared(selected.ref)} disabled={!selected || !preparation || starting}>
              {starting ? <><span className="button-spinner" /> Preparing room…</> : <>Enter interview <span>→</span></>}
            </button>
          </div>
        </div>
        </div>
      </section>

      <footer className="landing-footer"><span>Master Leeter</span><span>Built for deliberate practice, not puzzle memorization.</span></footer>
    </main>
  );
}
