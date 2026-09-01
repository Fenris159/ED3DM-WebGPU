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
import {
  stellarBrightnessScale,
  stellarLuminositySolar,
} from "./stellar-presentation";
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

export function translatedCameraPosition(
  cameraPosition: { x: number; y: number; z: number },
  currentTarget: { x: number; y: number; z: number },
  nextTarget: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  return {
    x: cameraPosition.x + nextTarget.x - currentTarget.x,
    y: cameraPosition.y + nextTarget.y - currentTarget.y,
    z: cameraPosition.z + nextTarget.z - currentTarget.z,
  };
}

const LOCAL_NAME_SHELL_HALF_EXTENT_LY = 15;

export function localNameLabelIndexes(
  systems: readonly System[],
  center: { x: number; y: number; z: number },
  halfExtentLy = LOCAL_NAME_SHELL_HALF_EXTENT_LY,
): number[] {
  const extent = Math.max(0, halfExtentLy);
  return systems.flatMap((system, index) => {
    if (!system.name || system.name.startsWith("ID64 ")) return [];
    return Math.abs(system.coords.x - center.x) <= extent &&
      Math.abs(system.coords.y - center.y) <= extent &&
      Math.abs(system.coords.z - center.z) <= extent
      ? [index]
      : [];
  });
}

export function localNameLabelSystems(
  systems: readonly System[],
  center: { x: number; y: number; z: number },
  limit = 96,
): System[] {
  return localNameLabelIndexes(systems, center)
    .map((index) => systems[index]!)
    .sort((left, right) => {
      const leftDistance =
        (left.coords.x - center.x) ** 2 +
        (left.coords.y - center.y) ** 2 +
        (left.coords.z - center.z) ** 2;
      const rightDistance =
        (right.coords.x - center.x) ** 2 +
        (right.coords.y - center.y) ** 2 +
        (right.coords.z - center.z) ** 2;
      return leftDistance - rightDistance;
    })
    .slice(0, Math.max(0, limit));
}

export function localSystemNamesVisible(viewDistanceLy: number): boolean {
  return Number.isFinite(viewDistanceLy) && viewDistanceLy <= 80;
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
    densityCells?: {
      coords: { x: number; y: number; z: number };
      weight: number;
      identity?: string;
      color?: string;
    }[];
    selected?: System;
    routes?: Route[];
    grid?: boolean;
    regionGrid?: boolean;
    names?: boolean;
    theme?: VisualTheme;
  }) => void;
  flyCamera: (target: { x: number; y: number; z: number }) => void;
  setPlaneHeight: (y: number) => void;
  planeHeight: () => number;
  setGridSize: (code: MassCode) => void;
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
    onGridSize?: (code: MassCode, finest: MassCode) => void;
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
  const nameLayer = document.createElement("div");
  nameLayer.className = "ed3dm-system-names";
  Object.assign(nameLayer.style, {
    position: "absolute",
    inset: "0",
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: "4",
  });
  container.appendChild(nameLayer);

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
  let orbDensityCells: {
    coords: { x: number; y: number; z: number };
    weight: number;
    identity?: string;
    color?: string;
  }[] = [];
  let orbTheme: VisualTheme | undefined;
  let lines: THREE.LineSegments | undefined;
  let routesLine: THREE.LineSegments | undefined;
  let systems: System[] = [];
  let showGrid = true;
  let showRegionGrid = true;
  let showNames = false;
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
  let nameLabels: { system: System; element: HTMLSpanElement }[] = [];
  const projectedName = new THREE.Vector3();
  const LOCAL_NAME_LABEL_LIMIT = 96;
  let lastNameCenter = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);
  let lastNameSignature = "";

  function clearNameLabels() {
    nameLayer.replaceChildren();
    nameLabels = [];
  }

  function refreshNameLabels(force = false) {
    if (!showNames) {
      clearNameLabels();
      lastNameSignature = "";
      nameLayer.hidden = true;
      return;
    }
    const center = selectedAnchor ?? controls.target;
    if (!force && lastNameCenter.distanceToSquared(center) < 4) return;
    lastNameCenter.copy(center);
    const labelSystems = localNameLabelSystems(
      systems,
      center,
      LOCAL_NAME_LABEL_LIMIT,
    );
    const signature = `${theme}\0${labelSystems.map((system) => `${systemIdentity(system)}\0${system.name}`).join("\0")}`;
    if (signature === lastNameSignature) return;
    clearNameLabels();
    lastNameSignature = signature;
    const fragment = document.createDocumentFragment();
    for (const system of labelSystems) {
      const element = document.createElement("span");
      element.textContent = system.name;
      Object.assign(element.style, {
        position: "absolute",
        left: "0",
        top: "0",
        color: theme === "paper" ? "#242422" : "#eceae4",
        fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
        fontSize: "12px",
        fontWeight: "600",
        lineHeight: "1",
        letterSpacing: "0.02em",
        textShadow:
          theme === "paper"
            ? "0 1px 2px rgba(255,255,255,0.85)"
            : "0 1px 3px rgba(0,0,0,0.95)",
        whiteSpace: "nowrap",
        transform: "translate(-9999px, -9999px)",
      });
      nameLabels.push({ system, element });
      fragment.appendChild(element);
    }
    nameLayer.appendChild(fragment);
  }

  function positionNameLabels() {
    const visibleAtZoom =
      showNames && localSystemNamesVisible(controlsDistance());
    nameLayer.hidden = !visibleAtZoom;
    if (!visibleAtZoom || nameLabels.length === 0) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const occupied: { left: number; top: number; right: number; bottom: number }[] = [];
    for (const label of nameLabels) {
      const system = label.system;
      projectedName
        .set(system.coords.x, system.coords.y, system.coords.z)
        .project(camera);
      const x = (projectedName.x + 1) * 0.5 * width + 9;
      const y = (1 - projectedName.y) * 0.5 * height - 6;
      const labelWidth = Math.min(230, Math.max(48, system.name.length * 7.4));
      const bounds = {
        left: x - 3,
        top: y - 3,
        right: x + labelWidth + 3,
        bottom: y + 15,
      };
      const overlaps = occupied.some(
        (other) =>
          bounds.left < other.right && bounds.right > other.left &&
          bounds.top < other.bottom && bounds.bottom > other.top,
      );
      const visible =
        projectedName.z >= -1 && projectedName.z <= 1 &&
        x >= 0 && x <= width && y >= 0 && y <= height &&
        !overlaps;
      label.element.hidden = !visible;
      if (!visible) continue;
      occupied.push(bounds);
      label.element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }
  }

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
      handlers.onGridSize?.(massCode, finest);
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

  const hoverRingGeo = new THREE.RingGeometry(1.55, 1.78, 64);
  const hoverRingMat = new THREE.MeshBasicMaterial({
    color: 0xf4b269,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.78,
    depthTest: false,
    depthWrite: false,
  });
  const hoverRing = new THREE.Mesh(hoverRingGeo, hoverRingMat);
  hoverRing.visible = false;
  hoverRing.renderOrder = 9;
  scene.add(hoverRing);

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
    hoverRingMat.color.set(visual === "paper" ? 0x8b4d16 : 0xf4b269);
    container.dataset.theme = visual;
  }

  applyTheme(initialTheme);

  function sync(state: {
    systems: System[];
    colors?: string[];
    details?: boolean[];
    densityWeights?: number[];
    densityCells?: {
      coords: { x: number; y: number; z: number };
      weight: number;
      identity?: string;
      color?: string;
    }[];
    selected?: System;
    routes?: Route[];
    grid?: boolean;
    regionGrid?: boolean;
    names?: boolean;
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
    const nextDensityCells = state.densityCells ?? [];
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
      nextDensityCells.length !== orbDensityCells.length ||
      nextDensityCells.some((cell, index) => {
        const previous = orbDensityCells[index];
        return previous === undefined ||
          cell.coords.x !== previous.coords.x ||
          cell.coords.y !== previous.coords.y ||
          cell.coords.z !== previous.coords.z ||
          cell.weight !== previous.weight ||
          cell.identity !== previous.identity ||
          cell.color !== previous.color;
      }) ||
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
    showNames = state.names === true;
    if (state.theme && state.theme !== theme) applyTheme(state.theme);
    grid.visible = showGrid;
    regionGrid.visible = showRegionGrid;
    refreshNameLabels(true);

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
    if (rebuildOrbs && (state.systems.length || nextDensityCells.length)) {
      const unresolvedDensity = state.systems
        .map((system, index) => ({ system, index }))
        .filter(({ index }) => nextDensityWeights[index]! > 0);
      const aggregateDensity = nextDensityCells.map((cell) => {
        const key = cell.identity ??
          `${cell.coords.x.toFixed(2)}:${cell.coords.y.toFixed(2)}:${cell.coords.z.toFixed(2)}`;
        return {
          x: cell.coords.x,
          y: cell.coords.y,
          z: cell.coords.z,
          r: 1,
          hex:
            state.theme === "realistic"
              ? (cell.color ?? densityFieldColor(cell.coords, key).hex)
              : state.theme === "paper"
                ? "#706f69"
                : "#d8d0c0",
          visibility: 0.2 + 0.8 * cell.weight,
          opacityNoise: stableOrbNoise(key, 0x7195a3),
        };
      });
      if (unresolvedDensity.length || aggregateDensity.length) {
        densityField = orbCloud(
          [
            ...unresolvedDensity.map(({ system, index }) => ({
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
            ...aggregateDensity,
          ],
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
          brightness:
            (state.theme ?? theme) === "realistic"
              ? stellarBrightnessScale(
                  s.stellarLuminositySolar ?? stellarLuminositySolar(
                    s.stellarRadiusMeters,
                    s.stellarTemperatureKelvin,
                  ),
                )
              : 1,
        })),
        new THREE.Color(0x2e2e2c),
        { maxPx: 12, additive, soft: true },
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
      orbDensityCells = nextDensityCells;
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

  function pickableIndexAt(clientX: number, clientY: number): number | undefined {
    const snappedIndex = snappedRailTarget(clientX, clientY);
    if (snappedIndex !== undefined) return snappedIndex;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    if (!orbs) return undefined;
    for (const hit of raycaster.intersectObject(orbs)) {
      const id = hit.instanceId ?? hit.index;
      if (id === undefined || !systems[id]) continue;
      if (railSelectableIndex(id, selectionRails, Boolean(selectedSystemKey))) {
        return id;
      }
    }
    return undefined;
  }

  function pickAt(clientX: number, clientY: number) {
    const pickedIndex = pickableIndexAt(clientX, clientY);
    if (pickedIndex !== undefined) {
      handlers.onSelectSystem(pickedIndex);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
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

  let hoverFrame = 0;
  let hoverClientX = 0;
  let hoverClientY = 0;
  function updateHover() {
    hoverFrame = 0;
    if (planePanning) return;
    const index = pickableIndexAt(hoverClientX, hoverClientY);
    const system = index === undefined ? undefined : systems[index];
    hoverRing.visible = Boolean(system);
    canvas.style.cursor = system ? "pointer" : "default";
    if (system) {
      hoverRing.position.set(system.coords.x, system.coords.y, system.coords.z);
    }
  }

  function onHoverPointerMove(ev: PointerEvent) {
    if (planePanning) {
      hoverRing.visible = false;
      return;
    }
    hoverClientX = ev.clientX;
    hoverClientY = ev.clientY;
    if (!hoverFrame) hoverFrame = requestAnimationFrame(updateHover);
  }

  function onHoverPointerLeave() {
    hoverRing.visible = false;
    canvas.style.cursor = "default";
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
  canvas.addEventListener("pointermove", onHoverPointerMove);
  canvas.addEventListener("pointerleave", onHoverPointerLeave);
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
    if (hoverRing.visible) hoverRing.lookAt(camera.position);
    refreshNameLabels();
    positionNameLabels();
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
    hoverRing.scale.setScalar(selectionRingScale(d) * 0.5);
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
      const destination = translatedCameraPosition(
        camera.position,
        controls.target,
        selectedAnchor,
      );
      cruisePos.set(destination.x, destination.y, destination.z);
      cruiseStartedAt = performance.now();
      cruising = true;
    },
    setPlaneHeight(y) {
      applyPlaneY(y, true);
    },
    planeHeight() {
      return planeY;
    },
    setGridSize(code) {
      const finest = finestMassCode(
        controlsDistance(),
        camera.fov,
        container.clientHeight || 600,
      );
      const next = effectiveBoxelMassCode(code, finest);
      lastFinest = finest;
      if (next === massCode) {
        handlers.onGridSize?.(massCode, finest);
        return;
      }
      massCode = next;
      rebuildBoxelGrid();
      handlers.onGridSize?.(massCode, finest);
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
      if (hoverFrame) cancelAnimationFrame(hoverFrame);
      if (viewChangeTimer !== undefined) clearTimeout(viewChangeTimer);
      resize.destroy();
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onPickPointerDown);
      canvas.removeEventListener("pointerup", onPickPointerUp);
      canvas.removeEventListener("pointercancel", onPickPointerCancel);
      canvas.removeEventListener("pointerdown", onPlanePanDown);
      canvas.removeEventListener("pointermove", onPlanePanMove);
      canvas.removeEventListener("pointermove", onHoverPointerMove);
      canvas.removeEventListener("pointerleave", onHoverPointerLeave);
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
      scene.remove(hoverRing);
      ringGeo.dispose();
      ringMat.dispose();
      hoverRingGeo.dispose();
      hoverRingMat.dispose();
      renderer.dispose();
      canvas.remove();
      nameLayer.remove();
    },
  };
}
