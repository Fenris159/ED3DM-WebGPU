import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  CSS2DObject,
  CSS2DRenderer,
} from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { orbScale, spectralColor } from "./palettes";
import { GALACTIC_REGIONS, GALAXY_CORE, GALAXY_RADIUS } from "./regions";
import type { CatalogCell, Route, System, VisualTheme } from "./types";

const PAPER = 0xeaeae8;
const CHARCOAL = 0x1c1c1b;
const SPACE = 0x07060c;
const SPECTRAL = [
  "#9bb0ff",
  "#c5d4ff",
  "#f4f1ff",
  "#fff4ea",
  "#ffd27a",
  "#ff9a4a",
  "#ff6848",
];

export type SceneHandle = {
  sync: (state: {
    cells: CatalogCell[];
    systems: System[];
    colors?: string[];
    selected?: System;
    hideImpostors?: boolean;
    loadedCellIds?: Set<string>;
    routes?: Route[];
    grid?: boolean;
    backdrop?: boolean;
    theme?: VisualTheme;
  }) => void;
  flyCamera: (target: { x: number; y: number; z: number }) => void;
  flyGalaxy: () => void;
  setTheme: (theme: VisualTheme) => void;
  destroy: () => void;
};

function hash01(i: number, seed: number): number {
  const n = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

const PAPER_GRAYS = ["#1c1c1b", "#2e2e2c", "#4a4a46", "#6a6a64", "#8a8a84"];

function impostorOrbs(
  cells: CatalogCell[],
  skipIds?: Set<string>,
): { x: number; y: number; z: number; r: number; hex: string }[] {
  const out: { x: number; y: number; z: number; r: number; hex: string }[] = [];
  for (const cell of cells) {
    if (skipIds?.has(cell.id)) continue;
    const n = Math.min(cell.count, 30);
    const seed = cell.id.length + cell.cx + cell.cz;
    const r = Math.min(400, Math.max(120, cell.size * 0.18));
    for (let i = 0; i < n; i++) {
      out.push({
        x: cell.cx + (hash01(i, seed) - 0.5) * cell.size,
        y: cell.cy + (hash01(i + 17, seed) - 0.5) * cell.size * 0.12,
        z: cell.cz + (hash01(i + 31, seed) - 0.5) * cell.size,
        r,
        hex: PAPER_GRAYS[Math.floor(hash01(i, seed + 7) * PAPER_GRAYS.length)]!,
      });
    }
  }
  return out;
}

// Solid camera-facing disc (dictionary nodes). Not a shaded sphere, not a glow.
function makeOrbTexture(): THREE.CanvasTexture {
  const s = 128;
  const cnv = document.createElement("canvas");
  cnv.width = cnv.height = s;
  const ctx = cnv.getContext("2d");
  const tex = new THREE.CanvasTexture(cnv);
  tex.flipY = false;
  tex.needsUpdate = true;
  if (!ctx) return tex;
  const cx = s * 0.5;
  const cy = s * 0.5;
  const r = s * 0.48;
  ctx.clearRect(0, 0, s, s);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  tex.needsUpdate = true;
  return tex;
}

function makeNebulaTexture(): THREE.CanvasTexture {
  const s = 128;
  const cnv = document.createElement("canvas");
  cnv.width = cnv.height = s;
  const ctx = cnv.getContext("2d");
  const tex = new THREE.CanvasTexture(cnv);
  tex.flipY = false;
  if (!ctx) return tex;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,0.55)");
  g.addColorStop(0.35, "rgba(255,255,255,0.18)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  tex.needsUpdate = true;
  return tex;
}

const orbVert = `
attribute float aScale;
uniform float uPixelRatio;
uniform float uMaxSize;
varying vec3 vColor;
varying float vDepth;
void main() {
  vColor = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vDepth = max(0.0, -mv.z);
  float dist = max(2.0, -mv.z);
  gl_PointSize = clamp(aScale * 280.0 / dist * uPixelRatio, 2.0, uMaxSize);
}
`;

const orbFrag = `
uniform sampler2D uMap;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
varying vec3 vColor;
varying float vDepth;
void main() {
  vec4 tex = texture2D(uMap, gl_PointCoord);
  if (tex.a < 0.5) discard;
  float fog = smoothstep(uFogNear, uFogFar, vDepth);
  vec3 rgb = mix(vColor, uFogColor, fog);
  gl_FragColor = vec4(rgb, 1.0);
}
`;

function orbCloud(
  items: { x: number; y: number; z: number; r: number; hex?: string }[],
  color: THREE.Color,
  opts: {
    maxPx: number;
    map: THREE.Texture;
    additive?: boolean;
    fogColor?: number;
  },
): THREE.Points {
  const pos = new Float32Array(items.length * 3);
  const scale = new Float32Array(items.length);
  items.forEach((p, i) => {
    pos[i * 3] = p.x;
    pos[i * 3 + 1] = p.y;
    pos[i * 3 + 2] = p.z;
    scale[i] = p.r;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aScale", new THREE.BufferAttribute(scale, 1));
  const cols = new Float32Array(items.length * 3);
  const tint = new THREE.Color();
  for (let i = 0; i < items.length; i++) {
    if (items[i]?.hex) tint.set(items[i]!.hex!);
    else tint.copy(color);
    cols[i * 3] = tint.r;
    cols[i * 3 + 1] = tint.g;
    cols[i * 3 + 2] = tint.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  const mat = new THREE.ShaderMaterial({
    vertexShader: orbVert,
    fragmentShader: orbFrag,
    uniforms: {
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      uMaxSize: { value: opts.maxPx },
      uMap: { value: opts.map },
      uFogColor: { value: new THREE.Color(opts.fogColor ?? PAPER) },
      uFogNear: { value: 8000 },
      uFogFar: { value: 72000 },
    },
    transparent: Boolean(opts.additive),
    depthWrite: !opts.additive,
    blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    vertexColors: true,
    fog: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

function disposeMesh(obj: THREE.Object3D | undefined, scene: THREE.Scene) {
  if (!obj) return;
  scene.remove(obj);
  obj.traverse((child) => {
    if (
      child instanceof THREE.Points ||
      child instanceof THREE.LineSegments ||
      child instanceof THREE.Mesh
    ) {
      child.geometry.dispose();
      const mat = child.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }
  });
}

export async function attachScene(
  container: HTMLElement,
  handlers: {
    onSelectSystem: (index: number) => void;
    onPickCell: (coords: { x: number; y: number; z: number }) => void;
    onViewIdle?: (coords: { x: number; y: number; z: number }, distance: number) => void;
  },
): Promise<SceneHandle> {
  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.cursor = "pointer";
  container.style.position = container.style.position || "relative";
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PAPER);

  const camera = new THREE.PerspectiveCamera(
    50,
    Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1),
    0.5,
    250000,
  );
  camera.position.set(GALAXY_CORE.x - 8000, 22000, GALAXY_CORE.z - 18000);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(PAPER, 1);
  renderer.setSize(container.clientWidth || 800, container.clientHeight || 600);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(container.clientWidth || 800, container.clientHeight || 600);
  labelRenderer.domElement.style.position = "absolute";
  labelRenderer.domElement.style.inset = "0";
  labelRenderer.domElement.style.pointerEvents = "none";
  container.appendChild(labelRenderer.domElement);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.3;
  controls.rotateSpeed = 0.3;
  controls.zoomSpeed = 2.2;
  controls.panSpeed = 4;
  controls.maxDistance = 120000;
  controls.minDistance = 4;
  controls.target.set(GALAXY_CORE.x, 0, GALAXY_CORE.z);
  controls.addEventListener("end", () => {
    handlers.onViewIdle?.(
      {
        x: controls.target.x,
        y: controls.target.y,
        z: controls.target.z,
      },
      controls.getDistance(),
    );
  });

  const orbMap = makeOrbTexture();
  const nebulaMap = makeNebulaTexture();

  let impostors: THREE.Points | undefined;
  let orbs: THREE.Points | undefined;
  let lines: THREE.LineSegments | undefined;
  let routesLine: THREE.LineSegments | undefined;
  let nebula: THREE.Points | undefined;
  let systems: System[] = [];
  let showGrid = true;
  let showBackdrop = true;
  let theme: VisualTheme = "paper";
  let lastSync:
    | {
        cells: CatalogCell[];
        systems: System[];
        colors?: string[];
        selected?: System;
        hideImpostors?: boolean;
        loadedCellIds?: Set<string>;
        routes?: Route[];
        grid?: boolean;
        backdrop?: boolean;
        theme?: VisualTheme;
      }
    | undefined;

  const gridSpan = GALAXY_RADIUS * 2 + 4000;
  const grid = new THREE.GridHelper(gridSpan, 44, 0xc8c8c2, 0xdddcd6);
  grid.position.set(GALAXY_CORE.x, 0, GALAXY_CORE.z);
  grid.visible = true;
  scene.add(grid);

  const labelGroup = new THREE.Group();
  scene.add(labelGroup);

  const ringGeo = new THREE.RingGeometry(1.15, 1.4, 64);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x1a1a19,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.visible = false;
  scene.add(ring);

  const raycaster = new THREE.Raycaster();

  function nebulaHex(i: number, visual: VisualTheme): string {
    if (visual === "paper") {
      return ["#d2cec6", "#c8c4bc", "#ddd8d0"][i % 3]!;
    }
    if (visual === "charcoal") {
      return ["#3a3a42", "#2e3340", "#403838"][i % 3]!;
    }
    return ["#5a3a58", "#2a4060", "#4a3828", "#3a2a48"][i % 4]!;
  }

  function ensureNebula(visual: VisualTheme) {
    disposeMesh(nebula, scene);
    nebula = undefined;
    const n = 900;
    const items: { x: number; y: number; z: number; r: number; hex: string }[] =
      [];
    for (let i = 0; i < n; i++) {
      const u = hash01(i, 19);
      const v = hash01(i, 5);
      const r = Math.pow(u, 0.65) * (GALAXY_RADIUS * 0.92);
      const th = v * Math.PI * 2 + r / 3400;
      items.push({
        x: GALAXY_CORE.x + Math.cos(th) * r,
        y: (hash01(i, 13) - 0.5) * 900,
        z: GALAXY_CORE.z + Math.sin(th) * r,
        r: 2200 + hash01(i, 8) * 2800,
        hex: nebulaHex(i, visual),
      });
    }
    nebula = orbCloud(items, new THREE.Color(0x888888), {
      maxPx: visual === "paper" ? 48 : 90,
      map: nebulaMap,
      additive: visual !== "paper",
      fogColor: visual === "paper" ? PAPER : visual === "charcoal" ? CHARCOAL : SPACE,
    });
    scene.add(nebula);
  }

  function applyTheme(visual: VisualTheme) {
    theme = visual;
    const bg = visual === "paper" ? PAPER : visual === "charcoal" ? CHARCOAL : SPACE;
    scene.background = new THREE.Color(bg);
    renderer.setClearColor(bg, 1);
    const major = visual === "paper" ? 0xb8b8b2 : 0x3a3a38;
    const minor = visual === "paper" ? 0xd8d8d2 : 0x2a2a28;
    grid.material = Array.isArray(grid.material)
      ? grid.material
      : grid.material;
    const mats = Array.isArray(grid.material) ? grid.material : [grid.material];
    mats.forEach((m, i) => {
      if ("color" in m) (m as THREE.LineBasicMaterial).color.set(i === 0 ? major : minor);
    });
    ringMat.color.set(visual === "paper" ? 0x1a1a19 : 0xe8e8e2);
    container.dataset.theme = visual;
  }

  function sync(state: {
    cells: CatalogCell[];
    systems: System[];
    colors?: string[];
    selected?: System;
    hideImpostors?: boolean;
    loadedCellIds?: Set<string>;
    routes?: Route[];
    grid?: boolean;
    backdrop?: boolean;
    theme?: VisualTheme;
  }) {
    lastSync = state;
    systems = state.systems;
    showGrid = state.grid !== false;
    showBackdrop = state.backdrop !== false;
    if (state.theme && state.theme !== theme) applyTheme(state.theme);
    grid.visible = showGrid;
    if (showBackdrop && !nebula) ensureNebula(theme);
    if (nebula) nebula.visible = showBackdrop;

    disposeMesh(impostors, scene);
    disposeMesh(orbs, scene);
    disposeMesh(lines, scene);
    disposeMesh(routesLine, scene);
    impostors = undefined;
    orbs = undefined;
    lines = undefined;
    routesLine = undefined;
    while (labelGroup.children.length) {
      const child = labelGroup.children[0] as CSS2DObject;
      child.element.remove();
      labelGroup.remove(child);
    }

    const fogColor = theme === "paper" ? PAPER : theme === "charcoal" ? CHARCOAL : SPACE;
    const additive = theme !== "paper";
    if (!state.hideImpostors) {
      const balls = impostorOrbs(state.cells, state.loadedCellIds).map((p, i) => ({
        ...p,
        hex:
          theme === "realistic"
            ? SPECTRAL[i % SPECTRAL.length]!
            : theme === "charcoal"
              ? ["#d8d4cc", "#c4c0b8", "#eeeae2", "#a8a49c"][i % 4]!
              : p.hex,
      }));
      if (balls.length) {
        impostors = orbCloud(balls, new THREE.Color(0x4a4a46), {
          maxPx: 12,
          map: orbMap,
          additive,
          fogColor,
        });
        scene.add(impostors);
      }
    }
    if (state.systems.length) {
      orbs = orbCloud(
        state.systems.map((s, i) => ({
          x: s.coords.x,
          y: s.coords.y,
          z: s.coords.z,
          r: orbScale(s.population),
          hex: state.colors?.[i],
        })),
        new THREE.Color(0x2e2e2c),
        { maxPx: 55, map: orbMap, additive, fogColor },
      );
      scene.add(orbs);
    }
    for (const region of GALACTIC_REGIONS) {
      const el = document.createElement("div");
      el.className = "region-label";
      el.textContent = region.name.toUpperCase();
      const tag = new CSS2DObject(el);
      tag.position.set(region.coords.x, region.coords.y, region.coords.z);
      labelGroup.add(tag);
    }
    ring.visible = Boolean(state.selected);
    if (state.selected) {
      ring.position.set(
        state.selected.coords.x,
        state.selected.coords.y,
        state.selected.coords.z,
      );
    }
    if (state.routes?.length) {
      const verts: number[] = [];
      for (const route of state.routes) {
        for (let i = 1; i < route.points.length; i++) {
          const a = route.points[i - 1]!;
          const b = route.points[i]!;
          verts.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
      }
      if (verts.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute(
          "position",
          new THREE.BufferAttribute(new Float32Array(verts), 3),
        );
        routesLine = new THREE.LineSegments(
          geo,
          new THREE.LineBasicMaterial({
            color: 0xb0b0aa,
            transparent: true,
            opacity: 0.4,
          }),
        );
        scene.add(routesLine);
      }
    }
    if (state.selected && state.systems.length > 1) {
      const origin = state.selected.coords;
      const nearest = [...state.systems]
        .filter((s) => s.name !== state.selected!.name)
        .map((s) => ({
          s,
          d:
            (s.coords.x - origin.x) ** 2 +
            (s.coords.y - origin.y) ** 2 +
            (s.coords.z - origin.z) ** 2,
        }))
        .filter((n) => n.d > 0 && n.d <= 200 * 200)
        .sort((a, b) => a.d - b.d)
        .slice(0, 5);
      if (nearest.length) {
        const verts: number[] = [];
        for (const n of nearest) {
          verts.push(
            origin.x,
            origin.y,
            origin.z,
            n.s.coords.x,
            n.s.coords.y,
            n.s.coords.z,
          );
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute(
          "position",
          new THREE.BufferAttribute(new Float32Array(verts), 3),
        );
        lines = new THREE.LineSegments(
          geo,
          new THREE.LineBasicMaterial({
            color: 0x9a9a94,
            transparent: true,
            opacity: 0.45,
          }),
        );
        scene.add(lines);
      }
    }
  }

  canvas.addEventListener("pointerdown", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    if (orbs) {
      raycaster.params.Points = { threshold: 25 };
      const hits = raycaster.intersectObject(orbs);
      if (hits[0]?.index !== undefined) {
        handlers.onSelectSystem(hits[0].index);
        return;
      }
    }
    const pt = new THREE.Vector3();
    raycaster.ray.at(Math.min(controls.getDistance() * 0.35, 5000), pt);
    handlers.onPickCell({ x: pt.x, y: pt.y, z: pt.z });
  });

  function onResize() {
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
  }
  window.addEventListener("resize", onResize);

  function onContextLost(ev: Event) {
    ev.preventDefault();
  }
  function onContextRestored() {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    onResize();
  }
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);

  let raf = 0;
  function loop() {
    raf = requestAnimationFrame(loop);
    controls.update();
    if (ring.visible) ring.lookAt(camera.position);
    const d = controls.getDistance();
    ring.scale.setScalar(Math.max(1.2, Math.min(18, d * 0.018)));
    labelGroup.visible = d > 6000;
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }
  loop();

  return {
    sync,
    flyCamera(target) {
      controls.target.set(target.x, target.y, target.z);
      camera.position.set(target.x + 22, target.y + 14, target.z + 52);
    },
    flyGalaxy() {
      controls.target.set(GALAXY_CORE.x, 0, GALAXY_CORE.z);
      camera.position.set(GALAXY_CORE.x - 8000, 22000, GALAXY_CORE.z - 18000);
    },
    setTheme(next) {
      applyTheme(next);
      disposeMesh(nebula, scene);
      nebula = undefined;
      if (lastSync) sync({ ...lastSync, theme: next });
    },
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      controls.dispose();
      disposeMesh(impostors, scene);
      disposeMesh(orbs, scene);
      disposeMesh(lines, scene);
      disposeMesh(routesLine, scene);
      disposeMesh(nebula, scene);
      nebulaMap.dispose();
      while (labelGroup.children.length) {
        const child = labelGroup.children[0] as CSS2DObject;
        child.element.remove();
        labelGroup.remove(child);
      }
      scene.remove(labelGroup);
      scene.remove(grid);
      scene.remove(ring);
      ringGeo.dispose();
      ringMat.dispose();
      orbMap.dispose();
      renderer.dispose();
      labelRenderer.domElement.remove();
      canvas.remove();
    },
  };
}
