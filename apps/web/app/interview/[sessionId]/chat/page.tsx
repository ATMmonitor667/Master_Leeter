"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import type { ChatInput, ChatReviewInput, ChatSnapshot } from "@master-leeter/contracts";
import { CodeEditor } from "../../../../components/CodeEditor";
import { Timer } from "../../../../components/Timer";
import { ThemeToggle } from "../../../../components/Preferences";
import { apiFetch, SignInRequired } from "../../../../lib/api-client";
import { chatRequest, ChatRequestError } from "../../../../lib/chat-client";
import styles from "./Chat.module.css";

const STARTER = "# Write your Python solution here.\n";

/** Display-only stage, derived from the durable turn log. */
function stageOf(snapshot: ChatSnapshot): string {
  if (snapshot.ended) return "Complete";
  if (!snapshot.turns.length) return "Ready";
  if (snapshot.phase === "RESUME") return "Resume discussion";
  if (snapshot.requirements.length) return `Follow-up ${snapshot.requirements.length}`;
  const coding = snapshot.turns.filter((t) => t.phase === "CODING");
  if (coding.some((t) => t.code !== undefined)) return "Testing & complexity";
  if (coding.some((t) => t.kind === "THOUGHTS")) return "Approach";
  return "Clarification";
}
export default function ChatInterviewPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null);
  const [message, setMessage] = useState("");
  const [thoughts, setThoughts] = useState("");
  const [code, setCode] = useState(STARTER);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<ChatInput | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [loading, setLoading] = useState(true);
  const [timeUp, setTimeUp] = useState(false);
  const [question, setQuestion] = useState("");
  const [reviewRetry, setReviewRetry] = useState<ChatReviewInput | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const locked = useRef(false);
  const startedRun = useRef(0);

  const handleError = useCallback((cause: unknown) => {
    if (cause instanceof SignInRequired) {
      window.location.assign(`/login?next=${encodeURIComponent(`/interview/${sessionId}/chat`)}`);
      return;
    }
    setError(cause instanceof Error ? cause.message : "Connection failed. Your draft is still here.");
  }, [sessionId]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      // The interview opens on a Ready screen; nothing starts until Start.
      const next = await chatRequest(sessionId, "read");
      setSnapshot(next);
      const submittedCode = [...next.turns].reverse().find((t) => t.code !== undefined)?.code;
      if (submittedCode !== undefined) setCode(submittedCode);
    } catch (cause) { handleError(cause); }
    finally { setLoading(false); }
  }, [sessionId, handleError]);
  useEffect(() => { void load(); }, [load]);
  // The server rejects writes after the deadline; mirror that locally so the
  // candidate is told to finish instead of composing a message that will fail.
  useEffect(() => {
    if (!snapshot || snapshot.ended) { setTimeUp(false); return; }
    const deadline = Date.now() + snapshot.remainingSeconds * 1000;
    const check = () => setTimeUp(snapshot.turns.length > 0 && Date.now() >= deadline);
    check();
    const timer = setInterval(check, 1_000);
    return () => clearInterval(timer);
  }, [snapshot]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest" }); }, [snapshot?.turns.length, busy]);
  // Background refresh catches run results, other tabs, and server-owned expiry.
  useEffect(() => {
    if (!snapshot || snapshot.ended) return;
    let active = true;
    const timer = setInterval(() => {
      if (locked.current) return;
      void chatRequest(sessionId, "read").then((next) => {
        if (!active || locked.current) return;
        setSnapshot(next);
        if (runId && next.runs.some((r) => r.runId === runId)) setRunId(null);
        if (runId && Date.now() - startedRun.current > 60_000) {
          setRunId(null); setError("Run feedback timed out. You can continue your interview or try again.");
        }
      }).catch(() => { /* Explicit requests surface connection errors. */ });
    }, runId ? 1_500 : 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [sessionId, snapshot?.ended, Boolean(snapshot), runId]);

  async function begin() {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(null);
    try { setSnapshot(await chatRequest(sessionId, "start")); }
    catch (cause) { handleError(cause); }
    finally { locked.current = false; setBusy(false); }
  }

  async function submitReview(kind: ChatReviewInput["kind"], existing?: ChatReviewInput) {
    if (!snapshot || locked.current) return;
    const submission: ChatReviewInput = existing ?? { requestId: crypto.randomUUID(), turn: snapshot.review.length,
      kind, text: kind === "QUESTION" ? question.trim() : "" };
    locked.current = true; setBusy(true); setError(null); setReviewRetry(submission);
    try {
      setSnapshot(await chatRequest(sessionId, "review", submission)); setReviewRetry(null);
      if (submission.kind === "QUESTION") setQuestion((draft) => draft.trim() === submission.text ? "" : draft);
    } catch (cause) {
      handleError(cause);
      if (cause instanceof ChatRequestError && ["CHAT_STALE_TURN", "CHAT_REQUEST_CONFLICT", "INVALID_CHAT_PHASE", "REVIEW_NOT_AVAILABLE", "CHAT_TURN_LIMIT"].includes(cause.code)) {
        setReviewRetry(null);
        try { setSnapshot(await chatRequest(sessionId, "read")); } catch { /* Preserve draft and original error. */ }
      }
    } finally { locked.current = false; setBusy(false); }
  }

  async function submit(kind: ChatInput["kind"], existing?: ChatInput) {
    if (!snapshot || snapshot.ended || locked.current) return;
    const text = kind === "THOUGHTS" ? thoughts : kind === "CODE" ? "Here is my implementation." :
      kind === "START_CODING" ? "I'm ready for the coding problem." : kind === "HINT" ? "I'd like a hint." :
      kind === "DONE" ? "I'm done with this part." : message;
    const submission: ChatInput = existing ?? { requestId: crypto.randomUUID(), turn: snapshot.nextTurn,
      kind, text: text.trim(), ...(kind === "CODE" ? { code } : {}) };
    locked.current = true; setBusy(true); setError(null); setRetry(submission);
    try {
      const next = await chatRequest(sessionId, "turn", submission);
      setSnapshot(next); setRetry(null);
      // Only clear a draft that still matches what was sent; edits survive.
      if (submission.kind === "MESSAGE") setMessage((draft) => draft.trim() === submission.text ? "" : draft);
      if (submission.kind === "THOUGHTS") setThoughts((draft) => draft.trim() === submission.text ? "" : draft);
    } catch (cause) {
      handleError(cause);
      if (cause instanceof ChatRequestError && ["CHAT_STALE_TURN", "SESSION_ENDED", "CHAT_REQUEST_CONFLICT", "INVALID_CHAT_INPUT", "INVALID_CHAT_PHASE", "CHAT_TURN_LIMIT"].includes(cause.code)) {
        setRetry(null);
        try { setSnapshot(await chatRequest(sessionId, "read")); } catch { /* Preserve draft and original error. */ }
      }
    } finally { locked.current = false; setBusy(false); }
  }

  // Dropping a failed submission is safe: if the server did save it, the turn
  // number makes any new submission stale and the reload shows the saved turn.
  async function discardRetry() {
    setRetry(null); setReviewRetry(null); setError(null);
    try { setSnapshot(await chatRequest(sessionId, "read")); } catch (cause) { handleError(cause); }
  }

  async function runCode() {
    if (!snapshot || locked.current || runId) return;
    setError(null); locked.current = true; setBusy(true);
    try {
      const response = await apiFetch(`/v1/interview-sessions/${sessionId}/runs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: code, revision: snapshot.nextTurn, input }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Run feedback is unavailable. You can still submit and discuss your code.");
      setRunId(result.runId); startedRun.current = Date.now();
    } catch (cause) { handleError(cause); }
    finally { locked.current = false; setBusy(false); }
  }

  async function finish() {
    if (locked.current || runId) return;
    locked.current = true; setBusy(true); setError(null);
    try {
      const response = await apiFetch(`/v1/interview-sessions/${sessionId}/end`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ finalClientSeq: -1 }),
      });
      if (!response.ok) throw new Error("Couldn't finish the interview. Please retry.");
      setSnapshot(await chatRequest(sessionId, "read")); setConfirmEnd(false); setRetry(null);
    } catch (cause) { handleError(cause); }
    finally { locked.current = false; setBusy(false); }
  }

  const disabled = busy || loading || !snapshot || snapshot.ended || timeUp;
  const coding = snapshot?.phase === "CODING";
  const ready = Boolean(snapshot && !snapshot.ended && !snapshot.turns.length);
  const savedCode = snapshot?.turns.filter((t) => t.code !== undefined).at(-1)?.code;
  return <main className={styles.page}>
    <header className={styles.header}>
      <div><a href="/history" className={styles.brand}>Master Leeter</a><span className={styles.badge}>CHAT INTERVIEW</span>
        <p>{snapshot?.focus === "RESUME" ? "Your experience, in your own words." : "Ask. Think it through. Build your solution."}</p></div>
      <div className={styles.actions}><ThemeToggle /><Timer remainingSeconds={snapshot?.remainingSeconds ?? 0}
        running={Boolean(snapshot && !snapshot.ended && snapshot.turns.length)} ready={Boolean(snapshot)} />
        {snapshot?.ended ? <a href="/start" className="primary-button">New interview</a> : ready ? null :
          <button className="secondary-button" disabled={busy || loading || !snapshot || Boolean(runId)} onClick={() => setConfirmEnd(true)}>Finish interview</button>}</div>
    </header>
    {error && <div role="alert" className={styles.error}>{error}
      {retry && <button disabled={busy} onClick={() => void submit(retry.kind, retry)}>Retry submission</button>}
      {reviewRetry && <button disabled={busy} onClick={() => void submitReview(reviewRetry.kind, reviewRetry)}>Retry</button>}
      {(retry || reviewRetry) && <button disabled={busy} onClick={() => void discardRetry()}>Edit instead</button>}
      {!snapshot && <button disabled={loading} onClick={() => void load()}>Reload interview</button>}
    </div>}
    {confirmEnd && <section className={styles.confirm} aria-label="Confirm finish">
      <p>Finish this interview? Submitted messages and code will be saved. Unsubmitted drafts are not included.</p>
      <button className="primary-button" disabled={busy} onClick={() => void finish()}>Finish and save conversation</button>
      <button className="secondary-button" disabled={busy} onClick={() => setConfirmEnd(false)}>Keep working</button>
    </section>}
    {timeUp && !confirmEnd && <p role="status" className={styles.notice}>Time is up. Finish the interview to save your conversation.
      <button className="primary-button" disabled={busy} onClick={() => setConfirmEnd(true)}>Finish interview</button></p>}
    {snapshot?.ended && <p role="status" className={styles.notice}>Interview complete. Your conversation is saved below.
      {snapshot.scored ? <> Your scorecard is prepared separately from the interview. <a className="secondary-button" href={`/report/${sessionId}`}>View scorecard</a></>
        : " Resume interviews provide a saved transcript, without an automated score."}</p>}
    {ready && snapshot && <section className={styles.ready} aria-labelledby="ready-title">
      <h1 id="ready-title">Your interview is ready.</h1>
      <p>{snapshot.focus === "RESUME" ? "The interviewer will ask about the resume facts you confirmed."
        : snapshot.focus === "COMBINED" ? "You'll start by discussing your experience, then move to a coding problem when you choose."
        : "The interviewer will present a problem. Ask clarifying questions, explain your approach, then implement and test it."}</p>
      <dl><div><dt>Length</dt><dd>{Math.round(snapshot.expectedSeconds / 60)} minutes</dd></div>
        <div><dt>Format</dt><dd>Text · no microphone</dd></div></dl>
      <p>The clock starts when you press Start. Follow-up requirements appear only after your base solution is working.</p>
      <button className="primary-button" disabled={busy || loading} onClick={() => void begin()}>{busy ? "Starting…" : "Start interview"}</button>
    </section>}
    {snapshot && !ready && !snapshot.ended && snapshot.phase === "CODING" && <section className={styles.status} aria-label="Interview status">
      <span><strong>Stage</strong> {stageOf(snapshot)}</span>
      <span><strong>Follow-ups</strong> {snapshot.requirements.length} presented</span>
      {snapshot.requirements.length > 0 && <details><summary>Current requirements</summary>
        <ol>{snapshot.requirements.map((r, i) => <li key={i}>{r}</li>)}</ol></details>}
    </section>}
    {snapshot && !snapshot.available && !snapshot.ended && <p className={styles.notice}>The text model is unavailable. The problem and saved conversation are still readable; open-ended submissions will need the administrator to configure the chat model.</p>}
    {!ready && <div className={styles.workspace}>
      <section className={styles.work} aria-label="Your workspace">
        <div className={styles.workHeading}><h1>{coding ? "Solution workspace" : "Your experience"}</h1>
          <span>{coding ? "Python" : "Resume discussion"}</span></div>
        <div className={styles.reasoning}>
          <label htmlFor="thoughts">{coding ? "Your thoughts & approach" : "Prepare your answer"}</label>
          <p>{coding ? "Explain assumptions, your plan, or a tradeoff. Submit whenever you want the interviewer to respond."
            : "Describe what you owned, a decision you made, and what happened. Submit your answer to discuss it."}</p>
          <textarea id="thoughts" maxLength={12000} value={thoughts} disabled={disabled}
            placeholder={coding ? "My approach is…" : "In this project, I was responsible for…"}
            onChange={(event) => setThoughts(event.target.value)} />
          <button className="primary-button" disabled={disabled || !thoughts.trim() || Boolean(retry)}
            onClick={() => void submit("THOUGHTS")}>{coding ? "Submit thoughts" : "Submit answer"}</button>
        </div>
        {coding ? <>
          <div className={styles.editor}><CodeEditor value={code} language="python" onChange={setCode}
            readOnly={Boolean(disabled)} saveState={code === savedCode ? "saved" : "draft"} /></div>
          <div className={styles.codeActions}><span>{code === savedCode ? "Submitted code saved" : "Code is shared when you submit it"}</span>
            <div><button className="secondary-button" disabled={disabled || !savedCode || Boolean(retry)} onClick={() => void submit("DONE")}
              title="The interviewer adds a new requirement once your submitted code has a passing run.">I'm done with this part</button>
            <button className="primary-button" disabled={disabled || !code.trim() || Boolean(retry)} onClick={() => void submit("CODE")}>Submit code</button></div></div>
          <details className={styles.runs}><summary>Run feedback</summary>
            <p>Model-estimated feedback; code is not executed. Verify results independently.</p>
            <label htmlFor="run-input">Test input</label><textarea id="run-input" maxLength={100000} value={input}
              disabled={disabled} onChange={(event) => setInput(event.target.value)} />
            <button className="secondary-button" disabled={disabled || Boolean(runId) || !code.trim()} onClick={() => void runCode()}>
              {runId ? "Estimating…" : "Estimate run result"}</button>
            {snapshot?.runs.map((run) => <article key={run.runId}><strong>{run.status.replaceAll("_", " ")}</strong>
              <pre>{run.stdout || run.stderr || "No output returned."}</pre></article>)}
          </details>
        </> : <div className={styles.guide}><h2>A useful answer has specifics.</h2><p>Explain the situation, your own contribution, the alternatives you considered, and the result. It's fine to say what you would change now.</p>
          {snapshot?.focus === "COMBINED" && <button className="secondary-button" disabled={disabled || Boolean(retry)} onClick={() => void submit("START_CODING")}>Start coding round →</button>}</div>}
      </section>
      <aside className={styles.chat} aria-label="Interview conversation">
        <div className={styles.chatHeading}><h2>Your interviewer</h2><span>{snapshot?.ended ? "Completed" : busy ? "Responding…" : "Text only · no microphone"}</span></div>
        <div className={styles.messages} role="log" aria-label="Chat messages" aria-live="polite" aria-relevant="additions">
          {loading && <p role="status">Preparing your interview…</p>}
          {snapshot?.turns.map((turn) => <div key={turn.turn}>
            {turn.kind !== "OPENING" && <article className={styles.candidate}><span>You · {turn.kind === "THOUGHTS" ? "Thoughts" : turn.kind === "CODE" ? "Code submission" : "Message"}</span>
              <p>{turn.text}</p>{turn.code !== undefined && <details><summary>Submitted code</summary><pre>{turn.code}</pre></details>}</article>}
            <article className={styles.interviewer}><span>Interviewer</span><p>{turn.reply}</p></article>
          </div>)}
          {snapshot?.ended && snapshot.review.length > 0 && <p className={styles.divider}>Post-interview review</p>}
          {snapshot?.review.map((turn) => <div key={`review-${turn.turn}`}>
            {turn.kind === "QUESTION" && <article className={styles.candidate}><span>You · Review question</span><p>{turn.text}</p></article>}
            <article className={styles.professor}><span>Professor</span><p>{turn.reply}</p></article>
          </div>)}
          {busy && <p className={styles.waiting} role="status">Working on your request…</p>}
          <div ref={endRef} />
        </div>
        {snapshot?.ended && snapshot.reviewAvailable && (snapshot.review.length === 0
          ? <div className={styles.composer}><p className={styles.reviewIntro}>Switch to teaching mode: see where your reasoning went right or wrong, a strong solution, and a framework you can reuse.</p>
            <button className="primary-button" disabled={busy || Boolean(reviewRetry)} onClick={() => void submitReview("DEBRIEF")}>Start review</button></div>
          : <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); if (question.trim()) void submitReview("QUESTION"); }}>
            <label htmlFor="review-question">Ask the professor about this interview</label>
            <textarea id="review-question" maxLength={4000} value={question} disabled={busy}
              placeholder="Where did my approach first go wrong?" onChange={(event) => setQuestion(event.target.value)} />
            <div><button className="primary-button" type="submit" disabled={busy || !question.trim() || Boolean(reviewRetry)}>Ask</button></div>
          </form>)}
        {!snapshot?.ended && <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); void submit("MESSAGE"); }}>
          <label htmlFor="chat-message">Ask a question or reply</label>
          <textarea id="chat-message" maxLength={12000} value={message} disabled={disabled}
            placeholder={coding ? "Can you clarify the input constraints?" : "My role in that project was…"}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !disabled && message.trim() && !retry) { event.preventDefault(); void submit("MESSAGE"); } }} />
          <div>{coding && <button type="button" className="ghost-button" disabled={disabled || Boolean(retry)} onClick={() => void submit("HINT")}>Ask for a hint</button>}
            <button className="primary-button" type="submit" disabled={disabled || !message.trim() || Boolean(retry)}>Send message</button></div>
          <small>Ctrl / ⌘ + Enter to send. Thinking quietly won't trigger a reply.</small>
        </form>}
      </aside>
    </div>}
  </main>;
}
