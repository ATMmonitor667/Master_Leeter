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
    <main style={{ maxWidth: 680, margin: "0 auto", padding: "64px 24px" }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Master_Leeter</h1>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>
        You&apos;ll hear the problem out loud. Ask clarifying questions, think aloud, and write code.
        The interviewer is listening the whole time and will speak when it has something to say.
      </p>

      <section style={{ margin: "28px 0" }}>
        <label style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>
          Mode
        </label>
        <select value={mode} onChange={(e) => setMode(e.target.value as (typeof MODES)[number])}>
          {MODES.map((m) => (
            <option key={m} value={m}>
              {m[0] + m.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
      </section>

      {error && <p style={{ color: "var(--err)" }}>{error}</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {scenarios.map((s) => (
          <button
            key={s.ref}
            onClick={() => start(s.ref)}
            disabled={starting}
            style={{ textAlign: "left", padding: 14, display: "flex", justifyContent: "space-between" }}
          >
            <span>
              <strong>{s.level}</strong>
              <span style={{ color: "var(--muted)" }}> · {s.topics.join(", ")}</span>
            </span>
            <span style={{ color: "var(--muted)" }}>{s.expectedMinutes} min</span>
          </button>
        ))}
        {scenarios.length === 0 && !error && (
          <p style={{ color: "var(--muted)" }}>Loading scenarios…</p>
        )}
      </div>
    </main>
  );
}
