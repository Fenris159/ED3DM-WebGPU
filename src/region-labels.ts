import * as THREE from "three/webgpu";
import {
  GALACTIC_REGIONS,
  REGION_GRID_XZ,
  regionLabelPlacement,
  type GalacticRegion,
} from "./regions";

const FONT = '600 96px Oxanium, "Segoe UI", sans-serif';
const _up = new THREE.Vector3(0, 1, 0);

function makeOutline(color: number): THREE.LineSegments {
  const xz = REGION_GRID_XZ;
  const pos = new Float32Array((xz.length / 2) * 3);
  for (let i = 0, p = 0; i < xz.length; i += 2) {
    pos[p++] = xz[i]!;
    pos[p++] = 0;
    pos[p++] = xz[i + 1]!;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.92,
    depthTest: false,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 3;
  lines.userData.regionOutlines = true;
  return lines;
}

function paintLabel(name: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const text = name.toUpperCase();
  ctx.font = FONT;
  const measured = ctx.measureText(text).width || text.length * 52;
  const padX = 28;
  const padY = 22;
  canvas.width = Math.max(8, Math.ceil(measured + padX * 2));
  canvas.height = 96 + padY * 2;
  ctx.font = FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = 3.2;
  ctx.strokeStyle = "#ffffff";
  ctx.fillStyle = "#ffffff";
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  return canvas;
}

function makeLabel(region: GalacticRegion, color: number): THREE.Mesh {
  const p = regionLabelPlacement(region);
  const canvas = paintLabel(region.name);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  const worldH = p.height;
  const worldW = worldH * (canvas.width / Math.max(1, canvas.height));
  const geo = new THREE.PlaneGeometry(worldW, worldH);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    color,
    transparent: true,
    opacity: 0.94,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(p.x, 0, p.z);
  const yaw = Math.atan2(p.upX, p.upZ);
  mesh.rotateOnWorldAxis(_up, yaw);
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  mesh.userData.regionLabel = region.name;
  return mesh;
}

/** Outlines plus font titles, local Y = 0; place the group on the height plane. */
export function makeRegionLayer(color: number): THREE.Group {
  const group = new THREE.Group();
  group.add(makeOutline(color));
  const labelColor = color === 0x2a2a28 ? 0x141413 : color;
  for (const region of GALACTIC_REGIONS) group.add(makeLabel(region, labelColor));
  return group;
}

export async function makeRegionLayerAsync(color: number): Promise<THREE.Group> {
  if (typeof document !== "undefined" && document.fonts) {
    try {
      await document.fonts.load(FONT);
      await document.fonts.ready;
    } catch {
      /* jsdom */
    }
  }
  return makeRegionLayer(color);
}

export function tintRegionLayer(group: THREE.Object3D, color: number, opacity: number) {
  group.traverse((child) => {
    if (child instanceof THREE.LineSegments) {
      const mat = child.material as THREE.LineBasicMaterial;
      mat.color.set(color);
      mat.opacity = opacity;
    } else if (child instanceof THREE.Mesh) {
      const mat = child.material as THREE.MeshBasicMaterial;
      mat.color.set(color === 0x2a2a28 ? 0x141413 : color);
      mat.opacity = 1;
    }
  });
}
