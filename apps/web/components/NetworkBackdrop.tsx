"use client";

import { useEffect, useRef } from "react";

const NODE_COUNT = 46;
const LINK_DISTANCE = 150;

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

/**
 * Animated canvas network behind the marketing landing page.
 * Decorative only — respects prefers-reduced-motion.
 */
export function NetworkBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;

    const nodes: Node[] = Array.from({ length: NODE_COUNT }, () => ({
      x: Math.random(),
      y: Math.random(),
      vx: (Math.random() - 0.5) * 0.28,
      vy: (Math.random() - 0.5) * 0.28,
      r: Math.random() * 1.6 + 0.7,
    }));

    function resize() {
      if (!canvas || !ctx) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function drawFrame() {
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);

      for (const node of nodes) {
        node.x += node.vx / width;
        node.y += node.vy / height;
        if (node.x <= 0 || node.x >= 1) node.vx *= -1;
        if (node.y <= 0 || node.y >= 1) node.vy *= -1;
        node.x = Math.min(1, Math.max(0, node.x));
        node.y = Math.min(1, Math.max(0, node.y));
      }

      const px = nodes.map((n) => ({ x: n.x * width, y: n.y * height, r: n.r }));

      for (let i = 0; i < px.length; i += 1) {
        for (let j = i + 1; j < px.length; j += 1) {
          const a = px[i]!;
          const b = px[j]!;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.hypot(dx, dy);
          if (dist >= LINK_DISTANCE) continue;
          const alpha = 0.16 * (1 - dist / LINK_DISTANCE);
          ctx.strokeStyle = `rgba(127, 227, 194, ${alpha})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      for (const n of px) {
        ctx.fillStyle = "rgba(160,200,255,.32)";
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function tick() {
      drawFrame();
      raf = requestAnimationFrame(tick);
    }

    resize();
    drawFrame();

    const onResize = () => resize();
    window.addEventListener("resize", onResize);

    if (!reducedMotion) {
      raf = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        zIndex: 0,
        opacity: 0.55,
        pointerEvents: "none",
      }}
    />
  );
}
