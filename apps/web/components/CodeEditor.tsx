"use client";

import Editor from "@monaco-editor/react";
import { PanelLabel } from "./Notepad";

/**
 * Monaco, with the assistance turned off.
 *
 * Every suggestion feature is disabled deliberately. In a real interview nobody
 * is completing your function signatures, and a candidate who tab-completes the
 * right data structure has demonstrated nothing about choosing it. What stays
 * on: syntax highlighting, brackets, indentation — the things a real editor
 * gives you and nobody would call help.
 */
export function CodeEditor({
  value,
  language,
  onChange,
}: {
  value: string;
  language: string;
  onChange: (text: string) => void;
}) {
  return (
    <div className="editor-shell">
      <PanelLabel><span>{language} · solution.py</span><span className="panel-shortcut">Ctrl ↵ to run</span></PanelLabel>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Editor
          height="100%"
          theme="vs-dark"
          language={language}
          value={value}
          onChange={(v) => onChange(v ?? "")}
          options={{
            fontSize: 13,
            fontFamily: "var(--mono)",
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            renderWhitespace: "selection",
            tabSize: 4,

            // No help.
            quickSuggestions: false,
            suggestOnTriggerCharacters: false,
            acceptSuggestionOnEnter: "off",
            wordBasedSuggestions: "off",
            parameterHints: { enabled: false },
            inlineSuggest: { enabled: false },
            snippetSuggestions: "none",
            codeLens: false,
            smoothScrolling: true,
            cursorBlinking: "smooth",
            padding: { top: 14, bottom: 14 },
            // Hover stays on: reading a docstring is not the same as being told
            // which data structure to use.
          }}
          loading={<div style={{ padding: 16, color: "var(--muted)" }}>Loading editor…</div>}
        />
      </div>
    </div>
  );
}
