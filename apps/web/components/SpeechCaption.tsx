"use client";

import { useEffect, useRef } from "react";
import { PanelLabel } from "./Notepad";

export interface SpeechCaptionProps {
  /** True while the provider is receiving candidate audio. */
  active: boolean;
  interim: string;
  lines: string[];
}

/**
 * Live captions for candidate speech (accessibility).
 *
 * Shows what you said — not what the interviewer said. A scrolling chat log of
 * the interviewer's words would turn listening back into reading.
 */
export function SpeechCaption({ active, interim, lines }: SpeechCaptionProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines, interim]);

  return (
    <div className="panel-shell">
      <div className="caption-header">
        <PanelLabel>Captions</PanelLabel>
        <span className={`caption-state${active ? " listening" : ""}`}>
          {active ? "Listening" : "Paused"}
        </span>
      </div>

      <div
        ref={scrollRef}
        aria-live="polite"
        aria-relevant="additions text"
        className="caption-body"
      >
        {lines.length === 0 && !interim && (
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>
            {active ? "Captions appear here while you speak." : "Start voice to enable candidate captions."}
          </p>
        )}

        {lines.map((line, i) => (
          <p key={`${i}-${line.slice(0, 12)}`} style={{ margin: "0 0 6px" }}>
            {line}
          </p>
        ))}

        {interim && (
          <p style={{ margin: 0, color: "var(--muted)", fontStyle: "italic" }}>{interim}</p>
        )}
      </div>
    </div>
  );
}
