import * as THREE from "three/webgpu";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";
import {
  boxelGridWorld,
  boxelSize,
  effectiveBoxelMassCode,
  finestMassCode,
  boxelWindowForView,
  MAX_BOXEL_FLOATS,
  type BoxelWindow,
  type MassCode,
} from "./boxel";
import {
  densityFieldColor,
  orbCloud,
  stableOrbNoise,
  stableOrbVisibility,
} from "./orbs";
import { orbScale } from "./palettes";
import { makeRegionLayerAsync, tintRegionLayer } from "./region-labels";
import { GALAXY_CORE } from "./regions";
import type { GalaxyCameraView, Route, System, VisualTheme } from "./types";
import { drawViewGizmo } from "./view-gizmo";

const PAPER = 0xeaeae8;
const CHARCOAL = 0x1c1c1b;
const SPACE = 0x07060c;

export function selectionRingScale(viewDistance: number): number {
  return Math.max(1.2, viewDistance * 0.018);
}
export function selectionPlaneHeight(
  currentPlaneY: number,
  selected: { x: number; y: number; z: number } | undefined,
): number {
  return selected?.y ?? currentPlaneY;
}

function systemIdentity(system: System): string {
  return String(system.id64 ?? `${system.name}\0${system.coords.x}\0${system.coords.y}\0${system.coords.z}`);
}

export function selectionRailIndexes(
  systems: readonly System[],
  selected: System | undefined,
  eligible?: readonly boolean[],
  maximumNeighbors = 5,
  maximumDistanceLy = 200,
): number[] {
  if (!selected) return [];
  const selectedIdentity = systemIdentity(selected);
  const maximumDistanceSquared = maximumDistanceLy * maximumDistanceLy;
  return systems
    .map((system, index) => ({
      system,
      index,
      distanceSquared:
        (system.coords.x - selected.coords.x) ** 2 +
        (system.coords.y - selected.coords.y) ** 2 +
        (system.coords.z - selected.coords.z) ** 2,
    }))
    .filter(
      ({ system, index, distanceSquared }) =>
        systemIdentity(system) !== selectedIdentity &&
        (eligible?.[index] ?? true) &&
        distanceSquared > 0 &&
        distanceSquared <= maximumDistanceSquared,
    )
    .sort((left, right) =>
      left.distanceSquared - right.distanceSquared || left.index - right.index,
    )
    .slice(0, Math.max(0, maximumNeighbors))
    .map(({ index }) => index);
}

export function railSelectableIndex(
  candidateIndex: number,
  railIndexes: readonly number[],
  hasSelection: boolean,
): boolean {
  return !hasSelection || railIndexes.includes(candidateIndex);
}
export function cameraAnchorTarget(
  selected: { x: number; y: number; z: number } | undefined,
  _planeY: number,
): { x: number; y: number; z: number } | undefined {
  return selected ? { ...selected } : undefined;
}
export function cameraAnchorAfterPlanePanStart(
  _selected: { x: number; y: number; z: number } | undefined,
): undefined {
  return undefined;
}
export function isPrimaryClickGesture(
  button: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  maximumMovementPx = 5,
): boolean {
  if (button !== 0) return false;
  return Math.hypot(endX - startX, endY - startY) <= maximumMovementPx;
}
export function cameraCruiseProgress(elapsedMs: number, durationMs = 650): number {
  const linear = Math.min(1, Math.max(0, elapsedMs / Math.max(1, durationMs)));
  return 1 - (1 - linear) ** 3;
}
export function regionLabelsVisible(viewDistanceLy: number): boolean {
  return viewDistanceLy >= 2_000;
}

export function planarPanDelta(
  dxPx: number,
  dyPx: number,
  worldPerPixel: number,
  right: { x: number; z: number },
  forward: { x: number; z: number },
): { x: number; z: number } {
  return {
    x: -dxPx * worldPerPixel * right.x + dyPx * worldPerPixel * forward.x,
    z: -dxPx * worldPerPixel * right.z + dyPx * worldPerPixel * forward.z,
  };
}

export function cameraPlanarPanAxes(camera: THREE.Camera): {
  right: { x: number; z: number };
  up: { x: number; z: number };
} {
  camera.updateMatrixWorld();
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  right.y = 0;
  up.y = 0;
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
  else right.normalize();
  if (up.lengthSq() < 1e-8) up.set(0, 0, 1);
  else up.normalize();
  return {
    right: { x: right.x, z: right.z },
    up: { x: up.x, z: up.z },
  };
}

export function createMapControls(
  camera: THREE.Camera,
  canvas: HTMLElement,
): TrackballControls {
  const controls = new TrackballControls(camera, canvas);
  controls.rotateSpeed = 0.65;
  controls.zoomSpeed = 2.2;
  controls.panSpeed = 4;
  controls.staticMoving = true;
  controls.noPan = true;
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
  controls.mouseButtons.RIGHT = null;
  return controls;
}

export const MAX_CAMERA_DISTANCE_LY = 120_000;

export function minimumCameraDistanceLy(fovDegrees = 50): number {
  return 10 / Math.tan((fovDegrees * Math.PI) / 360);
}

export function cameraZoomPercent(
  distanceLy: number,
  minimumDistanceLy = minimumCameraDistanceLy(),
  maximumDistanceLy = MAX_CAMERA_DISTANCE_LY,
): number {
  const minimum = Math.max(Number.EPSILON, minimumDistanceLy);
  const maximum = Math.max(minimum + Number.EPSILON, maximumDistanceLy);
  const distance = Math.min(maximum, Math.max(minimum, distanceLy));
  return Math.round(
    ((Math.log(maximum) - Math.log(distance)) /
      (Math.log(maximum) - Math.log(minimum))) *
      100,
  );
}

export function topViewCameraPosition(
  targetX: number,
  planeY: number,
  targetZ: number,
  distance: number,
  tilt = 0.04,
): { x: number; y: number; z: number } {
  return {
    x: targetX,
    y: planeY - distance * Math.cos(tilt),
    z: targetZ + distance * Math.sin(tilt),
  };
}

export function createSceneResizeScheduler(
  measure: () => { width: number; height: number },
  apply: (width: number, height: number) => void,
  schedule: (callback: () => void) => number = (callback) =>
    window.setTimeout(callback, 120),
  cancel: (handle: number) => void = (handle) => window.clearTimeout(handle),
): { request: () => void; destroy: () => void } {
  let resizeTimer: number | undefined;
  let destroyed = false;
  let lastWidth = -1;
  let lastHeight = -1;
  const request = () => {
    if (destroyed) return;
    if (resizeTimer !== undefined) cancel(resizeTimer);
    const scheduled = schedule(() => {
      if (resizeTimer !== scheduled) return;
      resizeTimer = undefined;
      if (destroyed) return;
      const measured = measure();
      const width = Math.floor(measured.width);
      const height = Math.floor(measured.height);
      if (width <= 0 || height <= 0) return;
      if (width === lastWidth && height === lastHeight) return;
      lastWidth = width;
      lastHeight = height;
      apply(width, height);
    });
    resizeTimer = scheduled;
  };
  return {
    request,
    destroy() {
      destroyed = true;
      if (resizeTimer !== undefined) cancel(resizeTimer);
      resizeTimer = undefined;
    },
  };
}

const MAX_SCENE_FRAMEBUFFER_PIXELS = 12_000_000;

export function scenePixelRatio(
  width: number,
  height: number,
  devicePixelRatio: number,
): number {
  const cssPixels = Math.max(1, width) * Math.max(1, height);
  const maximumForArea = Math.sqrt(MAX_SCENE_FRAMEBUFFER_PIXELS / cssPixels);
  const requested = Number.isFinite(devicePixelRatio)
    ? Math.max(Number.EPSILON, devicePixelRatio)
    : 1;
  return Math.max(
    Number.EPSILON,
    Math.min(2, requested, maximumForArea),
  );
}
export type SceneHandle = {
  sync: (state: {
    systems: System[];
    colors?: string[];
    details?: boolean[];
    densityWeights?: number[];
    selected?: System;
    routes?: Route[];
    grid?: boolean;
    regionGrid?: boolean;
    theme?: VisualTheme;
  }) => void;
  flyCamera: (target: { x: number; y: number; z: number }) => void;
  setPlaneHeight: (y: number) => void;
  planeHeight: () => number;
  setMassCode: (code: MassCode) => void;
  resetTopView: () => void;
  viewState: () => GalaxyCameraView;
  destroy: () => void;
};

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
    initialTheme?: VisualTheme;
    onViewChange?: (view: GalaxyCameraView) => void;
    onViewIdle?: (view: GalaxyCameraView) => void;
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

  const initialTheme = handlers.initialTheme ?? "realistic";
  const initialBackground =
    initialTheme === "paper" ? PAPER : initialTheme === "charcoal" ? CHARCOAL : SPACE;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(initialBackground);

  const camera = new THREE.PerspectiveCamera(
    50,
    Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1),
    0.5,
    250000,
  );
  const initialCameraPosition = topViewCameraPosition(
    GALAXY_CORE.x,
    0,
    GALAXY_CORE.z,
    90_000,
  );
  camera.position.set(
    initialCameraPosition.x,
    initialCameraPosition.y,
    initialCameraPosition.z,
  );

  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    alpha: false,
  });
  await renderer.init();
  const initialWidth = container.clientWidth || 800;
  const initialHeight = container.clientHeight || 600;
  renderer.setPixelRatio(
    scenePixelRatio(initialWidth, initialHeight, window.devicePixelRatio),
  );
  renderer.setClearColor(initialBackground, 1);
  renderer.setSize(initialWidth, initialHeight, false);

  const controls = createMapControls(camera, canvas);
  let planeY = 0;
  controls.maxDistance = MAX_CAMERA_DISTANCE_LY;
  controls.minDistance = minimumCameraDistanceLy(camera.fov);
  controls.target.set(GALAXY_CORE.x, 0, GALAXY_CORE.z);
  controls.update();

  const controlsDistance = () => camera.position.distanceTo(controls.target);

  function currentViewState(): GalaxyCameraView {
    camera.updateMatrixWorld();
    const distanceLy = controlsDistance();
    const direction = camera.getWorldDirection(new THREE.Vector3()).normalize();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const nearDistance = Math.max(camera.near, Math.min(1_280, distanceLy * 0.05));
    const farDistance = Math.min(200_000, Math.max(2_560, distanceLy * 2.25));
    const verticalTangent = Math.tan((camera.fov * Math.PI) / 360);
    const bounds = new THREE.Box3();
    for (const depth of [nearDistance, farDistance]) {
      const center = camera.position.clone().addScaledVector(direction, depth);
      const halfHeight = verticalTangent * depth;
      const halfWidth = halfHeight * camera.aspect;
      for (const horizontal of [-1, 1]) {
        for (const vertical of [-1, 1]) {
          bounds.expandByPoint(
            center
              .clone()
              .addScaledVector(right, horizontal * halfWidth)
              .addScaledVector(up, vertical * halfHeight),
          );
        }
      }
    }
    bounds.expandByPoint(camera.position);
    bounds.expandByPoint(controls.target);
    return {
      target: {
        x: controls.target.x,
        y: controls.target.y,
        z: controls.target.z,
      },
      position: {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
      },
      direction: { x: direction.x, y: direction.y, z: direction.z },
      distanceLy,
      verticalFovDegrees: camera.fov,
      aspect: camera.aspect,
      visibleBounds: {
        minimum: { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z },
        maximum: { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z },
      },
    };
  }

  controls.addEventListener("start", () => {
    cruising = false;
  });
  let viewChangeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastViewChangeAt = 0;
  function emitViewChange() {
    if (!handlers.onViewChange) return;
    const elapsed = performance.now() - lastViewChangeAt;
    if (elapsed >= 90) {
      lastViewChangeAt = performance.now();
      handlers.onViewChange(currentViewState());
      return;
    }
    if (viewChangeTimer !== undefined) return;
    viewChangeTimer = setTimeout(() => {
      viewChangeTimer = undefined;
      lastViewChangeAt = performance.now();
      handlers.onViewChange?.(currentViewState());
    }, 90 - elapsed);
  }
  controls.addEventListener("change", () => {
    lockLookAtToPlane();
    refreshBoxelGrid();
    emitViewChange();
  });
  controls.addEventListener("end", () => {
    handlers.onViewIdle?.(currentViewState());
  });

  let orbs: THREE.Object3D | undefined;
  let densityField: THREE.Object3D | undefined;
  let orbColors: (string | undefined)[] = [];
  let orbDetails: boolean[] = [];
  let orbSelected: boolean[] = [];
  let orbFocused: boolean[] = [];
  let orbDensityWeights: number[] = [];
  let orbTheme: VisualTheme | undefined;
  let lines: THREE.LineSegments | undefined;
  let routesLine: THREE.LineSegments | undefined;
  let systems: System[] = [];
  let showGrid = true;
  let showRegionGrid = true;
  let theme: VisualTheme = initialTheme;
  let massCode: MassCode = "h";
  let boxelWin: BoxelWindow | undefined;
  let grid = makeBoxelGrid(theme);
  scene.add(grid);

  const regionGrid = await makeRegionLayerAsync(regionGridColor(theme));
  const regionLabels: THREE.Mesh[] = [];
  regionGrid.traverse((child) => {
    if (child instanceof THREE.Mesh && child.userData.regionLabel) {
      regionLabels.push(child);
    }
  });
  let showRegionLabels = true;
  scene.add(regionGrid);

  const cruisePos = new THREE.Vector3();
  const cruiseTarget = new THREE.Vector3();
  const cruiseFromPos = new THREE.Vector3();
  const cruiseFromTarget = new THREE.Vector3();
  const panRaycaster = new THREE.Raycaster();
  const panPlane = new THREE.Plane();
  const panPlanePoint = new THREE.Vector3();
  const panCurrentPoint = new THREE.Vector3();
  let cruising = false;
  let cruiseStartedAt = 0;
  let planePanning = false;
  let panLastX = 0;
  let panLastY = 0;
  let panGrabPoint: THREE.Vector3 | undefined;
  let selectedAnchor: THREE.Vector3 | undefined;
  let selectedSystemKey: string | undefined;
  let selectionRails: number[] = [];

  function lockLookAtToPlane() {
    const anchor = cameraAnchorTarget(selectedAnchor, planeY);
    if (anchor) controls.target.set(anchor.x, anchor.y, anchor.z);
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
    const axes = cameraPlanarPanAxes(camera);
    const dist = Math.max(8, controlsDistance());
    const s =
      (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) /
      Math.max(canvas.clientHeight, 1);
    const delta = planarPanDelta(dxPx, dyPx, s, axes.right, axes.up);
    panOnHeightPlane(delta.x, delta.z);
  }

  function pointOnHeightPlane(clientX: number, clientY: number): THREE.Vector3 | undefined {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    panRaycaster.setFromCamera(
      new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    );
    panPlane.set(new THREE.Vector3(0, 1, 0), -planeY);
    return panRaycaster.ray.intersectPlane(panPlane, panPlanePoint)
      ? panPlanePoint.clone()
      : undefined;
  }

  function planeViewAabb(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    const S = boxelSize(massCode);
    const dist = Math.max(
      Math.abs(camera.position.y - planeY),
      controlsDistance(),
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
      controlsDistance(),
      camera.fov,
      container.clientHeight || 600,
    );
    const next = effectiveBoxelMassCode(massCode, finest);
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
    const dist = Math.max(controlsDistance(), 0.5);
    const near = Math.max(0.02, Math.min(2, dist * 0.05));
    if (Math.abs(camera.near - near) > 0.01) {
      camera.near = near;
      camera.updateProjectionMatrix();
    }
    const minD = minimumCameraDistanceLy(camera.fov);
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

  refreshBoxelGrid();

  const ringGeo = new THREE.RingGeometry(1.15, 1.4, 64);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x1a1a19,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.visible = false;
  ring.renderOrder = 10;
  scene.add(ring);

  const raycaster = new THREE.Raycaster();
  const projectedRailTarget = new THREE.Vector3();

  function snappedRailTarget(clientX: number, clientY: number): number | undefined {
    if (!selectedSystemKey || selectionRails.length === 0) return undefined;
    const rect = canvas.getBoundingClientRect();
    let bestIndex: number | undefined;
    let bestDistanceSquared = 18 * 18;
    for (const index of selectionRails) {
      const system = systems[index];
      if (!system) continue;
      projectedRailTarget
        .set(system.coords.x, system.coords.y, system.coords.z)
        .project(camera);
      if (projectedRailTarget.z < -1 || projectedRailTarget.z > 1) continue;
      const screenX = rect.left + ((projectedRailTarget.x + 1) * 0.5) * rect.width;
      const screenY = rect.top + ((1 - projectedRailTarget.y) * 0.5) * rect.height;
      const distanceSquared =
        (clientX - screenX) ** 2 + (clientY - screenY) ** 2;
      if (distanceSquared > bestDistanceSquared) continue;
      bestDistanceSquared = distanceSquared;
      bestIndex = index;
    }
    return bestIndex;
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

  applyTheme(initialTheme);

  function sync(state: {
    systems: System[];
    colors?: string[];
    details?: boolean[];
    densityWeights?: number[];
    selected?: System;
    routes?: Route[];
    grid?: boolean;
    regionGrid?: boolean;
    theme?: VisualTheme;
  }) {
    const nextSelectedSystemKey = state.selected
      ? String(state.selected.id64 ?? state.selected.name)
      : undefined;
    const nextColors = state.systems.map((_, index) => state.colors?.[index]);
    const nextDetails = state.systems.map((_, index) => Boolean(state.details?.[index]));
    const nextSelected = state.systems.map(
      (system) =>
        nextSelectedSystemKey !== undefined &&
        String(system.id64 ?? system.name) === nextSelectedSystemKey,
    );
    const nextDensityWeights = state.systems.map((_, index) =>
      Math.min(1, Math.max(0, state.densityWeights?.[index] ?? 0)),
    );
    const nextSelectionRails = selectionRailIndexes(
      state.systems,
      state.selected,
      nextDetails,
    );
    const focusedIndexes = new Set(nextSelectionRails);
    const nextFocused = nextSelected.map(
      (isSelected, index) => isSelected || focusedIndexes.has(index),
    );
    const rebuildOrbs =
      orbTheme !== (state.theme ?? theme) ||
      state.systems.length !== systems.length ||
      state.systems.some(
        (system, index) =>
          system !== systems[index] ||
          nextColors[index] !== orbColors[index] ||
          nextDetails[index] !== orbDetails[index] ||
          nextSelected[index] !== orbSelected[index] ||
          nextFocused[index] !== orbFocused[index] ||
          nextDensityWeights[index] !== orbDensityWeights[index],
      );
    systems = state.systems;
    if (nextSelectedSystemKey !== selectedSystemKey) {
      selectedSystemKey = nextSelectedSystemKey;
      selectedAnchor = state.selected
        ? new THREE.Vector3(
            state.selected.coords.x,
            state.selected.coords.y,
            state.selected.coords.z,
          )
        : undefined;
      const nextPlaneY = selectionPlaneHeight(planeY, state.selected?.coords);
      if (nextPlaneY !== planeY) applyPlaneY(nextPlaneY, false);
    }
    showGrid = state.grid !== false;
    showRegionGrid = state.regionGrid !== false;
    if (state.theme && state.theme !== theme) applyTheme(state.theme);
    grid.visible = showGrid;
    regionGrid.visible = showRegionGrid;

    if (rebuildOrbs) {
      disposeMesh(orbs, scene);
      disposeMesh(densityField, scene);
    }
    disposeMesh(lines, scene);
    disposeMesh(routesLine, scene);
    if (rebuildOrbs) {
      orbs = undefined;
      densityField = undefined;
    }
    lines = undefined;
    routesLine = undefined;

    const additive = false;
    if (rebuildOrbs && state.systems.length) {
      const unresolvedDensity = state.systems
        .map((system, index) => ({ system, index }))
        .filter(({ index }) => nextDensityWeights[index]! > 0);
      if (unresolvedDensity.length) {
        densityField = orbCloud(
          unresolvedDensity.map(({ system, index }) => ({
            x: system.coords.x,
            y: system.coords.y,
            z: system.coords.z,
            r: 1,
            hex:
              state.theme === "realistic"
                ? densityFieldColor(
                    system.coords,
                    String(system.id64 ?? system.name),
                  ).hex
                : state.theme === "paper"
                  ? "#706f69"
                  : "#d8d0c0",
            visibility:
              stableOrbVisibility(String(system.id64 ?? system.name)) *
              (0.35 + 0.65 * nextDensityWeights[index]!),
            opacityNoise: stableOrbNoise(
              String(system.id64 ?? system.name),
              0xd31f13,
            ),
          })),
          new THREE.Color(0xd8d0c0),
          {
            maxPx: 14,
            soft: true,
            density: true,
            pickable: false,
          },
        );
        densityField.renderOrder = 1;
        scene.add(densityField);
      }
      orbs = orbCloud(
        state.systems.map((s, i) => ({
          x: s.coords.x,
          y: s.coords.y,
          z: s.coords.z,
          r: orbScale(s.stellarRadiusMeters),
          hex: state.colors?.[i],
          visibility: stableOrbVisibility(String(s.id64 ?? s.name)),
          opacityNoise: stableOrbNoise(String(s.id64 ?? s.name), 0xa17fa9),
          detail: nextDetails[i],
          selected: nextSelected[i],
          focused: nextFocused[i],
        })),
        new THREE.Color(0x2e2e2c),
        { maxPx: 12, additive },
      );
      orbs.renderOrder = 3;
      scene.add(orbs);
    }
    if (rebuildOrbs) {
      orbColors = nextColors;
      orbDetails = nextDetails;
      orbSelected = nextSelected;
      orbFocused = nextFocused;
      orbDensityWeights = nextDensityWeights;
      orbTheme = theme;
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
    selectionRails = nextSelectionRails;
    if (state.selected && selectionRails.length) {
      const origin = state.selected.coords;
      const verts: number[] = [];
      for (const index of selectionRails) {
        const neighbor = state.systems[index]!;
        verts.push(
          origin.x,
          origin.y,
          origin.z,
          neighbor.coords.x,
          neighbor.coords.y,
          neighbor.coords.z,
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

  let primaryPickStart:
    | { pointerId: number; x: number; y: number; button: number }
    | undefined;

  function pickAt(clientX: number, clientY: number) {
    const snappedIndex = snappedRailTarget(clientX, clientY);
    if (snappedIndex !== undefined) {
      handlers.onSelectSystem(snappedIndex);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    if (orbs) {
      const hits = raycaster.intersectObject(orbs);
      for (const hit of hits) {
        const id = hit.instanceId ?? hit.index;
        if (id === undefined) continue;
        const sys = systems[id];
        if (!sys) continue;
        if (!railSelectableIndex(id, selectionRails, Boolean(selectedSystemKey))) {
          continue;
        }
        handlers.onSelectSystem(id);
        return;
      }
    }
    const pt = new THREE.Vector3();
    raycaster.ray.at(Math.min(controlsDistance() * 0.35, 5000), pt);
    handlers.onPickCell({ x: pt.x, y: pt.y, z: pt.z });
  }

  function onPickPointerDown(ev: PointerEvent) {
    if (ev.button !== 0) return;
    primaryPickStart = {
      pointerId: ev.pointerId,
      x: ev.clientX,
      y: ev.clientY,
      button: ev.button,
    };
  }

  function onPickPointerUp(ev: PointerEvent) {
    const start = primaryPickStart;
    if (!start || start.pointerId !== ev.pointerId) return;
    primaryPickStart = undefined;
    if (
      isPrimaryClickGesture(
        start.button,
        start.x,
        start.y,
        ev.clientX,
        ev.clientY,
      )
    ) {
      pickAt(ev.clientX, ev.clientY);
    }
  }

  function onPickPointerCancel(ev: PointerEvent) {
    if (primaryPickStart?.pointerId === ev.pointerId) primaryPickStart = undefined;
  }

  function onPlanePanDown(ev: PointerEvent) {
    if (ev.button !== 2) return;
    ev.preventDefault();
    cruising = false;
    selectedAnchor = cameraAnchorAfterPlanePanStart(selectedAnchor);
    planePanning = true;
    panLastX = ev.clientX;
    panLastY = ev.clientY;
    panGrabPoint = pointOnHeightPlane(ev.clientX, ev.clientY);
    canvas.setPointerCapture(ev.pointerId);
  }

  function onPlanePanMove(ev: PointerEvent) {
    if (!planePanning) return;
    const currentPoint = panGrabPoint
      ? pointOnHeightPlane(ev.clientX, ev.clientY)
      : undefined;
    if (panGrabPoint && currentPoint) {
      panCurrentPoint.copy(panGrabPoint).sub(currentPoint);
      panOnHeightPlane(panCurrentPoint.x, panCurrentPoint.z);
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
    panGrabPoint = undefined;
    try {
      canvas.releasePointerCapture(ev.pointerId);
    } catch {
      /* not captured */
    }
    handlers.onViewIdle?.(currentViewState());
  }

  function onContextMenu(ev: Event) {
    ev.preventDefault();
  }

  canvas.addEventListener("pointerdown", onPickPointerDown);
  canvas.addEventListener("pointerup", onPickPointerUp);
  canvas.addEventListener("pointercancel", onPickPointerCancel);
  canvas.addEventListener("pointerdown", onPlanePanDown);
  canvas.addEventListener("pointermove", onPlanePanMove);
  canvas.addEventListener("pointerup", onPlanePanUp);
  canvas.addEventListener("pointercancel", onPlanePanUp);
  canvas.addEventListener("contextmenu", onContextMenu);

  const resize = createSceneResizeScheduler(
    () => ({ width: container.clientWidth, height: container.clientHeight }),
    (width, height) => {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(
        scenePixelRatio(width, height, window.devicePixelRatio),
      );
      renderer.setSize(width, height, false);
      controls.handleResize();
    },
  );
  function onResize() {
    resize.request();
  }
  window.addEventListener("resize", onResize);

  function onContextLost(ev: Event) {
    ev.preventDefault();
  }
  function onContextRestored() {
    onResize();
  }
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);

  let raf = 0;
  function loop() {
    raf = requestAnimationFrame(loop);
    if (cruising) {
      const progress = cameraCruiseProgress(performance.now() - cruiseStartedAt);
      camera.position.lerpVectors(cruiseFromPos, cruisePos, progress);
      controls.target.lerpVectors(cruiseFromTarget, cruiseTarget, progress);
      lockLookAtToPlane();
      if (progress >= 1) {
        cruising = false;
        handlers.onViewIdle?.(currentViewState());
      }
    } else {
      controls.update();
      lockLookAtToPlane();
    }
    // The controls apply their look-at before our persistent selection lock.
    // Re-aim after the lock so the selected System stays at the true view center.
    camera.lookAt(controls.target);
    camera.updateMatrixWorld();
    refreshBoxelGrid();
    if (ring.visible) ring.lookAt(camera.position);
    const d = controlsDistance();
    const nextShowRegionLabels = regionLabelsVisible(d);
    if (nextShowRegionLabels !== showRegionLabels) {
      showRegionLabels = nextShowRegionLabels;
      for (const label of regionLabels) label.visible = showRegionLabels;
    }
    const viewDistance = orbs?.userData.orbViewDistance as
      | { value: number }
      | undefined;
    if (viewDistance) viewDistance.value = d;
    const orbPlaneY = orbs?.userData.orbPlaneY as
      | { value: number }
      | undefined;
    if (orbPlaneY) orbPlaneY.value = planeY;
    const orbHasSelection = orbs?.userData.orbHasSelection as
      | { value: number }
      | undefined;
    if (orbHasSelection) orbHasSelection.value = selectedAnchor ? 1 : 0;
    const orbCameraSide = orbs?.userData.orbCameraSide as
      | { value: number }
      | undefined;
    if (orbCameraSide) {
      orbCameraSide.value = camera.position.y >= planeY ? 1 : -1;
    }
    const orbViewTarget = orbs?.userData.orbViewTarget as
      | { value: THREE.Vector3 }
      | undefined;
    if (orbViewTarget) {
      orbViewTarget.value.copy(selectedAnchor ?? controls.target);
    }
    const densityViewDistance = densityField?.userData.orbViewDistance as
      | { value: number }
      | undefined;
    if (densityViewDistance) densityViewDistance.value = d;
    if (orbs) orbs.userData.orbViewportHeight = canvas.clientHeight || 600;
    ring.scale.setScalar(selectionRingScale(d));
    if (handlers.viewCompass) drawViewGizmo(handlers.viewCompass, camera, theme);
    renderer.render(scene, camera);
  }
  loop();

  return {
    sync,
    flyCamera(target) {
      selectedAnchor = new THREE.Vector3(target.x, target.y, target.z);
      cruiseFromPos.copy(camera.position);
      cruiseFromTarget.copy(controls.target);
      cruiseTarget.copy(selectedAnchor);
      cruisePos.set(target.x + 22, target.y + 14, target.z + 52);
      cruiseStartedAt = performance.now();
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
        controlsDistance(),
        camera.fov,
        container.clientHeight || 600,
      );
      const next = effectiveBoxelMassCode(code, finest);
      lastFinest = finest;
      if (next === massCode) {
        handlers.onMassCode?.(massCode, finest);
        return;
      }
      massCode = next;
      rebuildBoxelGrid();
      handlers.onMassCode?.(massCode, finest);
    },
    resetTopView() {
      cruising = false;
      const d = Math.max(80, controlsDistance());
      const tx = controls.target.x;
      const tz = controls.target.z;
      controls.target.set(tx, planeY, tz);
      camera.up.set(0, 1, 0);
      const position = topViewCameraPosition(tx, planeY, tz, d);
      camera.position.set(position.x, position.y, position.z);
      controls.update();
      lockLookAtToPlane();
      refreshBoxelGrid();
      handlers.onViewIdle?.(currentViewState());
    },
    viewState() {
      return currentViewState();
    },
    destroy() {
      cancelAnimationFrame(raf);
      if (viewChangeTimer !== undefined) clearTimeout(viewChangeTimer);
      resize.destroy();
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onPickPointerDown);
      canvas.removeEventListener("pointerup", onPickPointerUp);
      canvas.removeEventListener("pointercancel", onPickPointerCancel);
      canvas.removeEventListener("pointerdown", onPlanePanDown);
      canvas.removeEventListener("pointermove", onPlanePanMove);
      canvas.removeEventListener("pointerup", onPlanePanUp);
      canvas.removeEventListener("pointercancel", onPlanePanUp);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      controls.dispose();
      disposeMesh(orbs, scene);
      disposeMesh(densityField, scene);
      disposeMesh(lines, scene);
      disposeMesh(routesLine, scene);
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
