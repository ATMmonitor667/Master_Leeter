"use client";

import type { RunResult, ServerMessage } from "@master-leeter/contracts";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeEditor } from "../../../components/CodeEditor";
import { InterviewerStatus, type InterviewerState } from "../../../components/InterviewerStatus";
import { Notepad } from "../../../components/Notepad";
import { TestPanel } from "../../../components/TestPanel";
import { Timer } from "../../../components/Timer";
import { VoiceControls } from "../../../components/VoiceControls";
import { SessionClient } from "../../../lib/session-client";
import { VoiceSession, type VoiceStatus } from "../../../lib/voice-session";

/**
 * The candidate workspace (M2-3).
 *
 * What is deliberately absent, and must stay absent:
 *
 *   - The problem statement. Not in the DOM, not in a data attribute, not in a
 *     network payload. It reaches the candidate through the voice agent or not
 *     at all (invariant 2).
 *   - A chat transcript. A scrolling log of what the interviewer said turns
 *     listening back into reading.
 *   - Any indication of what the interviewer is considering. Showing "probe
 *     pending" would let the candidate play the gate rather than the interview.
 *
 * What is present is a code editor, somewhere to think, a way to run things,
 * and the time. That is what a real interview gives you.
 */

const STARTER = `def first_rescan(readings):
    # Your solution here.
    pass
`;

export default function InterviewPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);

  const [code, setCode] = useState(STARTER);
  const [notes, setNotes] = useState("");
  const [testInput, setTestInput] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [interviewer, setInterviewer] = useState<InterviewerState>("LISTENING");
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [runnerAvailable, setRunnerAvailable] = useState(true);
  const [result, setResult] = useState<RunResult | null>(null);
  const [ending, setEnding] = useState(false);
  const [restored, setRestored] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("IDLE");
  const [voiceMuted, setVoiceMuted] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const clientRef = useRef<SessionClient | null>(null);
  const voiceRef = useRef<VoiceSession | null>(null);

  const onServerMessage = useCallback((msg: ServerMessage) => {
    switch (msg.kind) {
      case "STATE":
        setRemaining(msg.remainingSeconds);
        setInterviewer(msg.interviewerStatus);
        break;
      case "RUN_RESULT":
        setResult(msg.result);
        setRunning(false);
        break;
      case "ERROR":
        if (msg.code === "RUNNER_UNAVAILABLE") setRunnerAvailable(false);
        setRunning(false);
        break;
      default:
        break;
    }
  }, []);

  /**
   * Restore before connecting (M7-1).
   *
   * A refresh mid-interview should cost the candidate nothing but a moment.
   * State comes from the append-only event log rather than localStorage: the
   * server already holds the evidence, and a client-side cache could disagree
   * with the log the evaluator reads.
   */
  useEffect(() => {
    const api = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:4000";
    let cancelled = false;

    fetch(`${api}/v1/interview-sessions/${sessionId}/resume`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return setRestored(true);
        if (data.ended) {
          window.location.href = `/report/${sessionId}`;
          return;
        }
        if (data.code) setCode(data.code);
        if (data.notes) setNotes(data.notes);
        if (typeof data.remainingSeconds === "number") setRemaining(data.remainingSeconds);
        setRestored(true);
      })
      .catch(() => setRestored(true));

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    const wsBase = process.env["NEXT_PUBLIC_WS_URL"] ?? "ws://localhost:4000";
    const api = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:4000";

    const client = new SessionClient({
      sessionId,
      onServerMessage,
      onConnectionChange: setConnected,
      // A 40-minute session will drop. Re-dial rather than stranding the
      // candidate's buffered edits.
      reconnectDelayMs: 1500,
      connect: (handlers) => {
        const socket = new WebSocket(`${wsBase}/v1/interview-sessions/${sessionId}/events`);
        socket.onopen = () => handlers.onOpen();
        socket.onclose = () => {
          // Tell the server the socket went down so the grace window starts and
          // a sustained outage gets credited back to the clock.
          void fetch(`${api}/v1/interview-sessions/${sessionId}/disconnected`, {
            method: "POST",
            keepalive: true,
          }).catch(() => {});
          handlers.onClose();
        };
        socket.onmessage = (e) => handlers.onMessage(String(e.data));

        return {
          send: (data) => socket.send(data),
          close: () => socket.close(),
          get connected() {
            return socket.readyState === WebSocket.OPEN;
          },
        };
      },
    });

    client.connect();
    clientRef.current = client;

    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, [sessionId, onServerMessage]);

  /**
   * Start voice on request, never on load.
   *
   * A microphone that opens itself is hostile, and the candidate should be able
   * to read the workspace before anything is listening.
   */
  const onVoiceStart = useCallback(
    (deviceId?: string) => {
      setVoiceError(null);

      const session = new VoiceSession({
        sessionId,
        apiBase: process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:4000",
        ...(deviceId ? { deviceId } : {}),
        onStatus: setVoiceStatus,
        onError: (err) => setVoiceError(err.message),
        // The events M4-2 measures silenceMs between. They carry the VAD's
        // onset timestamps, not the moment they were sent.
        onSpeechBoundary: (boundary) =>
          clientRef.current?.speechBoundary(boundary.type, boundary.atMs),
      });

      voiceRef.current = session;
      session.start().catch(() => {
        // Already surfaced through onError; the rejection is the same failure.
      });
    },
    [sessionId],
  );

  const onVoiceStop = useCallback(() => {
    void voiceRef.current?.stop();
    voiceRef.current = null;
    setVoiceMuted(false);
  }, []);

  const onToggleMute = useCallback(() => {
    setVoiceMuted((current) => {
      voiceRef.current?.setMuted(!current);
      return !current;
    });
  }, []);

  // Releases the microphone on unmount. A session left holding a live capture
  // indicator after navigating away is alarming and looks like a bug.
  useEffect(() => () => void voiceRef.current?.stop(), []);

  const onCodeChange = useCallback((text: string) => {
    setCode(text);
    clientRef.current?.codeChanged(text);
  }, []);

  const onNotesChange = useCallback((text: string) => {
    setNotes(text);
    clientRef.current?.notesChanged(text);
  }, []);

  const onRun = useCallback(() => {
    setRunning(true);
    setResult(null);
    clientRef.current?.requestRun(testInput);
  }, [testInput]);

  const onEnd = useCallback(async () => {
    // Flush before ending so the final revision is in the log the evaluator
    // will read. An unflushed last edit is evidence that never existed.
    clientRef.current?.flush();
    setEnding(true);

    const api = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:4000";
    try {
      await fetch(`${api}/v1/interview-sessions/${sessionId}/end`, { method: "POST" });
    } finally {
      window.location.href = `/report/${sessionId}`;
    }
  }, [sessionId]);

  const header = useMemo(
    () => (
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 16px",
          borderBottom: "1px solid var(--border)",
          background: "var(--panel)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <strong style={{ fontSize: 13, letterSpacing: "0.02em" }}>Master_Leeter</strong>
          {!connected && (
            <span style={{ color: "var(--warn)", fontSize: 12 }}>Reconnecting…</span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <VoiceControls
            status={voiceStatus}
            muted={voiceMuted}
            error={voiceError}
            onStart={onVoiceStart}
            onStop={onVoiceStop}
            onToggleMute={onToggleMute}
          />
          <InterviewerStatus state={voiceStatus === "SPEAKING" ? "SPEAKING" : interviewer} />
          <Timer remainingSeconds={remaining} />
          {/* Deliberately plain. Ending an interview is a decision, not a
              call to action, and a prominent button invites misclicks. */}
          <button onClick={onEnd} disabled={ending} style={{ fontSize: 12, padding: "4px 10px" }}>
            {ending ? "Ending…" : "End interview"}
          </button>
        </div>
      </header>
    ),
    [
      connected,
      interviewer,
      remaining,
      onEnd,
      ending,
      voiceStatus,
      voiceMuted,
      voiceError,
      onVoiceStart,
      onVoiceStop,
      onToggleMute,
    ],
  );

  return (
    <main style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {header}

      <div
        style={{
          flex: 1,
          opacity: restored ? 1 : 0.5,
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.9fr) minmax(280px, 1fr)",
          minHeight: 0,
        }}
      >
        <section style={{ borderRight: "1px solid var(--border)", minHeight: 0 }}>
          <CodeEditor value={code} language="python" onChange={onCodeChange} />
        </section>

        <aside
          style={{
            display: "grid",
            gridTemplateRows: "minmax(0, 1fr) minmax(0, 1.2fr)",
            minHeight: 0,
          }}
        >
          <div style={{ borderBottom: "1px solid var(--border)", minHeight: 0 }}>
            <Notepad value={notes} onChange={onNotesChange} />
          </div>
          <TestPanel
            input={testInput}
            onInputChange={setTestInput}
            onRun={onRun}
            running={running}
            runnerAvailable={runnerAvailable}
            result={result}
          />
        </aside>
      </div>
    </main>
  );
}
