"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PanelLabel } from "./Notepad";
import {
  SpeechTranscriber,
  speechRecognitionAvailable,
  type SpeechTranscriberStatus,
} from "../lib/speech-transcriber";

const MAX_LINES = 12;

export interface SpeechCaptionProps {
  /** Called when the browser finalizes a phrase. */
  onFinal?: (transcript: string) => void;
}

/**
 * Live captions for candidate speech (accessibility).
 *
 * Shows what you said — not what the interviewer said. A scrolling chat log of
 * the interviewer's words would turn listening back into reading.
 */
export function SpeechCaption({ onFinal }: SpeechCaptionProps) {
  const [supported] = useState(() => speechRecognitionAvailable());
  const [status, setStatus] = useState<SpeechTranscriberStatus>(supported ? "IDLE" : "UNSUPPORTED");
  const [interim, setInterim] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const transcriberRef = useRef<SpeechTranscriber | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines, interim]);

  useEffect(
    () => () => {
      transcriberRef.current?.stop();
      transcriberRef.current = null;
    },
    [],
  );

  const onToggle = useCallback(() => {
    if (!supported) return;

    if (status === "LISTENING") {
      transcriberRef.current?.stop();
      transcriberRef.current = null;
      setInterim("");
      return;
    }

    setError(null);
    const transcriber = new SpeechTranscriber({
      onStatus: setStatus,
      onInterim: setInterim,
      onFinal: (text) => {
        setInterim("");
        setLines((prev) => [...prev.slice(-(MAX_LINES - 1)), text]);
        onFinal?.(text);
      },
      onError: (message) => setError(message),
    });

    transcriberRef.current = transcriber;
    transcriber.start();
  }, [onFinal, status, supported]);

  const listening = status === "LISTENING";

  return (
    <div className="panel-shell">
      <div className="caption-header">
        <PanelLabel>Captions</PanelLabel>
        <button
          type="button"
          onClick={onToggle}
          disabled={!supported}
          className="ghost-button"
          style={{ marginRight: 6, opacity: supported ? 1 : 0.5 }}
        >
          {listening ? "Stop" : "Start"}
        </button>
      </div>

      <div
        ref={scrollRef}
        aria-live="polite"
        aria-relevant="additions text"
        className="caption-body"
      >
        {!supported && (
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>
            Speech recognition is not available in this browser. Try Chrome or Edge.
          </p>
        )}

        {supported && lines.length === 0 && !interim && !listening && (
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>
            Start captions to see what you say transcribed here.
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

        {error && (
          <p style={{ margin: "8px 0 0", color: "var(--warn)", fontSize: 12 }}>{error}</p>
        )}
      </div>
    </div>
  );
}
