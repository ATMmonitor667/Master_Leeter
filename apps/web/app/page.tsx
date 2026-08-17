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
  const [mode, setMode] = useState<(typeof MODES)[number]>("MOCK");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    fetch(`${API}/v1/scenarios`)
      .then((r) => r.json())
      .then((d) => setScenarios(d.scenarios ?? []))
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

  return (
    <main className="landing-shell">
      <nav className="landing-nav" aria-label="Product">
        <div className="brand"><span className="brand-mark">ML</span><span className="brand-name">Master Leeter</span></div>
        <span className="pill"><span className="status-dot" /> Voice-first technical practice</span>
      </nav>

      <section className="landing-hero">
        <div className="landing-copy">
          <div className="eyebrow">Practice the room, not the puzzle</div>
          <h1>Think out loud. <span>Code under pressure.</span></h1>
          <p>
            A technical interview simulator that listens like a real interviewer: the problem is
            spoken, your reasoning matters, and feedback is tied to evidence from the session.
          </p>
        </div>
        <div className="hero-proof" aria-label="How it works">
          <div className="proof-row"><span className="proof-icon">01</span><span>Hear the prompt and ask canonical clarifying questions.</span></div>
          <div className="proof-row"><span className="proof-icon">02</span><span>Reason aloud, code, test, and debug in one focused workspace.</span></div>
          <div className="proof-row"><span className="proof-icon">03</span><span>Review an evidence-backed rubric after the interview ends.</span></div>
        </div>
      </section>

      <section className="setup-grid" aria-label="Start an interview">
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
                className="scenario-card"
                onClick={() => start(scenario.ref)}
                disabled={starting}
              >
                <span className="scenario-index">{String(index + 1).padStart(2, "0")}</span>
                <span>
                  <span className="scenario-title">{scenario.level} interview</span>
                  <span className="scenario-topics">{scenario.topics.join(" · ")}</span>
                </span>
                <span className="scenario-meta">
                  <span>{scenario.expectedMinutes} min</span>
                  <span className="scenario-arrow" aria-hidden="true">→</span>
                </span>
              </button>
            ))}
            {scenarios.length === 0 && !error && <div className="loading-row">Loading interview sessions…</div>}
          </div>
        </div>
      </section>
    </main>
  );
}
