"use client";

import type { RunResult } from "@master-leeter/contracts";
import { PanelLabel } from "./Notepad";

const STATUS_COLOR: Record<string, string> = {
  PASSED: "var(--ok)",
  FAILED: "var(--err)",
  COMPILE_ERROR: "var(--err)",
  RUNTIME_ERROR: "var(--err)",
  TIMEOUT: "var(--warn)",
  MEMORY_EXCEEDED: "var(--warn)",
  INTERNAL_ERROR: "var(--warn)",
};

/**
 * Custom input, run control, and output.
 *
 * The candidate writes their own cases. Hidden tests stay server-side and their
 * inputs are never rendered here — the point of the panel is to observe whether
 * someone tests their own work, which is a rubric dimension. Handing them the
 * cases would be answering the question being asked.
 *
 * Output is rendered as plain text, never as HTML. Candidate code controls
 * stdout, so treating it as markup would be a trivial XSS.
 */
export function TestPanel({
  input,
  onInputChange,
  onRun,
  running,
  runnerAvailable,
  result,
}: {
  input: string;
  onInputChange: (v: string) => void;
  onRun: () => void;
  running: boolean;
  runnerAvailable: boolean;
  result: RunResult | null;
}) {
  return (
    <div className="panel-shell">
      <PanelLabel>Run &amp; inspect</PanelLabel>

      <div className="test-body">
        <textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          spellCheck={false}
          placeholder="Your own input…"
          className="test-input"
        />

        <div className="test-actions">
          <button className="primary-button" onClick={onRun} disabled={running || !runnerAvailable}>
            {running ? "Running…" : "Run"}
          </button>

          {/* A runner outage must not end the interview — reasoning and coding
              continue, and the candidate is told plainly why Run is disabled. */}
          {!runnerAvailable && (
            <span className="run-status" style={{ color: "var(--warn)" }}>
              Execution temporarily unavailable — keep going, you can still write and reason.
            </span>
          )}

          {result && runnerAvailable && (
            <span className="run-status" style={{ color: STATUS_COLOR[result.status] ?? "var(--muted)" }}>
              {result.status} · {result.cpuTimeMs}ms · rev {result.codeRevision}
            </span>
          )}
        </div>

        <pre className="terminal-output" style={{ color: result?.stderr ? "var(--err)" : undefined }}>
          {result ? result.stderr || result.stdout || "(no output)" : ""}
          {result?.truncated ? "\n… output truncated" : ""}
        </pre>
      </div>
    </div>
  );
}
