"use client";

import { useEffect, useRef } from "react";
import { usePreferences } from "../Preferences";
import s from "./InterviewerSignal.module.css";

/**
 * The interviewer's whole presence: an abstract light ring and one honest word.
 *
 * No face, no avatar. Each state is driven by a real signal: "Speaking" only
 * while interviewer audio is actually audible, with the bars following its
 * level; "Listening" follows the microphone. When the audio stops, so does the
 * motion: there is no decorative loop.
 */
export type SignalState = "idle" | "connecting" | "ready" | "listening" | "thinking" | "speaking" | "reconnecting" | "failed";

const COPY: Record<SignalState, { label: string; helper: string }> = {
  idle: { label: "Voice off", helper: "Connect your microphone to begin." },
  connecting: { label: "Connecting", helper: "Opening the microphone and the voice connection." },
  ready: { label: "Ready", helper: "Connected. Start when you are." },
  listening: { label: "Listening", helper: "Think aloud. The interviewer answers when you ask." },
  thinking: { label: "Thinking", helper: "The interviewer heard you." },
  speaking: { label: "Speaking", helper: "Talk over the interviewer to interrupt." },
  reconnecting: { label: "Reconnecting", helper: "Your code is still editable." },
  failed: { label: "Connection lost", helper: "Voice is unavailable right now." },
};

const BARS = [0.45, 0.75, 1, 0.75, 0.45];

export function InterviewerSignal({
  state, size = 36, levels, showHelper = false,
}: {
  state: SignalState;
  size?: number;
  /** Read on animation frames; never stored. */
  levels?: () => { input: number; output: number };
  showHelper?: boolean;
}) {
  const { announce } = usePreferences();
  const orb = useRef<HTMLSpanElement>(null);
  const { label, helper } = COPY[state];

  useEffect(() => { announce(`Interviewer: ${label}`, 3); }, [label]); // eslint-disable-line react-hooks/exhaustive-deps

  // The loop runs only in the two states that have a live level to show.
  useEffect(() => {
    const element = orb.current;
    if (!element) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const live = (state === "speaking" || state === "listening") && levels && !reduced;
    if (!live) { element.style.setProperty("--level", state === "speaking" ? "0.5" : "0"); return; }
    let frame = 0;
    let shown = 0;
    const step = () => {
      if (!document.hidden) {
        const now = levels();
        const target = state === "speaking" ? now.output : now.input * 0.6;
        // Fast attack, slower release, so the ring breathes instead of flickering.
        shown += (target - shown) * (target > shown ? 0.5 : 0.18);
        element.style.setProperty("--level", shown.toFixed(3));
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(frame); element.style.setProperty("--level", "0"); };
  }, [state, levels]);

  return (
    <div className={s.signal} data-state={state} role="status" aria-label={`Interviewer: ${label}`}>
      <span ref={orb} className={s.orb} style={{ width: size, height: size }} aria-hidden>
        <span className={s.halo} />
        <svg viewBox="0 0 40 40" className={s.ring}>
          <circle cx="20" cy="20" r="17" className={s.track} />
          <circle cx="20" cy="20" r="17" className={s.arc} />
        </svg>
        <span className={s.core}>
          {BARS.map((scale, i) => <i key={i} style={{ "--bar": scale } as React.CSSProperties} />)}
        </span>
      </span>
      <span className={s.copy}>
        <small>Interviewer</small>
        <strong>{label}</strong>
        {showHelper && <span className={s.helper}>{helper}</span>}
      </span>
    </div>
  );
}
