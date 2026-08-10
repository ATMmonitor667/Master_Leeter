"use client";

import type { RunResult, ServerMessage } from "@master-leeter/contracts";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeEditor } from "../../../components/CodeEditor";
import { InterviewerStatus, type InterviewerState } from "../../../components/InterviewerStatus";
import { Notepad } from "../../../components/Notepad";
import { TestPanel } from "../../../components/TestPanel";
import { Timer } from "../../../components/Timer";
import { SessionClient } from "../../../lib/session-client";

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

  const clientRef = useRef<SessionClient | null>(null);

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
        break;
      default:
        break;
    }
  }, []);

  useEffect(() => {
    const wsBase = process.env["NEXT_PUBLIC_WS_URL"] ?? "ws://localhost:4000";

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
        socket.onclose = () => handlers.onClose();
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
          <InterviewerStatus state={interviewer} />
          <Timer remainingSeconds={remaining} />
        </div>
      </header>
    ),
    [connected, interviewer, remaining],
  );

  return (
    <main style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {header}

      <div
        style={{
          flex: 1,
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
