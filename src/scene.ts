import * as THREE from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  boxelGridWorld,
  boxelSize,
  clampMassCode,
  finestMassCode,
  boxelWindowForView,
  MAX_BOXEL_FLOATS,
  type BoxelWindow,
  type MassCode,
} from "./boxel";
import { orbCloud } from "./orbs";
import { orbScale } from "./palettes";
import { makeRegionLayerAsync, tintRegionLayer } from "./region-labels";
import { GALAXY_CORE, GALAXY_RADIUS } from "./regions";
import type { CatalogCell, Route, System, VisualTheme } from "./types";
import { drawViewGizmo } from "./view-gizmo";

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
    regionGrid?: boolean;
    backdrop?: boolean;
    theme?: VisualTheme;
  }) => void;
  flyCamera: (target: { x: number; y: number; z: number }) => void;
  setPlaneHeight: (y: number) => void;
  planeHeight: () => number;
  setMassCode: (code: MassCode) => void;
  setTheme: (theme: VisualTheme) => void;
  resetTopView: () => void;
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

function regionGridColor(visual: VisualTheme): number {
  if (visual === "paper") return 0x2a2a28;
  if (visual === "charcoal") return 0xeceae4;
  return 0xddd8d0;
}

function boxelGridColor(visual: VisualTheme, major: boolean): number {
  if (visual === "paper") return major ? 0x8a8880 : 0xb0aea6;
  return major ? 0x6a6a66 : 0x4a4a48;
}

function makeBoxelGrid(theme: VisualTheme): THREE.LineSegments {
  const geo = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(new Float32Array(MAX_BOXEL_FLOATS), 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", attr);
  geo.setDrawRange(0, 0);
  const mat = new THREE.LineBasicMaterial({
    color: boxelGridColor(theme, true),
    transparent: true,
    opacity: theme === "paper" ? 0.85 : 0.55,
    depthTest: false,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 2;
  return lines;
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
      const drop = (m: THREE.Material) => {
        const mapped = m as THREE.MeshBasicMaterial;
        mapped.map?.dispose();
        m.dispose();
      };
      if (Array.isArray(mat)) mat.forEach(drop);
      else drop(mat);
    }
  });
}

export async function attachScene(
  container: HTMLElement,
  handlers: {
    onSelectSystem: (index: number) => void;
    onPickCell: (coords: { x: number; y: number; z: number }) => void;
    onViewIdle?: (coords: { x: number; y: number; z: number }, distance: number) => void;
    onPlaneHeight?: (y: number) => void;
    onMassCode?: (code: MassCode, finest: MassCode) => void;
    viewCompass?: HTMLCanvasElement;
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

  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    alpha: false,
  });
  await renderer.init();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(PAPER, 1);
  renderer.setSize(container.clientWidth || 800, container.clientHeight || 600);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.3;
  controls.rotateSpeed = 0.3;
  controls.zoomSpeed = 2.2;
  controls.panSpeed = 4;
  controls.maxDistance = 120000;
  controls.minDistance =
    (10 * 2) / (2 * Math.tan((camera.fov * Math.PI) / 360));
  controls.enablePan = false;
  controls.screenSpacePanning = false;
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
  controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
  controls.target.set(GALAXY_CORE.x, 0, GALAXY_CORE.z);
  controls.addEventListener("start", () => {
    cruising = false;
  });
  controls.addEventListener("change", () => {
    lockLookAtToPlane();
    refreshBoxelGrid();
  });
  controls.addEventListener("end", () => {
    handlers.onViewIdle?.(
      {
        x: controls.target.x,
        y: planeY,
        z: controls.target.z,
      },
      controls.getDistance(),
    );
  });

  let impostors: THREE.Object3D | undefined;
  let orbs: THREE.Object3D | undefined;
  let lines: THREE.LineSegments | undefined;
  let routesLine: THREE.LineSegments | undefined;
  let nebula: THREE.Object3D | undefined;
  let systems: System[] = [];
  let showGrid = true;
  let showRegionGrid = true;
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
        regionGrid?: boolean;
        backdrop?: boolean;
        theme?: VisualTheme;
      }
    | undefined;

  let massCode: MassCode = "a";
  let massCodePref: MassCode | undefined;
  let boxelWin: BoxelWindow | undefined;
  let grid = makeBoxelGrid(theme);
  scene.add(grid);

  const regionGrid = await makeRegionLayerAsync(regionGridColor("paper"));
  scene.add(regionGrid);

  let planeY = 0;
  const cruisePos = new THREE.Vector3();
  const cruiseTarget = new THREE.Vector3();
  const heightPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const _panHit = new THREE.Vector3();
  const _panGrab = new THREE.Vector3();
  const _panRight = new THREE.Vector3();
  const _panFwd = new THREE.Vector3();
  let cruising = false;
  let planePanning = false;
  let panLastX = 0;
  let panLastY = 0;

  function lockLookAtToPlane() {
    controls.target.y = planeY;
  }

  function hitHeightPlane(clientX: number, clientY: number, out: THREE.Vector3): boolean {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    heightPlane.constant = -planeY;
    return raycaster.ray.intersectPlane(heightPlane, out) !== null;
  }

  function panOnHeightPlane(dx: number, dz: number) {
    if (dx === 0 && dz === 0) return;
    camera.position.x += dx;
    camera.position.z += dz;
    controls.target.x += dx;
    controls.target.z += dz;
    controls.target.y = planeY;
    refreshBoxelGrid();
  }

  function panFromPixels(dxPx: number, dyPx: number) {
    camera.updateMatrixWorld();
    _panRight.setFromMatrixColumn(camera.matrixWorld, 0);
    _panRight.y = 0;
    if (_panRight.lengthSq() < 1e-8) _panRight.set(1, 0, 0);
    else _panRight.normalize();
    _panFwd.crossVectors(camera.up, _panRight);
    if (_panFwd.lengthSq() < 1e-8) _panFwd.set(0, 0, 1);
    else _panFwd.normalize();
    const dist = Math.max(8, controls.getDistance());
    const s =
      (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) /
      Math.max(canvas.clientHeight, 1);
    panOnHeightPlane(
      -dxPx * s * _panRight.x - dyPx * s * _panFwd.x,
      -dxPx * s * _panRight.z - dyPx * s * _panFwd.z,
    );
  }

  function planeViewAabb(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    const S = boxelSize(massCode);
    const dist = Math.max(
      Math.abs(camera.position.y - planeY),
      controls.getDistance(),
      1,
    );
    const half = Math.max(
      S * 12,
      dist * Math.tan((camera.fov * Math.PI) / 360) * Math.max(camera.aspect, 1) * 1.5,
    );
    const cx = controls.target.x;
    const cz = controls.target.z;
    return {
      minX: cx - half,
      maxX: cx + half,
      minZ: cz - half,
      maxZ: cz + half,
    };
  }

  let lastFinest: MassCode | undefined;

  function syncMassCodeForZoom() {
    const finest = finestMassCode(
      controls.getDistance(),
      camera.fov,
      container.clientHeight || 600,
    );
    const preferred = massCodePref ?? finest;
    const next = clampMassCode(preferred, finest);
    const codeChanged = next !== massCode;
    if (codeChanged) {
      massCode = next;
      boxelWin = undefined;
    }
    if (codeChanged || finest !== lastFinest) {
      lastFinest = finest;
      handlers.onMassCode?.(massCode, finest);
    }
  }

  function fitCameraNear() {
    const dist = Math.max(controls.getDistance(), 0.5);
    const near = Math.max(0.02, Math.min(2, dist * 0.05));
    if (Math.abs(camera.near - near) > 0.01) {
      camera.near = near;
      camera.updateProjectionMatrix();
    }
    const minD =
      (boxelSize("a") * 2) / (2 * Math.tan((camera.fov * Math.PI) / 360));
    if (Math.abs(controls.minDistance - minD) > 0.5) controls.minDistance = minD;
  }

  function refreshBoxelGrid() {
    grid.position.set(0, planeY, 0);
    fitCameraNear();
    syncMassCodeForZoom();
    const next = boxelWindowForView(planeViewAabb(), massCode, boxelWin, {
      x: controls.target.x,
      z: controls.target.z,
    });
    if (next === boxelWin) return;
    boxelWin = next;
    const attr = grid.geometry.getAttribute("position") as THREE.BufferAttribute;
    const filled = boxelGridWorld(next, attr.array as Float32Array);
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, filled.length);
    attr.needsUpdate = true;
    grid.geometry.setDrawRange(0, filled.length / 3);
    grid.geometry.computeBoundingSphere();
  }

  function rebuildBoxelGrid() {
    boxelWin = undefined;
    refreshBoxelGrid();
  }

  function applyPlaneY(y: number, moveCamera: boolean) {
    const dy = y - planeY;
    if (Math.abs(dy) < 0.05) return;
    planeY = y;
    refreshBoxelGrid();
    regionGrid.position.y = planeY;
    if (moveCamera) {
      camera.position.y += dy;
      controls.target.y += dy;
    }
    handlers.onPlaneHeight?.(planeY);
  }

  function pickBand(): number {
    return Math.max(80, Math.min(350, controls.getDistance() * 0.03));
  }

  refreshBoxelGrid();

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
      additive: visual !== "paper",
      fogColor: visual === "paper" ? PAPER : visual === "charcoal" ? CHARCOAL : SPACE,
      soft: true,
    });
    scene.add(nebula);
  }

  function applyTheme(visual: VisualTheme) {
    theme = visual;
    const bg = visual === "paper" ? PAPER : visual === "charcoal" ? CHARCOAL : SPACE;
    scene.background = new THREE.Color(bg);
    renderer.setClearColor(bg, 1);
    const gmat = grid.material as THREE.LineBasicMaterial;
    gmat.color.set(boxelGridColor(visual, true));
    gmat.opacity = visual === "paper" ? 0.7 : 0.45;
    tintRegionLayer(regionGrid, regionGridColor(visual), visual === "paper" ? 0.94 : 0.9);
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
    regionGrid?: boolean;
    backdrop?: boolean;
    theme?: VisualTheme;
  }) {
    lastSync = state;
    systems = state.systems;
    showGrid = state.grid !== false;
    showRegionGrid = state.regionGrid !== false;
    showBackdrop = state.backdrop !== false;
    if (state.theme && state.theme !== theme) applyTheme(state.theme);
    grid.visible = showGrid;
    regionGrid.visible = showRegionGrid;
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
        { maxPx: 55, additive, fogColor },
      );
      scene.add(orbs);
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

  function onPickPointerDown(ev: PointerEvent) {
    if (ev.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    if (orbs) {
      const hits = raycaster.intersectObject(orbs);
      const band = pickBand();
      for (const hit of hits) {
        const id = hit.instanceId ?? hit.index;
        if (id === undefined) continue;
        const sys = systems[id];
        if (!sys) continue;
        if (Math.abs(sys.coords.y - planeY) > band) continue;
        handlers.onSelectSystem(id);
        return;
      }
    }
    const pt = new THREE.Vector3();
    raycaster.ray.at(Math.min(controls.getDistance() * 0.35, 5000), pt);
    handlers.onPickCell({ x: pt.x, y: pt.y, z: pt.z });
  }

  function onPlanePanDown(ev: PointerEvent) {
    if (ev.button !== 2) return;
    ev.preventDefault();
    cruising = false;
    planePanning = true;
    panLastX = ev.clientX;
    panLastY = ev.clientY;
    hitHeightPlane(ev.clientX, ev.clientY, _panGrab);
    canvas.setPointerCapture(ev.pointerId);
  }

  function onPlanePanMove(ev: PointerEvent) {
    if (!planePanning) return;
    if (hitHeightPlane(ev.clientX, ev.clientY, _panHit)) {
      panOnHeightPlane(_panGrab.x - _panHit.x, _panGrab.z - _panHit.z);
    } else {
      panFromPixels(ev.clientX - panLastX, ev.clientY - panLastY);
    }
    panLastX = ev.clientX;
    panLastY = ev.clientY;
  }

  function onPlanePanUp(ev: PointerEvent) {
    if (!planePanning) return;
    if (ev.type === "pointerup" && ev.button !== 2) return;
    planePanning = false;
    try {
      canvas.releasePointerCapture(ev.pointerId);
    } catch {
      /* not captured */
    }
    handlers.onViewIdle?.(
      {
        x: controls.target.x,
        y: planeY,
        z: controls.target.z,
      },
      controls.getDistance(),
    );
  }

  function onContextMenu(ev: Event) {
    ev.preventDefault();
  }

  canvas.addEventListener("pointerdown", onPickPointerDown);
  canvas.addEventListener("pointerdown", onPlanePanDown);
  canvas.addEventListener("pointermove", onPlanePanMove);
  canvas.addEventListener("pointerup", onPlanePanUp);
  canvas.addEventListener("pointercancel", onPlanePanUp);
  canvas.addEventListener("contextmenu", onContextMenu);

  function onResize() {
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
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
    if (cruising) {
      camera.position.lerp(cruisePos, 0.12);
      controls.target.lerp(cruiseTarget, 0.12);
      lockLookAtToPlane();
      if (camera.position.distanceTo(cruisePos) < 1.5) cruising = false;
    } else {
      controls.update();
      lockLookAtToPlane();
    }
    refreshBoxelGrid();
    if (ring.visible) ring.lookAt(camera.position);
    const d = controls.getDistance();
    ring.scale.setScalar(Math.max(1.2, Math.min(18, d * 0.018)));
    if (handlers.viewCompass) drawViewGizmo(handlers.viewCompass, camera, theme);
    renderer.render(scene, camera);
  }
  loop();

  return {
    sync,
    flyCamera(target) {
      cruiseTarget.set(target.x, planeY, target.z);
      cruisePos.set(target.x + 22, planeY + 14, target.z + 52);
      cruising = true;
    },
    setPlaneHeight(y) {
      applyPlaneY(y, true);
    },
    planeHeight() {
      return planeY;
    },
    setMassCode(code) {
      const finest = finestMassCode(
        controls.getDistance(),
        camera.fov,
        container.clientHeight || 600,
      );
      const next = clampMassCode(code, finest);
      massCodePref = code === next ? next : undefined;
      lastFinest = finest;
      if (next === massCode) {
        handlers.onMassCode?.(massCode, finest);
        return;
      }
      massCode = next;
      rebuildBoxelGrid();
      handlers.onMassCode?.(massCode, finest);
    },
    setTheme(next) {
      applyTheme(next);
      disposeMesh(nebula, scene);
      nebula = undefined;
      if (lastSync) sync({ ...lastSync, theme: next });
    },
    resetTopView() {
      cruising = false;
      const d = Math.max(80, controls.getDistance());
      const tx = controls.target.x;
      const tz = controls.target.z;
      const oc = controls as OrbitControls & {
        _sphericalDelta: THREE.Spherical;
        _panOffset: THREE.Vector3;
        _scale: number;
      };
      oc._sphericalDelta.set(0, 0, 0);
      oc._panOffset.set(0, 0, 0);
      oc._scale = 1;
      controls.target.set(tx, planeY, tz);
      camera.up.set(0, 1, 0);
      const phi = 0.04;
      camera.position.set(
        tx,
        planeY + d * Math.cos(phi),
        tz - d * Math.sin(phi),
      );
      const damping = controls.enableDamping;
      controls.enableDamping = false;
      controls.update();
      controls.enableDamping = damping;
      lockLookAtToPlane();
      refreshBoxelGrid();
    },
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onPickPointerDown);
      canvas.removeEventListener("pointerdown", onPlanePanDown);
      canvas.removeEventListener("pointermove", onPlanePanMove);
      canvas.removeEventListener("pointerup", onPlanePanUp);
      canvas.removeEventListener("pointercancel", onPlanePanUp);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      controls.dispose();
      disposeMesh(impostors, scene);
      disposeMesh(orbs, scene);
      disposeMesh(lines, scene);
      disposeMesh(routesLine, scene);
      disposeMesh(nebula, scene);
      disposeMesh(regionGrid, scene);
      scene.remove(grid);
      scene.remove(ring);
      ringGeo.dispose();
      ringMat.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
