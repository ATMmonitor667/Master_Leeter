"use client";

import { useEffect, useRef, useState } from "react";
import { usePreferences } from "./Preferences";
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
  const follow = useRef(true);
  const last = useRef("");
  const [behind, setBehind] = useState(false);
  const { readCaptions, announce } = usePreferences();

  useEffect(() => {
    if (follow.current)
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    else setBehind(true);
  }, [lines, interim]);
  useEffect(() => {
    const text = lines.at(-1);
    if (text && text !== last.current) {
      last.current = text;
      if (readCaptions) announce(text);
    }
  }, [lines, readCaptions]);

  return (
    <div className="panel-shell">
      <div className="caption-header">
        <PanelLabel>Your captions</PanelLabel>
        <span className={`caption-state${active ? " listening" : ""}`}>
          {active ? "Listening" : "Paused"}
        </span>
      </div>

      <div
        ref={scrollRef}
        tabIndex={0}
        aria-label="Your speech captions"
        onScroll={(event) => {
          const el = event.currentTarget;
          follow.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (follow.current) setBehind(false);
        }}
        className="caption-body"
      >
        {lines.length === 0 && !interim && (
          <p style={{ margin: 0, color: "var(--muted)" }}>
            {active
              ? "Captions appear here while you speak."
              : "Start voice to enable candidate captions."}
          </p>
        )}

        {lines.map((line, i) => (
          <p key={`${i}-${line.slice(0, 12)}`} style={{ margin: "0 0 6px" }}>
            {line}
          </p>
        ))}

        {interim && (
          <p style={{ margin: 0, color: "var(--muted)", fontStyle: "italic" }}>
            {interim}
          </p>
        )}
      </div>
      {behind && (
        <button
          className="ghost-button"
          onClick={() => {
            follow.current = true;
            setBehind(false);
            scrollRef.current?.scrollTo({
              top: scrollRef.current.scrollHeight,
            });
          }}
        >
          Jump to latest captions
        </button>
      )}
    </div>
  );
}
