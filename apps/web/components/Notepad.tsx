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
    <div className="panel-shell">
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
        className="panel-textarea"
      />
    </div>
  );
}

export function PanelLabel({ children }: { children: React.ReactNode }) {
  return <div className="panel-label">{children}</div>;
}
