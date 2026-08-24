import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { CatalogCell, System } from "./types";

export type SceneHandle = {
  sync: (state: {
    cells: CatalogCell[];
    systems: System[];
    selected?: System;
    hideImpostors?: boolean;
  }) => void;
  flyCamera: (target: { x: number; y: number; z: number }) => void;
  destroy: () => void;
};

function hash01(i: number, seed: number): number {
  const n = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

function impostorPositions(cells: CatalogCell[]): Float32Array {
  const pts: number[] = [];
  for (const cell of cells) {
    const n = Math.min(cell.count, 48);
    const seed = cell.id.length + cell.cx + cell.cz;
    for (let i = 0; i < n; i++) {
      pts.push(
        cell.cx + (hash01(i, seed) - 0.5) * cell.size,
        cell.cy + (hash01(i + 17, seed) - 0.5) * cell.size * 0.2,
        cell.cz + (hash01(i + 31, seed) - 0.5) * cell.size,
      );
    }
  }
  return new Float32Array(pts);
}

function systemPositions(systems: System[]): Float32Array {
  const pts = new Float32Array(systems.length * 3);
  systems.forEach((s, i) => {
    pts[i * 3] = s.coords.x;
    pts[i * 3 + 1] = s.coords.y;
    pts[i * 3 + 2] = s.coords.z;
  });
  return pts;
}

function pointsMesh(
  positions: Float32Array,
  color: number,
  size: number,
  sizeAttenuation: boolean,
) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color,
    size,
    sizeAttenuation,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
  });
  return new THREE.Points(geo, mat);
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
  container.style.position = container.style.position || "relative";
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07060c);
  scene.fog = new THREE.FogExp2(0x07060c, 0.000004);

  const camera = new THREE.PerspectiveCamera(
    50,
    Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1),
    1,
    200000,
  );
  camera.position.set(4000, 18000, -12000);

  let renderer: THREE.WebGLRenderer;
  try {
    const mod = await import("three/webgpu");
    const gpu = new mod.WebGPURenderer({
      canvas,
      antialias: true,
    });
    await gpu.init();
    renderer = gpu as unknown as THREE.WebGLRenderer;
  } catch {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
    });
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth || 800, container.clientHeight || 600);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.3;
  controls.rotateSpeed = 0.3;
  controls.zoomSpeed = 2.2;
  controls.panSpeed = 4;
  controls.maxDistance = 80000;
  controls.minDistance = 5;
  controls.target.set(0, 0, 8000);
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

  let impostors: THREE.Points | undefined;
  let orbs: THREE.Points | undefined;
  let lines: THREE.LineSegments | undefined;
  let systems: System[] = [];

  const raycaster = new THREE.Raycaster();
  raycaster.params.Points = { threshold: 40 };

  function sync(state: {
    cells: CatalogCell[];
    systems: System[];
    selected?: System;
    hideImpostors?: boolean;
  }) {
    systems = state.systems;
    if (impostors) scene.remove(impostors);
    if (orbs) scene.remove(orbs);
    if (lines) scene.remove(lines);
    impostors = undefined;
    orbs = undefined;
    lines = undefined;

    if (!state.hideImpostors) {
      impostors = pointsMesh(
        impostorPositions(state.cells),
        0xc8d4ff,
        3,
        false,
      );
      scene.add(impostors);
    }
    if (state.systems.length) {
      orbs = pointsMesh(systemPositions(state.systems), 0xffe08a, 8, false);
      scene.add(orbs);
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
        new THREE.LineBasicMaterial({ color: 0x7ec8ff, transparent: true, opacity: 0.7 }),
      );
      scene.add(lines);
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
      const hits = raycaster.intersectObject(orbs);
      if (hits[0]?.index !== undefined) {
        handlers.onSelectSystem(hits[0].index);
        return;
      }
    }
    const pt = new THREE.Vector3();
    raycaster.ray.at(Math.min(controls.getDistance() * 0.4, 4000), pt);
    handlers.onPickCell({ x: pt.x, y: pt.y, z: pt.z });
  });

  function onResize() {
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  window.addEventListener("resize", onResize);

  let raf = 0;
  function loop() {
    raf = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  }
  loop();

  return {
    sync,
    flyCamera(target) {
      controls.target.set(target.x, target.y, target.z);
      camera.position.set(target.x, target.y + 80, target.z + 220);
    },
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      controls.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
