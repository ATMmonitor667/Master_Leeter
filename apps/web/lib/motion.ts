/**
 * Pointer and scroll behaviour for the shared surface system
 * (app/styles/surfaces.css). Loaded lazily, after hydration, in its own chunk.
 *
 * It only writes CSS custom properties and one attribute. It never reads or
 * changes application state, and it does nothing when the OS asks for reduced
 * motion.
 */

const CARD = "[data-card]";
const REVEAL = "[data-reveal]:not([data-revealed])";

export function startMotion(): () => void {
  const root = document.documentElement;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    delete root.dataset["motion"];
    return () => {};
  }
  // The inline script in the layout set "pending"; "live" tells it we arrived.
  root.dataset["motion"] = "live";

  // ── Scroll reveals ───────────────────────────────────────────────────────
  const seen = new IntersectionObserver((entries) => {
    let order = 0;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const element = entry.target as HTMLElement;
      element.style.setProperty("--rd", `${Math.min(order, 5) * 70}ms`);
      element.dataset["revealed"] = "";
      seen.unobserve(element);
      order += 1;
    }
  }, { rootMargin: "0px 0px -6% 0px", threshold: 0.06 });

  const watch = (scope: ParentNode) => {
    if (scope instanceof HTMLElement && scope.matches(REVEAL)) seen.observe(scope);
    scope.querySelectorAll<HTMLElement>(REVEAL).forEach((element) => seen.observe(element));
  };
  watch(document);
  const added = new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => { if (node instanceof HTMLElement) watch(node); });
    }
  });
  added.observe(document.body, { childList: true, subtree: true });

  // ── Pointer spotlight and tilt ───────────────────────────────────────────
  let frame = 0;
  let latest: PointerEvent | null = null;
  let active: HTMLElement | null = null;

  const release = () => {
    active?.style.removeProperty("--rx");
    active?.style.removeProperty("--ry");
    active = null;
  };
  const apply = () => {
    frame = 0;
    const event = latest;
    if (!event) return;
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>(CARD) : null;
    if (target !== active) { release(); active = target; }
    if (!target) return;
    const box = target.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    target.style.setProperty("--mx", `${x.toFixed(1)}px`);
    target.style.setProperty("--my", `${y.toFixed(1)}px`);
    if (!(target.dataset["card"] ?? "").includes("tilt")) return;
    // Wide cards tilt less, so the edge never travels more than a few pixels.
    const yaw = Math.min(5, 1500 / Math.max(1, box.width));
    const pitch = Math.min(4, 1100 / Math.max(1, box.height));
    target.style.setProperty("--ry", `${((x / box.width - 0.5) * 2 * yaw).toFixed(2)}deg`);
    target.style.setProperty("--rx", `${((0.5 - y / box.height) * 2 * pitch).toFixed(2)}deg`);
  };
  const onMove = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    latest = event;
    if (!frame) frame = requestAnimationFrame(apply);
  };
  const onLeave = () => { latest = null; release(); };

  document.addEventListener("pointermove", onMove, { passive: true });
  document.documentElement.addEventListener("pointerleave", onLeave);

  return () => {
    seen.disconnect();
    added.disconnect();
    cancelAnimationFrame(frame);
    document.removeEventListener("pointermove", onMove);
    document.documentElement.removeEventListener("pointerleave", onLeave);
    release();
  };
}
