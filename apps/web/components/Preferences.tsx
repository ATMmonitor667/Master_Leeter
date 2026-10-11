"use client";
import {
  lazy,
  Suspense,
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
const ShortcutsDialog = lazy(() => import("./ShortcutsDialog"));
import { Icon } from "./ui/Icon";
import s from "./Shell.module.css";
type Theme = "dark" | "light" | "system";
const Context = createContext({
  theme: "dark" as Theme,
  setTheme: (_value: Theme) => {},
  fontSize: 14,
  setFontSize: (_value: number) => {},
  readCaptions: false,
  setReadCaptions: (_value: boolean) => {},
  announce: (_message: string, _priority?: number) => {},
});
export const usePreferences = () => useContext(Context);
export function Preferences({ children }: { children: ReactNode }) {
  const [theme, updateTheme] = useState<Theme>("dark");
  const [fontSize, updateFont] = useState(14);
  const [readCaptions, updateCaptions] = useState(false);
  const [message, setMessage] = useState("");
  const [help, setHelp] = useState(false);
  useEffect(() => {
    try {
      const t = localStorage.getItem("ml-theme");
      if (t === "dark" || t === "light" || t === "system") {
        updateTheme(t);
        document.documentElement.dataset.theme = t;
      }
      const size = Number(localStorage.getItem("ml-font"));
      if ([14, 16, 18].includes(size)) updateFont(size);
      updateCaptions(localStorage.getItem("ml-read-captions") === "true");
    } catch {}
  }, []);
  const setTheme = (value: Theme) => {
    updateTheme(value);
    document.documentElement.dataset.theme = value;
    try {
      localStorage.setItem("ml-theme", value);
    } catch {}
    window.dispatchEvent(new Event("ml-theme-change"));
  };
  const setFontSize = (value: number) => {
    updateFont(value);
    try {
      localStorage.setItem("ml-font", String(value));
    } catch {}
  };
  const setReadCaptions = (value: boolean) => {
    updateCaptions(value);
    try {
      localStorage.setItem("ml-read-captions", String(value));
    } catch {}
  };
  useEffect(() => {
    let prefix = false;
    const handler = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      const target = event.target as HTMLElement;
      if (
        target.closest(
          "input,textarea,select,[contenteditable=true],.monaco-editor",
        ) ||
        target.isContentEditable
      )
        return;
      if (event.key === "?") {
        event.preventDefault();
        setHelp(true);
      }
      if (event.key === "t")
        setTheme(
          theme === "dark" ? "system" : theme === "system" ? "light" : "dark",
        );
      if (prefix && event.key === "h") window.location.assign("/history");
      if (prefix && event.key === "s") window.location.assign("/settings");
      prefix = event.key === "g";
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [theme]);
  // A single polite channel coalesces status changes within one event loop.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = "";
    let priority = -1;
    const handler = (event: Event) => {
      const detail = (
        event as CustomEvent<{ message: string; priority: number }>
      ).detail;
      if (detail.priority >= priority) {
        pending = detail.message;
        priority = detail.priority;
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        setMessage(pending);
        priority = -1;
      }, 140);
    };
    window.addEventListener("ml-announce", handler);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("ml-announce", handler);
    };
  }, []);
  const announce = (message: string, priority = 0) =>
    window.dispatchEvent(
      new CustomEvent("ml-announce", { detail: { message, priority } }),
    );
  return (
    <Context.Provider
      value={{
        theme,
        setTheme,
        fontSize,
        setFontSize,
        readCaptions,
        setReadCaptions,
        announce,
      }}
    >
      {children}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {message}
      </div>
      {help && (
        <Suspense fallback={null}>
          <ShortcutsDialog onClose={() => setHelp(false)} />
        </Suspense>
      )}
    </Context.Provider>
  );
}
export function ThemeToggle() {
  const { theme, setTheme } = usePreferences();
  return (
    <button
      className={s.theme}
      type="button"
      aria-label={`Appearance: ${theme}. Switch theme`}
      onClick={() =>
        setTheme(
          theme === "dark" ? "system" : theme === "system" ? "light" : "dark",
        )
      }
    >
      <Icon
        name={theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor"}
      />
      <span>{theme.charAt(0).toUpperCase() + theme.slice(1)}</span>
    </button>
  );
}
export function OfflineStrip() {
  const [online, setOnline] = useState(true);
  const { announce } = usePreferences();
  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine);
      announce(
        navigator.onLine
          ? "Connection restored"
          : "You are offline. Reconnect to continue.",
        2,
      );
    };
    setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online ? null : (
    <div className={s.offline}>
      You are offline. Reconnect to continue; interview edits remain queued in
      this tab.
    </div>
  );
}
