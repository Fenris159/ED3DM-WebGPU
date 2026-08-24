import { BOXEL_ORIGIN, snapNearest } from "./boxel";
import data from "./region-grid-data.json";
import type { Coords } from "./types";

/** Approximate cap-width / em of Oxanium at weight 600. */
const FONT_ADVANCE = 0.58;

const A_SIZE = 10;

/** Snap Codex outline segments onto mass-code a faces; drop collapsed edges. */
export function snapRegionOutline(xz: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 3 < xz.length; i += 4) {
    const x1 = snapNearest(xz[i]!, BOXEL_ORIGIN.x, A_SIZE);
    const z1 = snapNearest(xz[i + 1]!, BOXEL_ORIGIN.z, A_SIZE);
    const x2 = snapNearest(xz[i + 2]!, BOXEL_ORIGIN.x, A_SIZE);
    const z2 = snapNearest(xz[i + 3]!, BOXEL_ORIGIN.z, A_SIZE);
    if (x1 === x2 && z1 === z2) continue;
    out.push(x1, z1, x2, z2);
  }
  return out;
}

export type GalacticRegion = {
  name: string;
  coords: Coords;
};

/** Codex / EDSM 42 galactic regions, centroids from the klightspeed bitmap. */
export const GALACTIC_REGIONS: GalacticRegion[] = data.regions;

/** Line pairs in Elite-space XZ (x1,z1,x2,z2) outlining those regions. */
export const REGION_GRID_XZ: readonly number[] = snapRegionOutline(data.xz);

export const GALAXY_CORE = { x: 25.2, y: 0, z: 25900 };
export const GALAXY_RADIUS = 40000;

const LABEL_HEIGHT_MAX = 560;
const LABEL_HEIGHT_MIN = 140;

type LabelTweak = {
  dx?: number;
  dz?: number;
  scale?: number;
  height?: number;
  rotDeg?: number;
};

const LABEL_TWEAKS: Record<string, LabelTweak> = {
  "Galactic Centre": { height: 236 },
  "Arcadian Stream": { dx: 1634, dz: 5277, height: 430 },
  "Empyrean Straits": { rotDeg: -20 },
  "Inner Orion-Perseus Conflux": { scale: 0.8 },
  "Inner Scutum-Centaurus Arm": { height: 380 },
  "Ryker's Hope": { dx: 1400 },
  "Outer Orion Spur": { dx: 2200 },
  "Sagittarius-Carina Arm": { dx: -1600 },
};

function rotateUp(up: { x: number; z: number }, deg: number): { x: number; z: number } {
  if (!deg) return up;
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: up.x * c - up.z * s, z: up.x * s + up.z * c };
}

function distPointSeg(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const abx = bx - ax;
  const abz = bz - az;
  const apx = px - ax;
  const apz = pz - az;
  const ab2 = abx * abx + abz * abz;
  const t = ab2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apz * abz) / ab2)) : 0;
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t));
}

/** Distance from a point to the nearest region outline segment. */
export function distToRegionOutline(x: number, z: number): number {
  let min = Infinity;
  const xz = REGION_GRID_XZ;
  for (let i = 0; i + 3 < xz.length; i += 4) {
    const d = distPointSeg(x, z, xz[i]!, xz[i + 1]!, xz[i + 2]!, xz[i + 3]!);
    if (d < min) min = d;
  }
  return min;
}

/** Letter height that keeps a title inside the local boundary clearance. */
export function fitLabelHeight(name: string, clearance: number): number {
  const n = Math.max(1, name.length);
  const radial = clearance * 1.05;
  const along = (clearance * 3.6) / (n * FONT_ADVANCE);
  return Math.min(LABEL_HEIGHT_MAX, Math.max(LABEL_HEIGHT_MIN, Math.min(radial, along)));
}

/**
 * Direction the top of a region title should face.
 * Galactic Centre is upright when +Z is screen-up (compass reset).
 * Other titles face the core. Empyrean Straits yaws so letter tops aim at
 * the inner Galactic Centre ring, not Sagittarius A*.
 */
export function regionLabelUp(region: GalacticRegion): { x: number; z: number } {
  if (region.name === "Galactic Centre") return { x: 0, z: 1 };
  return {
    x: GALAXY_CORE.x - region.coords.x,
    z: GALAXY_CORE.z - region.coords.z,
  };
}

export function regionLabelPlacement(region: GalacticRegion): {
  x: number;
  z: number;
  height: number;
  upX: number;
  upZ: number;
} {
  const tweak = LABEL_TWEAKS[region.name] ?? {};
  const x = region.coords.x + (tweak.dx ?? 0);
  const z = region.coords.z + (tweak.dz ?? 0);
  const up = rotateUp(
    regionLabelUp({ ...region, coords: { x, y: region.coords.y, z } }),
    tweak.rotDeg ?? 0,
  );
  const clearance = distToRegionOutline(x, z);
  let height = fitLabelHeight(region.name, clearance);
  if (tweak.scale != null) height *= tweak.scale;
  if (tweak.height != null) height = tweak.height;
  height = Math.min(LABEL_HEIGHT_MAX, Math.max(80, height));
  return { x, z, height, upX: up.x, upZ: up.z };
}


