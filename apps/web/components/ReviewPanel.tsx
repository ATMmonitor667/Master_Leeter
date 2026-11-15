"use client";

import { useEffect, useState } from "react";
import type { ReviewTurn, TranscriptEntry } from "@master-leeter/contracts";
import { roomApi } from "../lib/room-client";
import { Button } from "./ui/Primitives";
import s from "./ReviewPanel.module.css";

/**
 * After the interview: the full transcript, and a professor you can ask about it.
 *
 * The professor teaches from what happened; it does not score. Nothing here is
 * available while an interview is live.
 */
export function ReviewPanel({ sessionId }: { sessionId: string }) {
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [turns, setTurns] = useState<ReviewTurn[]>([]);
  const [available, setAvailable] = useState(false);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    roomApi.review(sessionId)
      .then((data) => { setTranscript(data.transcript); setTurns(data.turns); setAvailable(data.available); })
      .catch(() => { /* the report above still stands on its own */ });
  }, [sessionId]);

  async function ask(text: string) {
    setBusy(true); setError(null);
    try {
      const data = await roomApi.ask(sessionId, crypto.randomUUID(), text);
      setTurns(data.turns);
      if (text) setQuestion("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The review could not be generated."); }
    finally { setBusy(false); }
  }

  if (!transcript.length && !available) return null;
  return (
    <>
      {available && (
        <section className={s.panel} aria-labelledby="professor">
          <h2 id="professor">Review with a professor</h2>
          <p className={s.help}>A teaching conversation about this interview: what worked, where the reasoning slipped, and a strong solution. It does not change your scores.</p>
          {turns.map((turn) => (
            <div key={turn.requestId} className={s.turn}>
              {turn.question && <p className={s.question}>{turn.question}</p>}
              <p className={s.reply}>{turn.reply}</p>
            </div>
          ))}
          {error && <p role="alert" className={s.error}>{error}</p>}
          {turns.length === 0 ? (
            <Button variant="primary" loading={busy} onClick={() => void ask("")}>{busy ? "Preparing the debrief…" : "Get the debrief"}</Button>
          ) : (
            <form className={s.ask} onSubmit={(event) => { event.preventDefault(); if (question.trim()) void ask(question.trim()); }}>
              <input value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={4_000}
                placeholder="Ask about this interview" aria-label="Ask the professor about this interview" />
              <Button type="submit" loading={busy} disabled={!question.trim()}>Ask</Button>
            </form>
          )}
        </section>
      )}
      {transcript.length > 0 && (
        <details className={s.panel}>
          <summary><h2>Transcript</h2><small>{transcript.length} turns</small></summary>
          <ol className={s.transcript}>
            {transcript.map((entry) => (
              <li key={entry.seq} data-speaker={entry.speaker}>
                <small>{entry.speaker === "INTERVIEWER" ? "Interviewer" : "You"}</small>
                <p>{entry.text}</p>
              </li>
            ))}
          </ol>
        </details>
      )}
    </>
  );
}
