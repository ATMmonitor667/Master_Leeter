"use client";

import { useEffect, useRef } from "react";

/**
 * Embeddable constellation backdrop.
 *
 * Same visual language as `constellation-grid` — a sprung node mesh with a cyan
 * accent — reworked into something that can sit behind real content instead of
 * being the whole page.
 *
 * Three differences from the full-screen version, all of them deliberate:
 *
 * 1. **It connects neighbours, not every pair.** The original compares every
 *    node against every other one: ~750 nodes on a 1080p viewport is ~280,000
 *    comparisons per frame. It does not need to. Nodes sit on a grid, and the
 *    connection threshold (75px) is barely above the spacing, so only immediate
 *    neighbours are ever in range — a diagonal at 55px spacing is already 78px
 *    apart. Walking the four forward neighbours gives the same picture in O(n).
 *
 * 2. **It sizes to its container**, via `ResizeObserver` rather than
 *    `window.innerWidth`, so it can back a hero section rather than a viewport.
 *
 * 3. **It honours `prefers-reduced-motion`.** A mesh that breathes and chases
 *    the cursor is exactly the kind of thing that reading-disorder and
 *    vestibular guidance is about. Reduced motion gets one static frame — the
 *    texture survives, the movement does not.
 *
 * The interview workspace is NOT a valid host for this. `CLAUDE.md` keeps that
 * screen deliberately bare, and animated peripheral motion next to a code editor
 * is the definition of a distraction while somebody is being assessed.
 */

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  baseX: number;
  baseY: number;
  radius: number;
  pulse: number;
}

export interface ConstellationFieldProps {
  /** Grid pitch in CSS pixels. Larger is calmer and cheaper. */
  spacing?: number;
  /** Cursor push. Off for backdrops behind readable text. */
  interactive?: boolean;
  /** Ambient drift when not interactive. 0 disables it. */
  drift?: number;
  className?: string;
}

export default function ConstellationField({
  spacing = 78,
  interactive = false,
  drift = 0.35,
  className,
}: ConstellationFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let frame = 0;
    let width = 0;
    let height = 0;
    let cols = 0;
    let rows = 0;
    let nodes: Node[] = [];

    const mouse = { x: -9999, y: -9999, radius: 180 };

    const build = () => {
      const rect = host.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));

      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      // setTransform, not scale: `scale` compounds across rebuilds, and this one
      // runs on every container resize rather than once.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      cols = Math.ceil(width / spacing) + 1;
      rows = Math.ceil(height / spacing) + 1;
      nodes = [];

      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const x = i * spacing;
          const y = j * spacing;
          nodes.push({
            x,
            y,
            vx: 0,
            vy: 0,
            baseX: x,
            baseY: y,
            radius: Math.random() * 0.9 + 0.8,
            pulse: Math.random() * Math.PI * 2,
          });
        }
      }
    };

    /** Grid position → index, so neighbours are O(1) rather than a search. */
    const at = (i: number, j: number): Node | undefined =>
      i < 0 || j < 0 || i >= cols || j >= rows ? undefined : nodes[i * rows + j];

    const draw = (dt: number) => {
      ctx.clearRect(0, 0, width, height);

      const SPRING_K = 14;
      const DAMPING = 0.84;
      const CONNECT = spacing * 1.45;

      for (const n of nodes) {
        n.pulse += dt * 1.6;

        if (interactive) {
          const dx = mouse.x - n.x;
          const dy = mouse.y - n.y;
          const dist = Math.hypot(dx, dy);

          if (dist < mouse.radius && dist > 0) {
            const force = (1 - dist / mouse.radius) * 900;
            const angle = Math.atan2(dy, dx);
            n.vx -= Math.cos(angle) * force * dt;
            n.vy -= Math.sin(angle) * force * dt;
          }
        }

        // Ambient breathing so a non-interactive field is not dead still.
        if (drift > 0) {
          n.vx += Math.cos(n.pulse * 0.6) * drift * dt * 12;
          n.vy += Math.sin(n.pulse * 0.45) * drift * dt * 12;
        }

        n.vx += (n.baseX - n.x) * SPRING_K * dt;
        n.vy += (n.baseY - n.y) * SPRING_K * dt;
        n.vx *= DAMPING;
        n.vy *= DAMPING;
        n.x += n.vx * dt * 60;
        n.y += n.vy * dt * 60;
      }

      // Edges: four forward neighbours each, so every pair is visited once.
      ctx.lineWidth = 0.6;
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const n = at(i, j);
          if (!n) continue;

          for (const [di, dj] of [
            [1, 0],
            [0, 1],
            [1, 1],
            [1, -1],
          ] as const) {
            const m = at(i + di, j + dj);
            if (!m) continue;

            const d = Math.hypot(n.x - m.x, n.y - m.y);
            if (d >= CONNECT) continue;

            ctx.strokeStyle = `rgba(122, 162, 255, ${(1 - d / CONNECT) * 0.16})`;
            ctx.beginPath();
            ctx.moveTo(n.x, n.y);
            ctx.lineTo(m.x, m.y);
            ctx.stroke();
          }
        }
      }

      for (const n of nodes) {
        const near = interactive && Math.hypot(mouse.x - n.x, mouse.y - n.y) < mouse.radius;
        const alpha = near ? 0.8 : 0.22 + Math.sin(n.pulse) * 0.07;

        ctx.fillStyle = near
          ? `rgba(122, 162, 255, ${alpha})`
          : `rgba(200, 214, 236, ${alpha})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, Math.max(0.4, n.radius), 0, Math.PI * 2);
        ctx.fill();
      }
    };

    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      draw(dt);
      frame = requestAnimationFrame(loop);
    };

    const onMove = (e: MouseEvent) => {
      const rect = host.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
    };
    const onLeave = () => {
      mouse.x = -9999;
      mouse.y = -9999;
    };

    build();

    if (reduceMotion) {
      // One frame. The texture is the point; the movement is the accommodation.
      draw(0);
    } else {
      frame = requestAnimationFrame(loop);
      if (interactive) {
        host.addEventListener("mousemove", onMove);
        host.addEventListener("mouseleave", onLeave);
      }
    }

    const observer = new ResizeObserver(() => {
      build();
      if (reduceMotion) draw(0);
    });
    observer.observe(host);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      host.removeEventListener("mousemove", onMove);
      host.removeEventListener("mouseleave", onLeave);
    };
  }, [spacing, interactive, drift]);

  return <canvas ref={canvasRef} aria-hidden="true" className={className} />;
}
