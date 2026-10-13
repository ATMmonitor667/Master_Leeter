"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { usePreferences } from "./Preferences";
import { editorTheme } from "../lib/monaco-theme";
import { PanelLabel } from "./Notepad";

// The default loader fetches Monaco from a CDN. Interview code must stay on
// our origin, and the site's CSP intentionally rejects third-party scripts.
const Editor = dynamic(
  () =>
    import("@monaco-editor/react").then((module) => {
      module.loader.config({ paths: { vs: "/monaco/vs" } });
      return module.default;
    }),
  {
    ssr: false,
    loading: () => <div className="editor-loading">Loading editor…</div>,
  },
);

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
  saveState = "saved",
  readOnly = false,
}: {
  value: string;
  language: string;
  onChange: (text: string) => void;
  saveState?: "saved" | "saving" | "offline" | "draft";
  readOnly?: boolean;
}) {
  const { theme, fontSize, setFontSize } = usePreferences();
  const [systemDark, setSystemDark] = useState(true);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const dark = theme === "dark" || (theme === "system" && systemDark);
  return (
    <div className="editor-shell">
      <PanelLabel>
        <span>{language} · solution.py</span>
        <span className="editor-options">
          <label>
            Font{" "}
            <select
              className="font-select"
              aria-label="Editor font size"
              value={fontSize}
              onChange={(event) => setFontSize(Number(event.target.value))}
            >
              {[14, 16, 18].map((size) => (
                <option key={size} value={size}>
                  {size}px
                </option>
              ))}
            </select>
          </label>
          <span className={`save-state ${saveState}`}>
            {saveState === "saved"
              ? "Saved"
              : saveState === "draft" ? "Not submitted" : saveState === "offline"
                ? "Waiting for connection"
                : "Saving…"}
          </span>
        </span>
      </PanelLabel>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Editor
          height="100%"
          theme={dark ? "ml-dark" : "ml-light"}
          beforeMount={(monaco) => {
            monaco.editor.defineTheme("ml-dark", editorTheme(true));
            monaco.editor.defineTheme("ml-light", editorTheme(false));
          }}
          language={language}
          value={value}
          onChange={(v) => onChange(v ?? "")}
          options={{
            readOnly,
            fontSize,
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
            smoothScrolling: false,
            cursorBlinking: "solid",
            padding: { top: 14, bottom: 14 },
            accessibilitySupport: "on",
            editContext: false,
            ariaLabel: `${language} solution editor`,
            // Hover stays on: reading a docstring is not the same as being told
            // which data structure to use.
          }}
          loading={
            <div style={{ padding: 16, color: "var(--muted)" }}>
              Loading editor…
            </div>
          }
        />
      </div>
    </div>
  );
}
