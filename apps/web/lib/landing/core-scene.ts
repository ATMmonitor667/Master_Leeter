import {
  AmbientLight, Color, DirectionalLight, Group, IcosahedronGeometry, Mesh, MeshStandardMaterial,
  PerspectiveCamera, PointLight, Scene, SphereGeometry, TorusGeometry, WebGLRenderer,
} from "three";

/**
 * The landing page's Cognition Core: three broken rings around a pearl, with a
 * few signal nodes on the ring tracks. Decorative only.
 *
 * Loaded by dynamic import, so three.js never reaches the interview bundle.
 * The loop draws only while the canvas is on screen and the tab is visible.
 */

export interface CorePalette { ring: string; edge: string; pearl: string; signal: string; violet: string; key: string }

export interface CoreScene {
  /** 0 at the top of the page, 1 once the hero has scrolled away. */
  setProgress(value: number): void;
  /** Pointer position over the page, each axis in [-1, 1]. */
  setPointer(x: number, y: number): void;
  setPalette(palette: CorePalette): void;
  dispose(): void;
}

const RADII = [1.7, 1.224, 0.748];           // 1.00 / 0.72 / 0.44
const TUBES = [0.034, 0.03, 0.026];
const GAPS = [24, 196, 311].map((deg) => (deg * Math.PI) / 180);
const TILTS: Array<[number, number]> = [[18, 8], [-27, 34], [61, -22]].map(
  ([x, y]) => [((x ?? 0) * Math.PI) / 180, ((y ?? 0) * Math.PI) / 180],
);
const NODES = [
  { ring: 0, phase: 0.4, speed: 0.11 }, { ring: 0, phase: 3.3, speed: 0.11 },
  { ring: 1, phase: 1.2, speed: -0.16 }, { ring: 1, phase: 4.1, speed: -0.16 }, { ring: 1, phase: 5.6, speed: -0.16 },
  { ring: 2, phase: 2.2, speed: 0.23 }, { ring: 2, phase: 5.0, speed: 0.23 },
];

export function createCoreScene(
  canvas: HTMLCanvasElement,
  palette: CorePalette,
  options: { lowPower: boolean; onFirstFrame: () => void; onLost: () => void },
): CoreScene {
  const renderer = new WebGLRenderer({ canvas, antialias: !options.lowPower, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, options.lowPower ? 1 : 1.75));

  const scene = new Scene();
  const camera = new PerspectiveCamera(35, 1, 0.1, 50);
  camera.position.set(0, 0, 9);

  const ambient = new AmbientLight(palette.key, 0.5);
  const key = new DirectionalLight(palette.key, 2.4);
  key.position.set(-3, 4, 5);
  const rim = new PointLight(palette.violet, 30, 0, 2);
  rim.position.set(3.5, 1.5, -3);
  const fill = new PointLight(palette.signal, 10, 0, 2);
  fill.position.set(0.5, -2.5, 4);
  scene.add(ambient, key, rim, fill);

  const core = new Group();
  scene.add(core);

  const segments = options.lowPower ? 96 : 200;
  const ringMaterial = new MeshStandardMaterial({ color: palette.ring, metalness: 0.72, roughness: 0.25, emissive: palette.edge, emissiveIntensity: 0.16 });
  const rings = RADII.map((radius, i) => {
    const arc = Math.PI * 2 - 0.5 - i * 0.12;
    const mesh = new Mesh(new TorusGeometry(radius, TUBES[i], 12, segments, arc), ringMaterial);
    mesh.rotation.z = GAPS[i] ?? 0;
    const pivot = new Group();
    pivot.add(mesh);
    core.add(pivot);
    return pivot;
  });

  const pearlMaterial = new MeshStandardMaterial({ color: palette.pearl, metalness: 0.08, roughness: 0.42, emissive: palette.signal, emissiveIntensity: 0.12 });
  const pearl = new Mesh(new IcosahedronGeometry(0.36, options.lowPower ? 3 : 5), pearlMaterial);
  core.add(pearl);

  const nodeMaterial = new MeshStandardMaterial({ color: palette.signal, emissive: palette.signal, emissiveIntensity: 1.1, roughness: 0.4 });
  const nodeGeometry = new SphereGeometry(0.045, 12, 12);
  const nodes = NODES.map((spec) => {
    const mesh = new Mesh(nodeGeometry, nodeMaterial);
    rings[spec.ring]?.add(mesh);
    return mesh;
  });

  let progress = 0;
  let pointerX = 0;
  let pointerY = 0;
  let yaw = 0;
  let pitch = 0;
  let aligned = 0;
  let frame = 0;
  let onScreen = true;
  let first = true;
  let disposed = false;
  const started = performance.now();

  function resize() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // Keep the whole sculpture in frame when the canvas is narrower than tall.
    camera.position.z = camera.aspect < 1 ? 9 / camera.aspect : 9;
    camera.updateProjectionMatrix();
  }

  function draw(now: number) {
    frame = 0;
    if (disposed) return;
    const t = (now - started) / 1000;

    // Idle: 8 degrees of yaw in total over ~20 s. Pointer: +/-6 yaw, +/-4 pitch, damped.
    const idle = Math.sin((t / 20) * Math.PI * 2) * ((4 * Math.PI) / 180);
    yaw += (idle + pointerX * ((6 * Math.PI) / 180) - yaw) * 0.06;
    pitch += (pointerY * ((4 * Math.PI) / 180) - pitch) * 0.06;
    aligned += (progress - aligned) * 0.08;
    core.rotation.set(pitch + aligned * 0.5, yaw, 0);
    core.position.y = -aligned * 0.6;

    // Scrolling settles the three orientations into one orderly plane.
    rings.forEach((pivot, i) => {
      const [x, y] = TILTS[i] ?? [0, 0];
      pivot.rotation.set(x * (1 - aligned), y * (1 - aligned), 0);
    });
    nodes.forEach((mesh, i) => {
      const spec = NODES[i];
      if (!spec) return;
      const angle = spec.phase + t * spec.speed;
      const radius = RADII[spec.ring] ?? 1;
      mesh.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
    });
    pearl.rotation.y = t * 0.05;

    renderer.render(scene, camera);
    if (first) { first = false; options.onFirstFrame(); }
    schedule();
  }

  function schedule() {
    if (!frame && !disposed && onScreen && !document.hidden) frame = requestAnimationFrame(draw);
  }

  const observer = new IntersectionObserver(([entry]) => { onScreen = Boolean(entry?.isIntersecting); schedule(); });
  observer.observe(canvas);
  const resizer = new ResizeObserver(resize);
  resizer.observe(canvas);
  const onVisibility = () => schedule();
  const onLost = (event: Event) => { event.preventDefault(); options.onLost(); };
  document.addEventListener("visibilitychange", onVisibility);
  canvas.addEventListener("webglcontextlost", onLost);

  resize();
  schedule();

  return {
    setProgress(value) { progress = Math.min(1, Math.max(0, value)); },
    setPointer(x, y) { pointerX = x; pointerY = y; },
    setPalette(next) {
      ringMaterial.color = new Color(next.ring);
      ringMaterial.emissive = new Color(next.edge);
      pearlMaterial.color = new Color(next.pearl);
      pearlMaterial.emissive = new Color(next.signal);
      nodeMaterial.color = new Color(next.signal);
      nodeMaterial.emissive = new Color(next.signal);
      ambient.color = new Color(next.key);
      key.color = new Color(next.key);
      rim.color = new Color(next.violet);
      fill.color = new Color(next.signal);
    },
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      resizer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onLost);
      rings.forEach((pivot) => pivot.children.forEach((child) => { if (child instanceof Mesh && child.geometry !== nodeGeometry) child.geometry.dispose(); }));
      nodeGeometry.dispose();
      pearl.geometry.dispose();
      ringMaterial.dispose();
      pearlMaterial.dispose();
      nodeMaterial.dispose();
      renderer.dispose();
    },
  };
}
