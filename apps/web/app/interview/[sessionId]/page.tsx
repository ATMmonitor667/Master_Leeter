"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CueKind, RoomSnapshot, RunReport, Speaker } from "@master-leeter/contracts";
import { CodeEditor } from "../../../components/CodeEditor";
import { Brand } from "../../../components/Shell";
import { ThemeToggle } from "../../../components/Preferences";
import { InterviewerSignal, type SignalState } from "../../../components/signal/InterviewerSignal";
import { Button, Dialog } from "../../../components/ui/Primitives";
import { Icon } from "../../../components/ui/Icon";
import { SignInRequired } from "../../../lib/api-client";
import { LiveSession, type LiveState } from "../../../lib/live/live-session";
import { roomApi, RoomError } from "../../../lib/room-client";
import s from "./Room.module.css";

/**
 * The interview room. One room for both formats:
 *
 *   left rail   voice: presence orb, live captions, transcript
 *               chat:  message thread and composer
 *   right       problem card, code editor, test results
 *
 * In a voice interview the browser talks straight to the realtime model; this
 * page only renders what that conversation reports.
 */

interface Line { id: string; speaker: Speaker; text: string; pending?: boolean }

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export default function InterviewRoom({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const revision = useRef(0);
  const [notes, setNotes] = useState("");
  const [run, setRun] = useState<RunReport | null>(null);
  const [running, setRunning] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [started, setStarted] = useState(false);
  const [hintsUsed, setHintsUsed] = useState(0);
  const [showProblem, setShowProblem] = useState(true);
  const [bottomTab, setBottomTab] = useState<"tests" | "notes">("tests");
  const [mobileTab, setMobileTab] = useState<"talk" | "code">("talk");
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [debug, setDebug] = useState(false);

  // Voice
  const live = useRef<LiveSession | null>(null);
  const [voice, setVoice] = useState<LiveState | null>(null);
  // Chat
  const [thread, setThread] = useState<Line[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const retryTurn = useRef<{ requestId: string; text: string; cue?: CueKind } | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const sentRevision = useRef(-1);

  const fail = useCallback((error: unknown) => {
    if (error instanceof SignInRequired) {
      window.location.assign(`/login?next=${encodeURIComponent(`/interview/${sessionId}`)}`);
      return "";
    }
    return error instanceof Error ? error.message : "Something went wrong. Please retry.";
  }, [sessionId]);

  // ── Load / restore ────────────────────────────────────────────────────
  useEffect(() => {
    setDebug(new URLSearchParams(window.location.search).get("debug") === "1");
    try { setShowProblem(localStorage.getItem("ml-oral-only") !== "1"); } catch { /* default on */ }
    let active = true;
    roomApi.snapshot(sessionId).then((snapshot) => {
      if (!active) return;
      if (snapshot.ended) { window.location.replace(`/report/${sessionId}`); return; }
      setRoom(snapshot);
      setCode(snapshot.code?.text ?? snapshot.problem.starterCode);
      revision.current = snapshot.code?.revision ?? 0;
      sentRevision.current = snapshot.code?.revision ?? -1;
      setNotes(snapshot.notes);
      setRun(snapshot.lastRun);
      setRemaining(snapshot.remainingSeconds);
      setStarted(snapshot.started);
      setHintsUsed(snapshot.hintsUsed);
      const lines = snapshot.transcript.map((t) => ({ id: `s${t.seq}`, speaker: t.speaker, text: t.text }));
      if (snapshot.format === "CHAT") setThread(lines);
      else {
        const session = new LiveSession({
          mint: (handle) => roomApi.mint(sessionId, handle),
          upload: (events) => roomApi.upload(sessionId, events),
          reactToRuns: snapshot.style === "SUPPORTIVE",
          initialLines: lines,
          started: snapshot.started,
        });
        live.current = session;
        session.subscribe(setVoice);
        if (snapshot.code) session.setCode(snapshot.code.revision, snapshot.code.text);
      }
    }).catch((error) => { if (active) setLoadError(fail(error) || null); });
    return () => { active = false; live.current?.dispose(); live.current = null; };
  }, [sessionId, fail]);

  const isVoice = room?.format === "VOICE";
  const voiceStarted = voice?.started ?? false;
  const liveStarted = isVoice ? voiceStarted : started;

  // ── Clock and time cues ───────────────────────────────────────────────
  const cued = useRef({ five: false, wrap: false, ended: false });
  useEffect(() => {
    if (!liveStarted || !room) return;
    const timer = setInterval(() => setRemaining((value) => Math.max(0, value - 1)), 1_000);
    return () => clearInterval(timer);
  }, [liveStarted, room]);

  const sendCue = useCallback((kind: CueKind, n?: number) => {
    if (!room) return;
    if (room.format === "VOICE") live.current?.cue(kind, n);
    else void chatTurn("", kind);
  }, [room]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!liveStarted || !room || room.expectedSeconds < 600) return;
    if (remaining <= 300 && remaining > 240 && !cued.current.five) { cued.current.five = true; sendCue("TIME", 5); }
    if (remaining <= 45 && remaining > 0 && !cued.current.wrap) { cued.current.wrap = true; sendCue("TIME", 0); }
    if (remaining === 0 && !cued.current.ended) { cued.current.ended = true; void finish(); }
  }, [remaining, liveStarted, room, sendCue]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Code ──────────────────────────────────────────────────────────────
  const onCode = useCallback((text: string) => {
    setCode(text);
    revision.current += 1;
    live.current?.setCode(revision.current, text);
  }, []);

  const runTests = useCallback(async () => {
    if (running) return;
    setRunning(true); setNotice(null); setBottomTab("tests");
    try {
      const report = await roomApi.run(sessionId, code, revision.current);
      setRun(report);
      if (isVoice) live.current?.runFinished(report.summary);
      else sentRevision.current = revision.current; // the run stored this revision
    } catch (error) { setNotice(fail(error) || null); }
    finally { setRunning(false); }
  }, [running, sessionId, code, isVoice, fail]);

  // ── Chat ──────────────────────────────────────────────────────────────
  async function chatTurn(text: string, cue?: CueKind, existing?: { requestId: string }) {
    if (busy) return;
    const requestId = existing?.requestId ?? crypto.randomUUID();
    retryTurn.current = { requestId, text, ...(cue ? { cue } : {}) };
    setBusy(true); setChatError(null);
    const replyId = `r-${requestId}`;
    setThread((lines) => [
      ...lines.filter((line) => line.id !== replyId && line.id !== `c-${requestId}`),
      ...(text ? [{ id: `c-${requestId}`, speaker: "CANDIDATE" as const, text }] : []),
      { id: replyId, speaker: "INTERVIEWER" as const, text: "", pending: true },
    ]);
    try {
      const attach = revision.current !== sentRevision.current && code.trim() !== "";
      const snapshot = await roomApi.chat(sessionId, {
        requestId, text, ...(cue ? { cue } : {}),
        ...(attach ? { code: { revision: revision.current, text: code } } : {}),
      }, (piece) => setThread((lines) => lines.map((line) => line.id === replyId ? { ...line, text: line.text + piece } : line)));
      if (attach) sentRevision.current = revision.current;
      retryTurn.current = null;
      setThread(snapshot.transcript.map((t) => ({ id: `s${t.seq}`, speaker: t.speaker, text: t.text })));
      setStarted(snapshot.started);
      setHintsUsed(snapshot.hintsUsed);
      if (cue === "START") setRemaining(snapshot.remainingSeconds);
      if (text) setDraft((current) => (current.trim() === text ? "" : current));
    } catch (error) {
      setThread((lines) => lines.filter((line) => line.id !== replyId));
      if (error instanceof RoomError && error.code === "SESSION_ENDED") { window.location.assign(`/report/${sessionId}`); return; }
      setChatError(fail(error) || null);
    } finally { setBusy(false); }
  }

  // ── Buttons shared by both formats ────────────────────────────────────
  const hintsLeft = room ? Math.max(0, room.hintsAllowed - hintsUsed) : 0;
  function hint() {
    if (!room || hintsLeft === 0) return;
    const n = hintsUsed + 1;
    setHintsUsed(n);
    sendCue("HINT", n);
  }

  async function finish() {
    if (ending) return;
    setEnding(true);
    try {
      if (notes.trim()) {
        await roomApi.upload(sessionId, [{ type: "NOTES", id: crypto.randomUUID(), text: notes.slice(0, 20_000), at: new Date().toISOString() }]).catch(() => {});
      }
      if (live.current) {
        live.current.setCode(revision.current, code);
        await live.current.stop();
      } else if (revision.current !== sentRevision.current && code.trim()) {
        await roomApi.upload(sessionId, [{ type: "CODE", id: crypto.randomUUID(), revision: revision.current, text: code, at: new Date().toISOString() }]).catch(() => {});
      }
      await roomApi.end(sessionId);
      window.location.assign(`/report/${sessionId}`);
    } catch (error) {
      setEnding(false); setConfirmEnd(false);
      setNotice(fail(error) || "The interview could not be ended. Retry.");
    }
  }

  // Ctrl+M toggles "thinking quietly"; Ctrl+Enter runs the tests.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "m" && live.current && voice) { event.preventDefault(); live.current.setMuted(!voice.muted); }
      if (event.key === "Enter" && !(event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); void runTests(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [voice, runTests]);

  const levels = useMemo(() => () => live.current?.levels() ?? { input: 0, output: 0 }, []);
  const scroller = useRef<HTMLDivElement>(null);
  const lines: Line[] = isVoice ? (voice?.lines ?? []) : thread;
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [lines.length, voice?.caption?.text, thread.at(-1)?.text]);

  if (loadError) {
    return (
      <div className={s.blocked}>
        <Brand />
        <h1>This interview can't be opened</h1>
        <p role="alert">{loadError}</p>
        <div className={s.row}><a className={s.link} href="/start">Start a new interview</a><a className={s.link} href="/history">History</a></div>
      </div>
    );
  }
  if (!room) return <div className={s.blocked} aria-busy="true"><Brand /><p>Opening the room…</p></div>;

  const status: SignalState = voice?.status ?? "idle";
  const connected = isVoice ? ["ready", "listening", "thinking", "speaking"].includes(status) : true;

  return (
    <div className={s.room} data-mobile={mobileTab} data-speaking={status === "speaking"}>
      <header className={s.top}>
        <div className={s.topLeft}>
          <Brand />
          <span className={s.badge}>{isVoice ? "Voice" : "Chat"} · {room.style.toLowerCase()}</span>
        </div>
        {isVoice && <div className={s.topCenter}><InterviewerSignal state={status} levels={levels} /></div>}
        <div className={s.topRight}>
          <div className={s.timer} aria-label={`${Math.floor(remaining / 60)} minutes ${remaining % 60} seconds remaining`}>
            <span>{clock(remaining)}</span><small>{liveStarted ? "remaining" : "not started"}</small>
          </div>
          {isVoice && voice && connected && (
            <Button size="sm" variant={voice.muted ? "primary" : "secondary"} aria-pressed={voice.muted}
              onClick={() => live.current?.setMuted(!voice.muted)} title="Stop sending audio so you can think aloud privately (Ctrl+M)">
              <Icon name={voice.muted ? "mic-off" : "mic"} /> {voice.muted ? "Thinking quietly" : "Mic on"}
            </Button>
          )}
          <ThemeToggle />
          <Button size="sm" variant="danger" onClick={() => setConfirmEnd(true)}>End</Button>
        </div>
      </header>

      {isVoice && status === "reconnecting" && <div className={s.strip} role="status">Reconnecting voice… Your code is still editable. This can take up to a minute.</div>}
      {notice && <div className={s.strip} data-kind="error" role="alert">{notice} <button onClick={() => setNotice(null)}>Dismiss</button></div>}

      <nav className={s.mobileTabs} aria-label="Room sections">
        <button aria-pressed={mobileTab === "talk"} onClick={() => setMobileTab("talk")}>Conversation</button>
        <button aria-pressed={mobileTab === "code"} onClick={() => setMobileTab("code")}>Code</button>
      </nav>

      <div className={s.body}>
        {/* ── Left rail: the conversation ─────────────────────────────── */}
        <aside className={s.rail} aria-label="Conversation">
          {isVoice && (
            <div className={s.presence}>
              <InterviewerSignal state={status} size={88} levels={levels} showHelper />
              {(status === "idle" || status === "failed") && (
                <div className={s.join}>
                  {voice?.error && <p role="alert" className={s.error}>{voice.error}</p>}
                  <Button variant="primary" onClick={() => void live.current?.connect()}>
                    <Icon name="mic" /> {status === "failed" ? "Retry" : "Connect microphone"}
                  </Button>
                  <small>Your browser will ask for microphone access. Audio goes to the voice model and is not recorded here.</small>
                </div>
              )}
              {status === "ready" && (
                <div className={s.join}>
                  <Button variant="primary" size="lg" onClick={() => { live.current?.begin(); }}>Start interview</Button>
                  <small>The interviewer will greet you and present the problem. The {Math.round(room.expectedSeconds / 60)}-minute clock starts now.</small>
                </div>
              )}
              {voice?.stalled && (
                <p className={s.stalled} role="alert">The interviewer didn't respond. <button onClick={() => live.current?.retry()}>Retry</button></p>
              )}
            </div>
          )}

          <div className={s.thread} ref={scroller} tabIndex={0} aria-label="Transcript" aria-live="off">
            {!lines.length && !voice?.caption && (
              <p className={s.empty}>
                {isVoice ? "What you and the interviewer say appears here." : started ? "" : "Press Start to receive the problem."}
              </p>
            )}
            {lines.map((line) => (
              <div key={line.id} className={s.line} data-speaker={line.speaker}>
                <small>{line.speaker === "INTERVIEWER" ? "Interviewer" : "You"}</small>
                <p>{line.text || (line.pending ? <span className={s.typing} aria-label="Interviewer is typing"><i /><i /><i /></span> : null)}</p>
              </div>
            ))}
            {isVoice && voice?.caption && (
              <div className={s.line} data-speaker={voice.caption.speaker} data-live="true">
                <small>{voice.caption.speaker === "INTERVIEWER" ? "Interviewer" : "You"}</small>
                <p>{voice.caption.text}</p>
              </div>
            )}
          </div>

          {!isVoice && !started && (
            <div className={s.join}>
              {chatError && <p role="alert" className={s.error}>{chatError}</p>}
              <Button variant="primary" size="lg" loading={busy} onClick={() => void chatTurn("", "START", retryTurn.current ?? undefined)}>Start interview</Button>
              <small>The {Math.round(room.expectedSeconds / 60)}-minute clock starts when the interviewer presents the problem.</small>
            </div>
          )}

          {liveStarted && (
            <div className={s.chips}>
              <button onClick={hint} disabled={hintsLeft === 0 || busy || !connected} title="Ask for the next hint">
                Hint <span>{hintsLeft} left</span>
              </button>
              <button onClick={() => sendCue("REPEAT")} disabled={busy || !connected}>Repeat problem</button>
              <button onClick={() => sendCue("DONE")} disabled={busy || !connected}>I'm done with this part</button>
            </div>
          )}

          {liveStarted && (
            <form className={s.composer} onSubmit={(event) => {
              event.preventDefault();
              const text = draft.trim();
              if (!text) return;
              if (isVoice) { live.current?.typed(text); setDraft(""); }
              else void chatTurn(text);
            }}>
              {chatError && (
                <p role="alert" className={s.error}>{chatError}{" "}
                  {retryTurn.current && <button type="button" onClick={() => { const t = retryTurn.current!; void chatTurn(t.text, t.cue, t); }}>Retry</button>}
                </p>
              )}
              <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={isVoice ? 1 : 3}
                placeholder={isVoice ? "Type instead of speaking…" : "Message the interviewer. Enter sends, Shift+Enter adds a line."}
                aria-label={isVoice ? "Type instead of speaking" : "Message the interviewer"}
                disabled={!connected}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
              <Button type="submit" variant="primary" size="sm" disabled={!draft.trim() || busy || !connected}>Send</Button>
            </form>
          )}
          {!isVoice && liveStarted && <p className={s.sees}>The interviewer can see your code (rev {revision.current}).</p>}
        </aside>

        {/* ── Right: problem, code, tests ─────────────────────────────── */}
        <section className={s.work} aria-label="Workspace">
          <details className={s.problem} open={showProblem && liveStarted} onToggle={(event) => {
            const open = (event.currentTarget as HTMLDetailsElement).open;
            if (liveStarted) { setShowProblem(open); try { localStorage.setItem("ml-oral-only", open ? "0" : "1"); } catch { /* not persisted */ } }
          }}>
            <summary>
              <span>Problem</span>
              <small>{liveStarted ? (showProblem ? "Hide for oral-only practice" : "Hidden: oral only. Click to show.") : "Shown once the interview starts"}</small>
            </summary>
            {liveStarted && (
              <div className={s.problemBody}>
                <p>{room.problem.writtenBrief}</p>
                <pre className={s.signature}>{room.problem.starterCode.split("\n")[0]}</pre>
                {room.problem.constraints.length > 0 && <ul>{room.problem.constraints.map((c, i) => <li key={i}>{c}</li>)}</ul>}
                <div className={s.examples}>
                  {room.problem.examples.map((example, i) => (
                    <div key={i}>
                      <code>{example.input}</code><span aria-hidden> → </span><code>{example.output}</code>
                      {example.note && <small>{example.note}</small>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </details>

          <div className={s.editor}>
            <CodeEditor value={code} language={room.language} onChange={onCode} saveState="saved" />
          </div>

          <div className={s.bottom}>
            <div className={s.bottomBar}>
              <div role="tablist" className={s.tabs}>
                <button role="tab" aria-selected={bottomTab === "tests"} onClick={() => setBottomTab("tests")}>Tests</button>
                <button role="tab" aria-selected={bottomTab === "notes"} onClick={() => setBottomTab("notes")}>Notes</button>
              </div>
              <Button size="sm" variant="primary" loading={running} onClick={() => void runTests()} title="Run the tests (Ctrl+Enter)">
                <Icon name="play" /> {running ? "Running…" : `Run ${room.problem.totalTests} tests`}
              </Button>
            </div>
            {bottomTab === "notes" ? (
              <textarea className={s.notes} value={notes} onChange={(event) => setNotes(event.target.value)} spellCheck={false}
                aria-label="Private notes" placeholder="Private notes: constraints, examples, complexity…" />
            ) : (
              <RunPanel run={run} running={running} />
            )}
          </div>
        </section>
      </div>

      {debug && voice && (
        <div className={s.debug} aria-hidden>
          speech end → first audio · last {voice.latency.last ?? "–"} ms · p50 {voice.latency.p50 ?? "–"} · p95 {voice.latency.p95 ?? "–"} · {voice.latency.turns} turns · {status}
        </div>
      )}

      {confirmEnd && (
        <Dialog title="End this interview?" onClose={() => setConfirmEnd(false)}>
          <p>Your code and the conversation are saved and your report is prepared. You can't reopen the room afterwards.</p>
          <div className={s.row}>
            <Button onClick={() => setConfirmEnd(false)} disabled={ending}>Keep going</Button>
            <Button variant="danger" loading={ending} onClick={() => void finish()}>End interview</Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function RunPanel({ run, running }: { run: RunReport | null; running: boolean }) {
  if (running && !run) return <p className={s.runEmpty}>Running your code against the tests…</p>;
  if (!run) return <p className={s.runEmpty}>Run the tests to see results here. Hidden tests report pass or fail only.</p>;
  return (
    <div className={s.run} data-status={run.status} aria-live="polite">
      <div className={s.runHead}>
        <strong>{run.status === "PASSED" ? "All tests passed" : run.status === "ERROR" ? "The code did not run" : `${run.passed} of ${run.total} passed`}</strong>
        <small>rev {run.revision} · {run.method === "EXECUTED" ? "executed in a sandbox" : "predicted by a model, not executed — may be wrong"}</small>
      </div>
      {run.stderr && <pre className={s.stderr}>{run.stderr}</pre>}
      <ol className={s.cases}>
        {run.outcomes.map((outcome) => (
          <li key={outcome.index} data-passed={outcome.passed}>
            <span className={s.verdict}>{outcome.passed ? "Pass" : "Fail"}</span>
            {outcome.hidden ? <span className={s.hidden}>Hidden test {outcome.index + 1}</span> : (
              <span className={s.case}>
                <code>{outcome.input}</code>
                {!outcome.passed && <small>{outcome.error ? `raised ${outcome.error}` : `got ${outcome.got}`} · expected {outcome.expected}</small>}
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
