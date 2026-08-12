"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";

type Lang = "Python" | "JS" | "C++";
type Diff = "Easy" | "Medium" | "Hard";
type TokenKind = "kw" | "fn" | "num" | "p" | "cm";
type CodeLine = Array<[string, TokenKind]>;
type ChatMessage = { who: "ai" | "you"; text: string };

const TOKEN_COLOR: Record<TokenKind, string> = {
  kw: "#8f8bff",
  fn: "#7fe3c2",
  num: "#e0a0ff",
  p: "#cbd2e0",
  cm: "#4d5464",
};

const MONO = "var(--font-jetbrains-mono), ui-monospace, monospace";

const SNIPPETS: Record<Lang, CodeLine[]> = {
  Python: [
    [["def ", "kw"], ["two_sum", "fn"], ["(nums, target):", "p"]],
    [["    lo, hi = ", "p"], ["0", "num"], [", ", "p"], ["len", "fn"], ["(nums) - ", "p"], ["1", "num"]],
    [["    while ", "kw"], ["lo < hi:", "p"]],
    [["        s = nums[lo] + nums[hi]", "p"]],
    [["        if ", "kw"], ["s == target:", "p"]],
    [["            return ", "kw"], ["[lo + ", "p"], ["1", "num"], [", hi + ", "p"], ["1", "num"], ["]", "p"]],
    [["        elif ", "kw"], ["s < target:", "p"]],
    [["            lo += ", "p"], ["1", "num"]],
    [["        else", "kw"], [":", "p"]],
    [["            hi -= ", "p"], ["1", "num"]],
    [["    # O(n) time, O(1) space", "cm"]],
  ],
  JS: [
    [["function ", "kw"], ["twoSum", "fn"], ["(nums, target) {", "p"]],
    [["  let ", "kw"], ["lo = ", "p"], ["0", "num"], [", hi = nums.length - ", "p"], ["1", "num"], [";", "p"]],
    [["  while ", "kw"], ["(lo < hi) {", "p"]],
    [["    const ", "kw"], ["s = nums[lo] + nums[hi];", "p"]],
    [["    if ", "kw"], ["(s === target) ", "p"], ["return ", "kw"], ["[lo + ", "p"], ["1", "num"], [", hi + ", "p"], ["1", "num"], ["];", "p"]],
    [["    s < target ? lo++ : hi--;", "p"]],
    [["  }", "p"]],
    [["}", "p"]],
    [["// O(n) time, O(1) space", "cm"]],
  ],
  "C++": [
    [["vector", "fn"], ["<", "p"], ["int", "kw"], ["> twoSum(vector<", "p"], ["int", "kw"], [">& nums, ", "p"], ["int", "kw"], [" target) {", "p"]],
    [["    int ", "kw"], ["lo = ", "p"], ["0", "num"], [", hi = nums.size() - ", "p"], ["1", "num"], [";", "p"]],
    [["    while ", "kw"], ["(lo < hi) {", "p"]],
    [["        int ", "kw"], ["s = nums[lo] + nums[hi];", "p"]],
    [["        if ", "kw"], ["(s == target) ", "p"], ["return ", "kw"], ["{lo + ", "p"], ["1", "num"], [", hi + ", "p"], ["1", "num"], ["};", "p"]],
    [["        s < target ? lo++ : hi--;", "p"]],
    [["    }", "p"]],
    [["}", "p"]],
    [["    // O(n) time, O(1) space", "cm"]],
  ],
};

const SEED_CHAT: ChatMessage[] = [
  {
    who: "ai",
    text: "Walk me through your approach before you type. What's the invariant that lets you move the pointers?",
  },
  {
    who: "you",
    text: "Sorted array — if the sum is too big I shrink from the right.",
  },
];

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function segStyle(active: boolean): CSSProperties {
  return {
    fontFamily: MONO,
    fontSize: 11,
    padding: "5px 11px",
    borderRadius: 7,
    border: "none",
    cursor: "pointer",
    transition: "all .18s",
    background: active ? "rgba(127,227,194,.16)" : "transparent",
    color: active ? "#7fe3c2" : "#6b7385",
    boxShadow: active ? "inset 0 0 0 1px rgba(127,227,194,.35)" : "none",
  };
}

function Toggle({
  on,
  accent,
  onToggle,
}: {
  on: boolean;
  accent: "#7fe3c2" | "#8f8bff";
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      style={{
        width: 34,
        height: 19,
        borderRadius: 999,
        padding: 2,
        border: "none",
        cursor: "pointer",
        background: on ? accent : "rgba(255,255,255,.12)",
        transition: "background .2s",
        position: "relative",
      }}
    >
      <span
        style={{
          display: "block",
          width: 15,
          height: 15,
          borderRadius: "50%",
          background: "#08090c",
          transform: on ? "translateX(15px)" : "translateX(0)",
          transition: "transform .2s",
        }}
      />
    </button>
  );
}

/**
 * Interactive mock interview panel for the marketing landing page.
 * Static code only — no Monaco, no real execution.
 */
export function DemoCodePanel() {
  const [lang, setLang] = useState<Lang>("Python");
  const [diff, setDiff] = useState<Diff>("Medium");
  const [hints, setHints] = useState(true);
  const [voice, setVoice] = useState(true);
  const [seconds, setSeconds] = useState(1092);
  const [running, setRunning] = useState(false);
  const [chat, setChat] = useState<ChatMessage[]>(SEED_CHAT);

  useEffect(() => {
    const id = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const lines = SNIPPETS[lang];
  const ext = lang === "Python" ? "py" : lang === "JS" ? "js" : "cpp";
  const timerColor = seconds >= 1500 ? "#ff8b6b" : "#6b7385";

  const appendMessage = (msg: ChatMessage) => {
    setChat((prev) => [...prev.slice(-2), msg]);
  };

  const onRunTests = () => {
    if (running) return;
    setRunning(true);
    window.setTimeout(() => {
      appendMessage({
        who: "ai",
        text: "All 61 tests pass. Now: what breaks if the array isn't sorted, and what would you reach for instead?",
      });
      setRunning(false);
    }, 1100);
  };

  const onNudge = () => {
    appendMessage({
      who: "ai",
      text: "You're scanning every pair. The array is sorted — that's a fact you haven't spent yet.",
    });
  };

  const primaryBtn: CSSProperties = useMemo(
    () => ({
      flex: 1,
      fontFamily: MONO,
      fontSize: 13,
      color: "#08090c",
      background: "#7fe3c2",
      border: "none",
      borderRadius: 10,
      fontWeight: 600,
      padding: "10px 14px",
      cursor: running ? "not-allowed" : "pointer",
      opacity: running ? 0.7 : 1,
      transition: "transform .15s, box-shadow .25s",
    }),
    [running],
  );

  const ghostBtn: CSSProperties = {
    fontFamily: MONO,
    fontSize: 13,
    color: "#e6e8ee",
    background: "rgba(255,255,255,.04)",
    border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 10,
    padding: "10px 14px",
    cursor: "pointer",
    transition: "background .2s",
  };

  return (
    <div id="practice" className="mkt-floaty" style={{ position: "relative" }}>
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: -1,
          borderRadius: 18,
          background: "linear-gradient(140deg, rgba(127,227,194,.5), rgba(143,139,255,.35), transparent 70%)",
          filter: "blur(14px)",
          opacity: 0.5,
        }}
      />

      <div
        style={{
          position: "relative",
          border: "1px solid rgba(255,255,255,.1)",
          borderRadius: 16,
          background: "#0c0e13",
          overflow: "hidden",
          boxShadow: "0 30px 80px rgba(0,0,0,.6)",
        }}
      >
        {/* Title bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 14px",
            borderBottom: "1px solid rgba(255,255,255,.07)",
            background: "rgba(255,255,255,.02)",
          }}
        >
          <div style={{ display: "flex", gap: 7 }}>
            {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
              <span
                key={c}
                style={{ width: 10, height: 10, borderRadius: "50%", background: c, display: "block" }}
              />
            ))}
          </div>
          <span style={{ fontFamily: MONO, fontSize: 12, color: "#6b7385" }}>two_sum.{ext}</span>
          <div style={{ width: 52 }} />
        </div>

        {/* Controls */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            alignItems: "center",
            padding: "12px 14px",
            borderBottom: "1px solid rgba(255,255,255,.07)",
          }}
        >
          <div style={{ display: "flex", gap: 4, padding: 3, background: "rgba(255,255,255,.05)", borderRadius: 9 }}>
            {(["Python", "JS", "C++"] as Lang[]).map((l) => (
              <button key={l} type="button" style={segStyle(lang === l)} onClick={() => setLang(l)}>
                {l}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 4, padding: 3, background: "rgba(255,255,255,.05)", borderRadius: 9 }}>
            {(["Easy", "Medium", "Hard"] as Diff[]).map((d) => (
              <button key={d} type="button" style={segStyle(diff === d)} onClick={() => setDiff(d)}>
                {d}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
            <span style={{ fontFamily: MONO, fontSize: 11, color: "#6b7385" }}>hints</span>
            <Toggle on={hints} accent="#7fe3c2" onToggle={() => setHints((h) => !h)} />
            <span style={{ fontFamily: MONO, fontSize: 11, color: "#6b7385", marginLeft: 8 }}>voice</span>
            <Toggle on={voice} accent="#8f8bff" onToggle={() => setVoice((v) => !v)} />
          </div>
        </div>

        {/* Code */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "34px 1fr",
            fontFamily: MONO,
            fontSize: 13,
            lineHeight: 1.75,
            padding: "16px 14px 18px",
            minHeight: 250,
          }}
        >
          <div style={{ color: "#3a4050", textAlign: "right", paddingRight: 12 }}>
            {lines.map((_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <div style={{ color: "#cbd2e0" }}>
            {lines.map((line, i) => (
              <div key={i} style={{ whiteSpace: "pre" }}>
                {line.map(([text, kind], j) => (
                  <span key={j} style={{ color: TOKEN_COLOR[kind] }}>
                    {text}
                  </span>
                ))}
              </div>
            ))}
            <span
              className="mkt-blink"
              style={{
                display: "inline-block",
                width: 8,
                height: 16,
                background: "#7fe3c2",
                verticalAlign: -3,
              }}
            />
          </div>
        </div>

        {/* Interviewer footer */}
        <div
          style={{
            borderTop: "1px solid rgba(255,255,255,.07)",
            background: "rgba(255,255,255,.02)",
            padding: 14,
          }}
        >
          <div style={{ display: "flex", gap: 10, marginBottom: 12, alignItems: "center" }}>
            <span
              style={{
                width: 22,
                height: 22,
                borderRadius: 7,
                background: "linear-gradient(140deg, #7fe3c2, #8f8bff)",
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontFamily: MONO,
                fontSize: 12,
                color: "#6b7385",
                letterSpacing: ".08em",
                textTransform: "uppercase",
              }}
            >
              interviewer
            </span>
            <span style={{ flex: 1, height: 1, background: "rgba(255,255,255,.07)" }} />
            <span style={{ fontFamily: MONO, fontSize: 12, color: timerColor }}>{formatTime(seconds)}</span>
          </div>

          {chat.map((msg, i) => (
            <div
              key={i}
              style={{
                fontSize: 13.5,
                lineHeight: 1.6,
                padding: "11px 13px",
                borderRadius: 11,
                marginBottom: 8,
                textWrap: "pretty" as const,
                color: msg.who === "ai" ? "#cbd2e0" : "#9aa1b1",
                background: msg.who === "ai" ? "rgba(143,139,255,.08)" : "rgba(255,255,255,.035)",
                border:
                  msg.who === "ai"
                    ? "1px solid rgba(143,139,255,.16)"
                    : "1px solid rgba(255,255,255,.07)",
              }}
            >
              {msg.text}
            </div>
          ))}

          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button type="button" style={primaryBtn} disabled={running} onClick={onRunTests}>
              {running ? "running tests…" : "run tests  ⌘↵"}
            </button>
            <button type="button" style={ghostBtn} onClick={onNudge}>
              nudge me
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
