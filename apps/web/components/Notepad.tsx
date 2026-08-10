"use client";

/**
 * Scratch notes.
 *
 * Explicitly hostile to assistance: spellcheck, autocomplete, autocorrect, and
 * autocapitalize are all off. This is where the candidate writes down
 * constraints they heard, examples they invented, and complexity they're
 * guessing at — a tool that completes their sentences would be doing part of
 * the thinking being evaluated.
 *
 * Note activity is session evidence (it tells the observer whether a quiet
 * candidate is stuck or working), but it is not graded unless rubric-relevant.
 */
export function Notepad({
  value,
  onChange,
}: {
  value: string;
  onChange: (text: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <PanelLabel>Notes</PanelLabel>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        data-gramm="false"
        placeholder="Constraints, examples, invariants, complexity…"
        style={{
          flex: 1,
          resize: "none",
          border: "none",
          borderRadius: 0,
          background: "var(--panel)",
          fontFamily: "var(--mono)",
          fontSize: 13,
          lineHeight: 1.6,
        }}
      />
    </div>
  );
}

export function PanelLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "6px 10px",
        fontSize: 11,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--muted)",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg)",
      }}
    >
      {children}
    </div>
  );
}
