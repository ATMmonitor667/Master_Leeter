"use client";

import { useEffect, useRef, useState } from "react";
import type { CorePalette, CoreScene } from "../../lib/landing/core-scene";
import s from "./CognitionCore.module.css";

/**
 * The landing sculpture. The SVG poster is server-rendered and is the whole
 * experience for reduced motion, data saver, small screens and missing WebGL.
 * Everywhere else the 3D scene loads after the page is idle and replaces it.
 */

const RINGS = [
  { r: 150, tilt: 18, squash: 0.94, dash: "820 123" },
  { r: 108, tilt: -27, squash: 0.74, dash: "560 119" },
  { r: 66, tilt: 61, squash: 0.52, dash: "330 85" },
];
const NODES = [[352, 150], [70, 232], [262, 84], [152, 290], [228, 196], [118, 128], [300, 262]];

export function CorePoster() {
  return (
    <svg className={s.poster} viewBox="0 0 400 400" aria-hidden="true">
      <circle className={s.halo} cx="200" cy="200" r="150" />
      {RINGS.map((ring) => (
        <ellipse key={ring.r} className={s.posterRing} cx="200" cy="200" rx={ring.r} ry={ring.r * ring.squash}
          strokeDasharray={ring.dash} transform={`rotate(${ring.tilt} 200 200)`} />
      ))}
      <circle className={s.pearl} cx="200" cy="200" r="30" />
      <circle className={s.pearlLight} cx="191" cy="190" r="11" />
      {NODES.map(([x, y]) => <circle key={`${x}-${y}`} className={s.node} cx={x} cy={y} r="3.5" />)}
    </svg>
  );
}

function readPalette(root: HTMLElement): CorePalette {
  const read = (name: string) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    root.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  };
  return { ring: read("--core-ring"), edge: read("--accent"), pearl: read("--core-pearl"), signal: read("--signal"), violet: read("--violet"), key: read("--core-key") };
}

function canRender(): boolean {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return false;
  if (window.innerWidth <= 480) return false;
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext("webgl2") ?? probe.getContext("webgl"));
  } catch { return false; }
}

export function CognitionCore() {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [live, setLive] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { if (canRender()) setMounted(true); }, []);

  useEffect(() => {
    if (!mounted) return;
    const host = root.current;
    const surface = canvas.current;
    if (!host || !surface) return;
    let scene: CoreScene | null = null;
    let cancelled = false;

    const onScroll = () => scene?.setProgress(window.scrollY / Math.max(1, window.innerHeight * 0.85));
    const onPointer = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      scene?.setPointer((event.clientX / window.innerWidth) * 2 - 1, (event.clientY / window.innerHeight) * 2 - 1);
    };
    const themes = new MutationObserver(() => scene?.setPalette(readPalette(host)));

    const start = () => {
      void import("../../lib/landing/core-scene").then(({ createCoreScene }) => {
        if (cancelled) return;
        try {
          scene = createCoreScene(surface, readPalette(host), {
            lowPower: window.innerWidth < 768,
            onFirstFrame: () => setLive(true),
            onLost: () => { setLive(false); setMounted(false); },
          });
        } catch { setMounted(false); return; }
        onScroll();
        window.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("pointermove", onPointer, { passive: true });
        themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      }).catch(() => setMounted(false));
    };
    // Wait until the page has settled so the scene never competes with first paint.
    const timer = setTimeout(start, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointermove", onPointer);
      themes.disconnect();
      scene?.dispose();
    };
  }, [mounted]);

  return (
    <div ref={root} className={s.core} data-live={live} aria-hidden="true">
      <CorePoster />
      {mounted && <canvas ref={canvas} className={s.canvas} />}
    </div>
  );
}
