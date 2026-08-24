import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { CatalogCell, System } from "./types";

export type SceneHandle = {
  sync: (state: {
    cells: CatalogCell[];
    systems: System[];
    selected?: System;
    hideImpostors?: boolean;
    loadedCellIds?: Set<string>;
  }) => void;
  flyCamera: (target: { x: number; y: number; z: number }) => void;
  destroy: () => void;
};

function hash01(i: number, seed: number): number {
  const n = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

function impostorOrbs(
  cells: CatalogCell[],
  skipIds?: Set<string>,
): { x: number; y: number; z: number; r: number }[] {
  const out: { x: number; y: number; z: number; r: number }[] = [];
  for (const cell of cells) {
    if (skipIds?.has(cell.id)) continue;
    const n = Math.min(cell.count, 10);
    const seed = cell.id.length + cell.cx + cell.cz;
    const r = Math.min(22, Math.max(5, cell.size * 0.018));
    for (let i = 0; i < n; i++) {
      out.push({
        x: cell.cx + (hash01(i, seed) - 0.5) * cell.size,
        y: cell.cy + (hash01(i + 17, seed) - 0.5) * cell.size * 0.12,
        z: cell.cz + (hash01(i + 31, seed) - 0.5) * cell.size,
        r,
      });
    }
  }
  return out;
}

function instancedBalls(
  items: { x: number; y: number; z: number; r: number }[],
  color: number,
  emissive: number,
): THREE.InstancedMesh {
  const geo = new THREE.SphereGeometry(1, 14, 10);
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive,
    emissiveIntensity: 0.35,
    roughness: 0.45,
    metalness: 0.05,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, items.length);
  const dummy = new THREE.Object3D();
  items.forEach((p, i) => {
    dummy.position.set(p.x, p.y, p.z);
    dummy.scale.setScalar(p.r);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

function disposeMesh(obj: THREE.Object3D | undefined, scene: THREE.Scene) {
  if (!obj) return;
  scene.remove(obj);
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.InstancedMesh || child instanceof THREE.LineSegments) {
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
  container.style.position = container.style.position || "relative";
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05040a);
  scene.fog = new THREE.FogExp2(0x05040a, 0.000018);

  const camera = new THREE.PerspectiveCamera(
    50,
    Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1),
    0.5,
    250000,
  );
  camera.position.set(-4000, 14000, -6000);

  scene.add(new THREE.AmbientLight(0x8899cc, 0.55));
  const key = new THREE.DirectionalLight(0xfff4e0, 1.35);
  key.position.set(-12000, 18000, -8000);
  scene.add(key);

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
  controls.maxDistance = 90000;
  controls.minDistance = 4;
  controls.target.set(0, 0, 16000);
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

  let impostors: THREE.InstancedMesh | undefined;
  let orbs: THREE.InstancedMesh | undefined;
  let lines: THREE.LineSegments | undefined;
  let systems: System[] = [];

  const raycaster = new THREE.Raycaster();

  function sync(state: {
    cells: CatalogCell[];
    systems: System[];
    selected?: System;
    hideImpostors?: boolean;
    loadedCellIds?: Set<string>;
  }) {
    systems = state.systems;
    disposeMesh(impostors, scene);
    disposeMesh(orbs, scene);
    disposeMesh(lines, scene);
    impostors = undefined;
    orbs = undefined;
    lines = undefined;

    if (!state.hideImpostors) {
      const balls = impostorOrbs(state.cells, state.loadedCellIds);
      if (balls.length) {
        impostors = instancedBalls(balls, 0xb8c8ff, 0x223355);
        scene.add(impostors);
      }
    }
    if (state.systems.length) {
      orbs = instancedBalls(
        state.systems.map((s) => ({
          x: s.coords.x,
          y: s.coords.y,
          z: s.coords.z,
          r: s.name === "Sol" || s.name === "Colonia" || s.name === "Sagittarius A*"
            ? 7
            : 4.5,
        })),
        0xffe29a,
        0x664422,
      );
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
            color: 0x7ec8ff,
            transparent: true,
            opacity: 0.7,
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
      const hits = raycaster.intersectObject(orbs);
      const id = hits[0]?.instanceId;
      if (id !== undefined) {
        handlers.onSelectSystem(id);
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
      camera.position.set(target.x + 22, target.y + 14, target.z + 52);
    },
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      controls.dispose();
      disposeMesh(impostors, scene);
      disposeMesh(orbs, scene);
      disposeMesh(lines, scene);
      renderer.dispose();
      canvas.remove();
    },
  };
}
