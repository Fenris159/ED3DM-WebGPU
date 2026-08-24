import * as THREE from "three/webgpu";
import type { VisualTheme } from "./types";

const _dir = new THREE.Vector3();

/**
 * Elite space: XZ is the galactic plane, Y is height.
 * +X east, +Y above the plane, +Z toward Sagittarius A* from Sol.
 */
const COMPASS_AXES: { world: THREE.Vector3; label: "X" | "Y" | "Z" }[] = [
  { world: new THREE.Vector3(1, 0, 0), label: "X" },
  { world: new THREE.Vector3(0, 1, 0), label: "Y" },
  { world: new THREE.Vector3(0, 0, 1), label: "Z" },
];

function axisColors(theme: VisualTheme): { x: string; y: string; z: string; ring: string } {
  if (theme === "paper") {
    return { x: "#b14a3a", y: "#3d8a4a", z: "#3a5ea8", ring: "#cfcfca" };
  }
  return { x: "#e07060", y: "#6dcc7a", z: "#6a8ee0", ring: "#5a5a62" };
}

export type GizmoDir = { x: number; y: number; z: number };

/** Compass X/Y/Z in camera space (x right, y up, z toward viewer). */
export function gizmoCameraAxes(camera: THREE.Camera): {
  x: GizmoDir;
  y: GizmoDir;
  z: GizmoDir;
} {
  camera.updateMatrixWorld();
  const inv = camera.matrixWorldInverse;
  const grab = (world: THREE.Vector3): GizmoDir => {
    _dir.copy(world).transformDirection(inv);
    return { x: _dir.x, y: _dir.y, z: _dir.z };
  };
  return {
    x: grab(COMPASS_AXES[0]!.world),
    y: grab(COMPASS_AXES[1]!.world),
    z: grab(COMPASS_AXES[2]!.world),
  };
}

/** Draw map X/Y/Z as they appear in the camera view. */
export function drawViewGizmo(
  canvas: HTMLCanvasElement,
  camera: THREE.Camera,
  theme: VisualTheme,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const R = w * 0.3;
  const colors = axisColors(theme);
  const byLabel = { X: colors.x, Y: colors.y, Z: colors.z };
  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  ctx.arc(cx, cy, w * 0.46, 0, Math.PI * 2);
  ctx.strokeStyle = colors.ring;
  ctx.lineWidth = Math.max(2, w * 0.018);
  ctx.stroke();

  const dirs = gizmoCameraAxes(camera);
  const drawn = COMPASS_AXES.map((a) => {
    const d = dirs[a.label.toLowerCase() as "x" | "y" | "z"];
    return {
      color: byLabel[a.label],
      label: a.label,
      sx: cx + d.x * R,
      sy: cy - d.y * R,
      z: d.z,
    };
  });
  drawn.sort((a, b) => a.z - b.z);
  ctx.font = `${Math.round(w * 0.14)}px "Source Serif 4", Palatino, serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const p of drawn) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(p.sx, p.sy);
    ctx.strokeStyle = p.color;
    ctx.lineWidth = Math.max(3, w * 0.028);
    ctx.lineCap = "round";
    ctx.stroke();
    const dot = Math.max(4, w * 0.045);
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, dot, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.fillStyle = p.color;
    ctx.fillText(p.label, p.sx, p.sy - w * 0.12);
  }
}
