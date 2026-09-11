"use client";

import { useEffect, useState } from "react";

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

const API = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:4000";
const MODES = ["LEARNING", "MOCK", "STRICT"] as const;
const MODE_COPY: Record<(typeof MODES)[number], string> = {
  LEARNING: "More room for hints and a gentler intervention cadence.",
  MOCK: "A balanced, realistic interview with evidence-based feedback.",
  STRICT: "Minimal help, longer silences, and a higher bar for intervention.",
};

export default function Home() {
  const [scenarios, setScenarios] = useState<CatalogueEntry[]>([]);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [mode, setMode] = useState<(typeof MODES)[number]>("MOCK");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    fetch(`${API}/v1/scenarios`)
      .then((r) => r.json())
      .then((d) => {
        const entries = (d.scenarios ?? []) as CatalogueEntry[];
        setScenarios(entries);
        setSelectedRef((current) => current ?? entries[0]?.ref ?? null);
      })
      .catch(() => setError("Could not reach the API. Is it running on port 4000?"));
  }, []);

  async function start(scenarioRef: string) {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch(`${API}/v1/interview-sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Stable per attempt, so a retry cannot silently create two sessions.
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ scenarioRef, mode }),
      });

      if (!res.ok) throw new Error(`start failed: ${res.status}`);
      const { sessionId } = await res.json();
      window.location.href = `/interview/${sessionId}`;
    } catch (err) {
      setError((err as Error).message);
      setStarting(false);
    }
  }

  const selected = scenarios.find((scenario) => scenario.ref === selectedRef) ?? null;

  return (
    <main className="landing-shell">
      <nav className="landing-nav" aria-label="Product">
        <div className="brand"><span className="brand-mark">ML</span><span className="brand-name">Master Leeter</span></div>
        <span className="pill"><span className="status-dot" /> Voice-first technical practice</span>
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
            <span className="hero-note">Original problems · Python · 35–45 min</span>
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
          <p>No question preview. The timer begins after the spoken brief.</p>
        </div>
        <div className="setup-grid">
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
              <strong>{selected ? `${selected.level} · ${selected.expectedMinutes} minutes` : "Choose a session"}</strong>
            </div>
            <button className="primary-button launch-button" onClick={() => selected && start(selected.ref)} disabled={!selected || starting}>
              {starting ? <><span className="button-spinner" /> Opening room…</> : <>Enter interview <span>→</span></>}
            </button>
          </div>
        </div>
        </div>
      </section>

      <footer className="landing-footer"><span>Master Leeter</span><span>Built for deliberate practice, not puzzle memorization.</span></footer>
    </main>
  );
}
