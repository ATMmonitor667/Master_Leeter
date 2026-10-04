"use client";

import type { InterviewState, ServerMessage } from "@master-leeter/contracts";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeEditor } from "../../../components/CodeEditor";
import { InterviewerStatus, type InterviewerState } from "../../../components/InterviewerStatus";
import { Notepad } from "../../../components/Notepad";
import { SpeechCaption } from "../../../components/SpeechCaption";
import { StageProgress, STAGE_LABELS } from "../../../components/StageProgress";
import { Timer } from "../../../components/Timer";
import { VoiceControls } from "../../../components/VoiceControls";
import { SessionClient } from "../../../lib/session-client";
import { apiFetch } from "../../../lib/auth";
import { apiBaseUrl } from "../../../lib/public-config";
import { connectSessionTransport } from "../../../lib/session-transport";
import { useDialogFocus } from "../../../lib/use-dialog-focus";
import { VoiceSession, type VoiceDeviceState, type VoiceStatus } from "../../../lib/voice-session";

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
 * What is present is a code editor, somewhere to think, voice status, and the
 * time. The interviewer observes revisions without a submit ceremony.
 */

const STARTER = `# Write your Python solution here.
# Talk through your assumptions before you begin.

`;

type SupportCategory = "VOICE" | "CONNECTION" | "SAVING" | "REPORT" | "OTHER";
type SupportState = "IDLE" | "SENDING" | "SENT" | "ERROR";

export default function InterviewPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);

  const [code, setCode] = useState(STARTER);
  const [notes, setNotes] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [stage, setStage] = useState<InterviewState>("ORAL_PROBLEM_DELIVERY");
  const [interviewer, setInterviewer] = useState<InterviewerState>("LISTENING");
  const [connected, setConnected] = useState(false);
  const [pendingSaves, setPendingSaves] = useState(0);
  const [ending, setEnding] = useState(false);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [reportingProblem, setReportingProblem] = useState(false);
  const [supportCategory, setSupportCategory] = useState<SupportCategory>("VOICE");
  const [supportState, setSupportState] = useState<SupportState>("IDLE");
  const [supportReportId, setSupportReportId] = useState("");
  const [supportReference, setSupportReference] = useState("");
  const [restored, setRestored] = useState(false);
  const [resumeCursor, setResumeCursor] = useState({ clientSeq: 0, codeRevision: 0 });
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("IDLE");
  const [voiceDevices, setVoiceDevices] = useState<VoiceDeviceState | null>(null);
  const [voiceMuted, setVoiceMuted] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [captionInterim, setCaptionInterim] = useState("");
  const [captionLines, setCaptionLines] = useState<string[]>([]);

  const clientRef = useRef<SessionClient | null>(null);
  const voiceRef = useRef<VoiceSession | null>(null);

  const onServerMessage = useCallback((msg: ServerMessage) => {
    switch (msg.kind) {
      case "STATE":
        setRemaining(msg.remainingSeconds);
        setStage(msg.state);
        setInterviewer(msg.interviewerStatus);
        break;
      case "ACTION":
        if (msg.utteranceId) {
          voiceRef.current?.speak(
            { action: msg.action, utteranceId: msg.utteranceId, ...(msg.audio ? { audio: msg.audio } : {}) },
            msg.serverTiming as { decisionMs?: number; classifierMs?: number; classifierSource?: string } | undefined,
          );
        }
        break;
      case "ERROR":
        if (msg.code === "SESSION_ENDED") window.location.href = `/report/${sessionId}`;
        break;
      default:
        break;
    }
  }, [sessionId]);

  /**
   * Restore before connecting (M7-1).
   *
   * A refresh mid-interview should cost the candidate nothing but a moment.
   * State comes from the append-only event log rather than localStorage: the
   * server already holds the evidence, and a client-side cache could disagree
   * with the log the evaluator reads.
   */
  useEffect(() => {
    let cancelled = false;

    apiFetch(`/v1/interview-sessions/${sessionId}/resume`)
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
        if (typeof data.state === "string") setStage(data.state as InterviewState);
        setResumeCursor({
          clientSeq: typeof data.nextClientSeq === "number" ? data.nextClientSeq : 0,
          codeRevision: typeof data.codeRevision === "number" ? data.codeRevision : 0,
        });
        setRestored(true);
      })
      .catch(() => setRestored(true));

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!restored) return;
    const client = new SessionClient({
      sessionId,
      initialClientSeq: resumeCursor.clientSeq,
      initialCodeRevision: resumeCursor.codeRevision,
      onServerMessage,
      onConnectionChange: setConnected,
      onPendingChange: setPendingSaves,
      // A 40-minute session will drop. Re-dial rather than stranding the
      // candidate's buffered edits.
      reconnectDelayMs: 1500,
      connect: (handlers) => connectSessionTransport(sessionId, handlers, setVoiceError),
    });

    client.connect();
    clientRef.current = client;

    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, [sessionId, onServerMessage, restored, resumeCursor.clientSeq, resumeCursor.codeRevision]);

  /**
   * Start voice on request, never on load.
   *
   * A microphone that opens itself is hostile, and the candidate should be able
   * to read the workspace before anything is listening.
   */
  const onVoiceStart = useCallback(
    async (deviceId?: string) => {
      setVoiceError(null);

      // A retry can follow a partially-started session (permission, worklet or
      // provider failure). Release that session before opening another one so
      // its devicechange listener, tracks and reconnect timers cannot survive
      // behind the replacement.
      const previous = voiceRef.current;
      voiceRef.current = null;
      await previous?.stop().catch(() => {});

      const session = new VoiceSession({
        sessionId,
        apiBase: apiBaseUrl(),
        ...(deviceId ? { deviceId } : {}),
        onStatus: (status) => {
          setVoiceStatus(status);
          if (status === "LISTENING") setVoiceError(null);
        },
        onError: (err) => setVoiceError(err.message),
        // Fired on OS device changes and after an automatic recovery, so the
        // pickers keep showing what is really capturing and playing.
        onDeviceChange: setVoiceDevices,
        // The events M4-2 measures silenceMs between. They carry the VAD's
        // onset timestamps, not the moment they were sent.
        onSpeechBoundary: (boundary) =>
          clientRef.current?.speechBoundary(boundary.type, boundary.atMs, boundary.prosody, boundary.interimTranscript),
        onTranscript: ({ text, final }) => {
          if (final) {
            setCaptionInterim("");
            setCaptionLines((lines) => [...lines.slice(-11), text]);
            clientRef.current?.speechFinal(text);
          } else {
            setCaptionInterim(text);
          }
        },
      });

      voiceRef.current = session;
      await session.start().catch(() => {
        // Already surfaced through onError; the rejection is the same failure.
      });
    },
    [sessionId],
  );

  /**
   * Change microphone without leaving the round.
   *
   * Deliberately not stop() + start(): that would re-mint a credential and
   * replay the opening handshake. Interview time is server-owned and keeps
   * running, so a device swap must stay cheap.
   */
  const onSwitchDevice = useCallback((deviceId?: string) => {
    voiceRef.current?.switchMicrophone(deviceId).catch((err: unknown) => {
      setVoiceError(err instanceof Error ? err.message : "Could not switch microphone.");
    });
  }, []);

  const onSwitchSpeaker = useCallback((deviceId?: string) => {
    voiceRef.current?.switchSpeaker(deviceId).catch((err: unknown) => {
      setVoiceError(err instanceof Error ? err.message : "Could not switch speaker.");
    });
  }, []);

  const onVoiceStop = useCallback(() => {
    void voiceRef.current?.stop();
    voiceRef.current = null;
    setVoiceMuted(false);
    setVoiceDevices(null);
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

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") clientRef.current?.flush();
    };
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => document.removeEventListener("visibilitychange", flushWhenHidden);
  }, []);

  const onEnd = useCallback(async () => {
    setEnding(true);

    try {
      // Manual VAD must close the current provider turn before the final app
      // cursor is chosen. This bounded wait lets a spoken answer that ends on
      // the button click enter the same acknowledged/sealed evidence stream.
      await voiceRef.current?.finishInput();
      const finalClientSeq = await clientRef.current?.flushAndWaitForAcknowledgement() ?? -1;
      const response = await apiFetch(`/v1/interview-sessions/${sessionId}/end`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ finalClientSeq }),
      });
      if (!response.ok) throw new Error("Could not complete this interview. Please retry.");
      window.location.href = `/report/${sessionId}`;
    } catch (error) {
      setEnding(false);
      setVoiceError((error as Error).message);
    }
  }, [sessionId]);

  const openProblemReport = useCallback(() => {
    setSupportCategory("VOICE");
    setSupportState("IDLE");
    setSupportReference("");
    setSupportReportId(crypto.randomUUID());
    setReportingProblem(true);
  }, []);

  const sendProblemReport = useCallback(async () => {
    if (!supportReportId) return;
    setSupportState("SENDING");
    try {
      const response = await apiFetch(`/v1/interview-sessions/${sessionId}/support-incidents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reportId: supportReportId,
          category: supportCategory,
          consentDiagnostics: true,
          diagnostics: {
            connected,
            online: navigator.onLine,
            visibility: document.visibilityState === "hidden" ? "hidden" : "visible",
            pendingSaves,
            stage,
            voiceStatus,
          },
        }),
      });
      const body = await response.json().catch(() => ({})) as { incidentId?: string };
      if (!response.ok || !body.incidentId) throw new Error("REPORT_FAILED");
      setSupportReference(body.incidentId);
      setSupportState("SENT");
    } catch {
      setSupportState("ERROR");
    }
  }, [connected, pendingSaves, sessionId, stage, supportCategory, supportReportId, voiceStatus]);

  const closeEndDialog = useCallback(() => { if (!ending) setConfirmingEnd(false); }, [ending]);
  const closeSupportDialog = useCallback(() => {
    if (supportState !== "SENDING") setReportingProblem(false);
  }, [supportState]);
  const endDialogRef = useDialogFocus<HTMLElement>(confirmingEnd, closeEndDialog);
  const supportDialogRef = useDialogFocus<HTMLElement>(reportingProblem, closeSupportDialog);
  useEffect(() => {
    if (supportState === "SENT") supportDialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [supportState, supportDialogRef]);

  const header = useMemo(
    () => (
      <header className="workspace-header">
        <div className="workspace-header-left">
          <div className="brand"><span className="brand-mark">ML</span><span className="brand-name">Master Leeter</span></div>
          <span className={`connection-state${connected ? "" : " offline"}`}>
            <span className="status-dot" />{connected ? "Connected" : "Reconnecting"}
          </span>
        </div>
        <StageProgress stage={stage} />
        <div className="workspace-header-right">
          <VoiceControls
            status={voiceStatus}
            muted={voiceMuted}
            error={voiceError}
            onStart={onVoiceStart}
            onStop={onVoiceStop}
            onToggleMute={onToggleMute}
            deviceState={voiceDevices}
            onSwitchDevice={onSwitchDevice}
            onSwitchSpeaker={onSwitchSpeaker}
          />
          <InterviewerStatus state={voiceStatus === "SPEAKING" ? "SPEAKING" : interviewer} />
          <Timer
            remainingSeconds={remaining}
            running={connected && stage !== "ORAL_PROBLEM_DELIVERY"}
            ready={restored}
          />
          <button onClick={openProblemReport} className="ghost-button problem-button">
            Report a problem
          </button>
          {/* Deliberately plain. Ending an interview is a decision, not a
              call to action, and a prominent button invites misclicks. */}
          <button onClick={() => setConfirmingEnd(true)} disabled={ending} className="ghost-button end-button">
            {ending ? "Completing…" : "Complete interview"}
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
      voiceDevices,
      onVoiceStart,
      onVoiceStop,
      onToggleMute,
      onSwitchDevice,
      onSwitchSpeaker,
      openProblemReport,
      stage,
    ],
  );

  return (
    <main className={`workspace voice-${voiceStatus.toLowerCase()}`}>
      {header}

      {(voiceStatus === "IDLE" || voiceStatus === "FAILED") && (
        <div className="voice-onboarding" role="status">
          <span className="voice-onboarding-icon" aria-hidden="true">⌁</span>
          <span><strong>{voiceStatus === "FAILED" ? "Voice needs another try" : "Your interview is waiting"}</strong><small>{voiceStatus === "FAILED" ? "Check your microphone and reconnect when ready." : "Start voice to hear the problem. Your timer starts after the brief."}</small></span>
          <span className="voice-onboarding-stage">01 · {STAGE_LABELS[stage]}</span>
        </div>
      )}

      <div
        className={`workspace-grid${restored ? "" : " workspace-loading"}`}
      >
        <section className="workspace-pane" aria-label="Code editor">
          <CodeEditor
            value={code}
            language="python"
            onChange={onCodeChange}
            saveState={!connected && pendingSaves > 0 ? "offline" : pendingSaves > 0 ? "saving" : "saved"}
          />
        </section>

        <aside className="workspace-side" aria-label="Interview tools">
          <div className="workspace-card">
            <Notepad value={notes} onChange={onNotesChange} />
          </div>
          <div className="workspace-card">
            <SpeechCaption
              active={voiceStatus === "LISTENING" && !voiceMuted}
              interim={captionInterim}
              lines={captionLines}
            />
          </div>
        </aside>
      </div>

      {confirmingEnd && (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeEndDialog}>
          <section ref={endDialogRef} tabIndex={-1} className="end-dialog" role="dialog" aria-modal="true" aria-labelledby="end-title" onMouseDown={(event) => event.stopPropagation()}>
            <span className="dialog-kicker">Complete this session?</span>
            <h2 id="end-title">Your report will use everything captured so far.</h2>
            <p>You can&apos;t return to the live interview after ending it. Your latest code and notes will be saved first.</p>
            <div className="dialog-actions">
              <button data-autofocus className="secondary-button" onClick={closeEndDialog}>Keep interviewing</button>
              <button className="danger-button" onClick={onEnd} disabled={ending}>{ending ? "Saving final inputs…" : "Complete and view report"}</button>
            </div>
          </section>
        </div>
      )}

      {reportingProblem && (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeSupportDialog}>
          <section ref={supportDialogRef} tabIndex={-1} className="end-dialog support-dialog" role="dialog" aria-modal="true" aria-labelledby="support-title" onMouseDown={(event) => event.stopPropagation()}>
            <span className="dialog-kicker">Private diagnostic report</span>
            <h2 id="support-title">Report a problem</h2>
            {supportState === "SENT" ? <>
              <p role="status">Your report was saved. Reference: <code>{supportReference}</code></p>
              <p>The diagnostic record expires after 30 days.</p>
              <div className="dialog-actions"><button data-autofocus className="primary-button" onClick={closeSupportDialog}>Done</button></div>
            </> : <>
              <p>This sends connection, voice, stage, save-backlog, online, and page-visibility state. It never sends your code, notes, transcript, audio, device names, or free text.</p>
              <label htmlFor="support-category">What stopped working?</label>
              <select data-autofocus id="support-category" value={supportCategory} onChange={(event) => setSupportCategory(event.target.value as SupportCategory)} disabled={supportState === "SENDING"}>
                <option value="VOICE">Voice or microphone</option>
                <option value="CONNECTION">Connection</option>
                <option value="SAVING">Code or notes saving</option>
                <option value="REPORT">Final report</option>
                <option value="OTHER">Something else</option>
              </select>
              {supportState === "ERROR" && <p className="support-error" role="alert">The report could not be saved. Retry, or use the Support page after the interview.</p>}
              <div className="dialog-actions">
                <button className="secondary-button" onClick={closeSupportDialog} disabled={supportState === "SENDING"}>Cancel</button>
                <button className="primary-button" onClick={sendProblemReport} disabled={supportState === "SENDING"}>{supportState === "SENDING" ? "Sending…" : "Send diagnostic report"}</button>
              </div>
            </>}
          </section>
        </div>
      )}
    </main>
  );
}
