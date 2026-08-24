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
    const r = Math.min(1200, Math.max(360, cell.size * 0.55));
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

// Flat 2D disc sprite (same trick as the reference app / ED3D). Not a Lambert sphere.
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
  const r = s * 0.5;
  const disc = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  disc.addColorStop(0, "rgba(255,255,255,1)");
  disc.addColorStop(0.35, "rgba(255,255,255,0.95)");
  disc.addColorStop(0.65, "rgba(255,255,255,0.4)");
  disc.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = disc;
  ctx.fillRect(0, 0, s, s);
  const glint = ctx.createRadialGradient(
    cx - r * 0.16,
    cy - r * 0.16,
    0,
    cx - r * 0.16,
    cy - r * 0.16,
    r * 0.28,
  );
  glint.addColorStop(0, "rgba(255,255,255,0.55)");
  glint.addColorStop(1, "rgba(255,255,255,0)");
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = glint;
  ctx.fillRect(0, 0, s, s);
  tex.needsUpdate = true;
  return tex;
}

const orbVert = `
attribute float aScale;
uniform float uPixelRatio;
uniform float uMaxSize;
varying vec3 vColor;
void main() {
  vColor = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(2.0, -mv.z);
  gl_PointSize = clamp(aScale * 280.0 / dist * uPixelRatio, 2.0, uMaxSize);
}
`;

const orbFrag = `
uniform sampler2D uMap;
varying vec3 vColor;
void main() {
  vec4 tex = texture2D(uMap, gl_PointCoord);
  if (tex.a < 0.06) discard;
  gl_FragColor = vec4(vColor * tex.rgb, tex.a);
}
`;

function orbCloud(
  items: { x: number; y: number; z: number; r: number }[],
  color: THREE.Color,
  opts: { maxPx: number; map: THREE.Texture },
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
  for (let i = 0; i < items.length; i++) {
    cols[i * 3] = color.r;
    cols[i * 3 + 1] = color.g;
    cols[i * 3 + 2] = color.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  const mat = new THREE.ShaderMaterial({
    vertexShader: orbVert,
    fragmentShader: orbFrag,
    uniforms: {
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      uMaxSize: { value: opts.maxPx },
      uMap: { value: opts.map },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
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

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
  });
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

  const orbMap = makeOrbTexture();

  let impostors: THREE.Points | undefined;
  let orbs: THREE.Points | undefined;
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
        impostors = orbCloud(balls, new THREE.Color(0x9bb6ff), {
          maxPx: 56,
          map: orbMap,
        });
        scene.add(impostors);
      }
    }
    if (state.systems.length) {
      orbs = orbCloud(
        state.systems.map((s) => ({
          x: s.coords.x,
          y: s.coords.y,
          z: s.coords.z,
          r:
            s.name === "Sol" ||
            s.name === "Colonia" ||
            s.name === "Sagittarius A*"
              ? 720
              : 480,
        })),
        new THREE.Color(0xffe29a),
        { maxPx: 220, map: orbMap },
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
      orbMap.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
