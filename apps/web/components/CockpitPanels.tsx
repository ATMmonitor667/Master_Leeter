"use client";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import { Icon } from "./ui/Icon";
import s from "./Cockpit.module.css";
export function CockpitPanels({
  editor,
  notes,
  captions,
  onMute,
}: {
  editor: ReactNode;
  notes: ReactNode;
  captions: ReactNode;
  onMute: () => void;
}) {
  const [width, setWidth] = useState(70);
  const [collapsed, setCollapsed] = useState(false);
  const [tab, setTab] = useState("code");
  const split = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem("ml-split"));
      if (saved >= 45 && saved <= 85) setWidth(saved);
      setCollapsed(localStorage.getItem("ml-side-collapsed") === "true");
    } catch {}
  }, []);
  function resize(value: number) {
    const next = Math.max(45, Math.min(85, value));
    setWidth(next);
    try {
      localStorage.setItem("ml-split", String(next));
    } catch {}
  }
  function collapse() {
    setCollapsed((value) => {
      try {
        localStorage.setItem("ml-side-collapsed", String(!value));
      } catch {}
      return !value;
    });
  }
  useEffect(() => {
    function key(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key === "/") {
        event.preventDefault();
        collapse();
      }
      if (modifier && ["1", "2", "3"].includes(event.key)) {
        event.preventDefault();
        const next = ["code", "notes", "captions"][Number(event.key) - 1]!;
        setTab(next);
        setCollapsed(false);
        requestAnimationFrame(() => {
          split.current
            ?.querySelector<HTMLElement>(
              next === "code"
                ? ".monaco-editor textarea"
                : next === "notes"
                  ? 'textarea[aria-label="Interview notes"]'
                  : ".caption-body",
            )
            ?.focus();
        });
      }
      if (
        event.key === "m" &&
        !modifier &&
        !event.altKey &&
        !target.closest(
          "input,textarea,select,[contenteditable=true],.monaco-editor",
        )
      ) {
        event.preventDefault();
        onMute();
      }
    }
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onMute]);
  return (
    <div className={`${s.panels} ${collapsed ? s.collapsed : ""}`}>
      <div className={s.toolbar}>
        <span>Live workspace · Python</span>
        <div className={s.views}>
          <label>
            Layout{" "}
            <select
              aria-label="Workspace layout"
              value={width}
              onChange={(event) => {
                setCollapsed(false);
                resize(Number(event.target.value));
              }}
            >
              <option value={50}>Balanced</option>
              <option value={70}>Editor wide</option>
              <option value={85}>Editor focus</option>
              {![50, 70, 85].includes(width) && (
                <option value={width}>Custom split</option>
              )}
            </select>
          </label>
          <button
            className="ghost-button"
            type="button"
            aria-expanded={!collapsed}
            aria-controls="interview-side"
            onClick={collapse}
          >
            {collapsed ? "Show notes and captions" : "Hide side panels"}
          </button>
        </div>
        <div className={s.tabs} role="tablist" aria-label="Workspace panels">
          {["code", "notes", "captions"].map((item, index) => (
            <button
              type="button"
              role="tab"
              key={item}
              aria-selected={tab === item}
              aria-controls={`panel-${item}`}
              tabIndex={tab === item ? 0 : -1}
              onClick={() => setTab(item)}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? 2
                      : (index + (event.key === "ArrowRight" ? 1 : -1) + 3) % 3;
                setTab(["code", "notes", "captions"][next]!);
                (
                  event.currentTarget.parentElement?.children[
                    next
                  ] as HTMLElement
                )?.focus();
              }}
            >
              <Icon
                name={
                  item === "code"
                    ? "code"
                    : item === "notes"
                      ? "notes"
                      : "captions"
                }
              />
              {item.charAt(0).toUpperCase() + item.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={split}
        className={s.split}
        data-tab={tab}
        style={{ "--editor-width": `${width}%` } as CSSProperties}
      >
        <section id="panel-code" className={s.code} aria-label="Code editor">
          {editor}
        </section>
        <div
          role="separator"
          tabIndex={0}
          aria-label="Resize code editor"
          aria-orientation="vertical"
          aria-valuemin={45}
          aria-valuemax={85}
          aria-valuenow={width}
          className={s.handle}
          onDoubleClick={() => resize(70)}
          onKeyDown={(event) => {
            if (
              ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
            ) {
              event.preventDefault();
              resize(
                event.key === "Home"
                  ? 45
                  : event.key === "End"
                    ? 85
                    : width + (event.key === "ArrowRight" ? 5 : -5),
              );
            }
          }}
          onPointerDown={(event) => {
            dragging.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
          onPointerMove={(event) => {
            if (!dragging.current || !split.current) return;
            const rect = split.current.getBoundingClientRect();
            resize(
              Math.round(((event.clientX - rect.left) / rect.width) * 100),
            );
          }}
        />
        <aside
          id="interview-side"
          className={s.side}
          aria-label="Interview tools"
        >
          <section id="panel-notes" aria-label="Notes">
            {notes}
          </section>
          <section id="panel-captions" aria-label="Candidate captions">
            {captions}
          </section>
        </aside>
      </div>
    </div>
  );
}
