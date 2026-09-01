import {
  GALAXY_VIEW_TILE_EDGE_FIXED,
  galaxyViewTileKeyString,
} from "pege";
import { PEGE_OVERVIEW_CONFIG } from "./pege-overview";
import { containingBoxel } from "./boxel";
import type {
  GalaxyCameraView,
  GalaxyViewBounds,
  LodSetting,
  PegeSpatialTileKey,
} from "./types";

const FIXED_UNITS_PER_LY = 32;
export const MAX_VISIBLE_PEGE_TILES = 64;
export const LOCAL_DETAIL_MAX_DISTANCE_LY = 10_000;
const H_NEIGHBORHOOD_TILE_COUNT = 27;
const H_BOUNDARY_BLEND_FRACTION = 0.3;
export const pegeTileKeyString = galaxyViewTileKeyString;

export function cameraResidencyAnchor(
  selected: { x: number; y: number; z: number } | undefined,
  focus: { x: number; y: number; z: number } | undefined,
  planeY: number | undefined,
): { x: number; y: number; z: number } | undefined {
  if (selected) return selected;
  if (!focus) return undefined;
  return { x: focus.x, y: planeY ?? focus.y, z: focus.z };
}

export type RadialSpatialShell = {
  tier: "h" | "g" | "f" | "e";
  weight: number;
  outerBounds: GalaxyViewBounds;
  innerBounds?: GalaxyViewBounds;
  keys: PegeSpatialTileKey[];
};

/**
 * Camera-local residency is centered on the focus, not the frustum or the
 * containing Forge boxel's origin. The canonical PEGE storage tiles remain
 * H-sized. G/F/E describe successively narrower geometric expansion bands around
 * the focused H-sized area. They do not select System mass codes. Their source
 * reads use the next coarser canonical
 * storage level, then are clipped into complete 3D shells after generation.
 * This preserves genuine positions while avoiding dozens of fine-tile worker
 * passes for low-density blending tiers. Every shell receives a smaller stable
 * prefix.
 */
export function radialSpatialShellPlan(
  target: { x: number; y: number; z: number },
): RadialSpatialShell[] {
  const h = containingBoxel(target, "h");
  const tiers = [
    { tier: "h" as const, expansion: 0, weight: 1 },
    { tier: "g" as const, expansion: 640, weight: 0.45 },
    { tier: "f" as const, expansion: 960, weight: 0.25 },
    { tier: "e" as const, expansion: 1_120, weight: 0.12 },
  ];
  let innerBounds: GalaxyViewBounds | undefined;
  return tiers.map(({ tier, expansion, weight }) => {
    const halfEdge = h.size / 2 + expansion;
    const outerBounds: GalaxyViewBounds = {
      minimum: {
        x: target.x - halfEdge,
        y: target.y - halfEdge,
        z: target.z - halfEdge,
      },
      maximum: {
        x: target.x + halfEdge,
        y: target.y + halfEdge,
        z: target.z + halfEdge,
      },
    };
    const shell: RadialSpatialShell = {
      tier,
      weight,
      outerBounds,
      ...(innerBounds ? { innerBounds } : {}),
      keys: visiblePegeTileKeys(
        outerBounds,
        tier === "h" ? h.size : h.size * 2,
        MAX_VISIBLE_PEGE_TILES,
      ),
    };
    innerBounds = outerBounds;
    return shell;
  });
}

export function radialSpatialShellContains(
  shell: RadialSpatialShell,
  coords: { x: number; y: number; z: number },
): boolean {
  const outer = shell.outerBounds;
  if (
    coords.x < outer.minimum.x || coords.x >= outer.maximum.x ||
    coords.y < outer.minimum.y || coords.y >= outer.maximum.y ||
    coords.z < outer.minimum.z || coords.z >= outer.maximum.z
  ) return false;
  const inner = shell.innerBounds;
  return !inner || (
    coords.x < inner.minimum.x || coords.x >= inner.maximum.x ||
    coords.y < inner.minimum.y || coords.y >= inner.maximum.y ||
    coords.z < inner.minimum.z || coords.z >= inner.maximum.z
  );
}

export function radialSpatialShellTargets(
  shells: readonly RadialSpatialShell[],
  totalTargetSystems: number,
): number[] {
  if (shells.length === 0 || totalTargetSystems <= 0) return [];
  const totalWeight = shells.reduce((sum, shell) => sum + shell.weight, 0);
  let remaining = Math.max(shells.length, Math.floor(totalTargetSystems));
  return shells.map((shell, index) => {
    const later = shells.length - index - 1;
    const requested = index === shells.length - 1
      ? remaining
      : Math.round(totalTargetSystems * shell.weight / totalWeight);
    const target = Math.max(1, Math.min(remaining - later, requested));
    remaining -= target;
    return target;
  });
}

export function focusedPegeTileKey(
  target: { x: number; y: number; z: number },
  cameraDistanceLy: number,
): PegeSpatialTileKey {
  const level = pegeTileLevelForDistance(cameraDistanceLy);
  const edge = GALAXY_VIEW_TILE_EDGE_FIXED * 2 ** level;
  return {
    level,
    x: Math.floor((target.x * FIXED_UNITS_PER_LY) / edge),
    y: Math.floor((target.y * FIXED_UNITS_PER_LY) / edge),
    z: Math.floor((target.z * FIXED_UNITS_PER_LY) / edge),
  };
}

export function cameraResidencyTileKeys(
  target: { x: number; y: number; z: number },
  maximumTiles = MAX_VISIBLE_PEGE_TILES,
  completeNeighborhood = false,
): PegeSpatialTileKey[] {
  const h = containingBoxel(target, "h");
  const center = focusedPegeTileKey(
    {
      x: h.ox + h.size / 2,
      y: h.oy + h.size / 2,
      z: h.oz + h.size / 2,
    },
    h.size,
  );
  const axisOffsets = (["x", "y", "z"] as const).map((axis) => {
    if (completeNeighborhood) return [-1, 0, 1];
    const position = (target[axis] - h[`o${axis}`]) / h.size;
    if (position < H_BOUNDARY_BLEND_FRACTION) return [0, -1];
    if (position > 1 - H_BOUNDARY_BLEND_FRACTION) return [0, 1];
    return [0];
  });
  const keys: PegeSpatialTileKey[] = [];
  for (const z of axisOffsets[2]!) {
    for (const y of axisOffsets[1]!) {
      for (const x of axisOffsets[0]!) {
        if (keys.length >= maximumTiles) break;
        keys.push({
          level: center.level,
          x: center.x + x,
          y: center.y + y,
          z: center.z + z,
        });
      }
    }
  }
  return keys.sort((left, right) =>
    galaxyViewTileKeyString(left).localeCompare(galaxyViewTileKeyString(right)),
  );
}

export function cameraResidencyTilePlan(
  target: { x: number; y: number; z: number },
  completeNeighborhood = false,
): { key: PegeSpatialTileKey; weight: number }[] {
  const h = containingBoxel(target, "h");
  const center = {
    x: h.ox + h.size / 2,
    y: h.oy + h.size / 2,
    z: h.oz + h.size / 2,
  };
  const centerKey = focusedPegeTileKey(center, h.size);
  return cameraResidencyTileKeys(
    target,
    MAX_VISIBLE_PEGE_TILES,
    completeNeighborhood,
  ).map((key) => {
    const adjacentAxes =
      Math.abs(key.x - centerKey.x) +
      Math.abs(key.y - centerKey.y) +
      Math.abs(key.z - centerKey.z);
    const weight = [1, 0.45, 0.25, 0.12][adjacentAxes] ?? 0.12;
    return { key, weight };
  });
}

export function cameraResidencyCacheScope(
  target: { x: number; y: number; z: number },
): string {
  const h = containingBoxel(target, "h");
  return `h:${h.ox}:${h.oy}:${h.oz}`;
}

export function cameraViewResidencyTilePlan(
  view: GalaxyCameraView,
): { key: PegeSpatialTileKey; weight: number }[] {
  const padding = {
    x: Math.max(
      1_280,
      (view.visibleBounds.maximum.x - view.visibleBounds.minimum.x) * 0.45,
    ),
    y: Math.max(
      1_280,
      (view.visibleBounds.maximum.y - view.visibleBounds.minimum.y) * 0.45,
    ),
    z: Math.max(
      1_280,
      (view.visibleBounds.maximum.z - view.visibleBounds.minimum.z) * 0.45,
    ),
  };
  const paddedBounds: GalaxyViewBounds = {
    minimum: {
      x: view.visibleBounds.minimum.x - padding.x,
      y: view.visibleBounds.minimum.y - padding.y,
      z: view.visibleBounds.minimum.z - padding.z,
    },
    maximum: {
      x: view.visibleBounds.maximum.x + padding.x,
      y: view.visibleBounds.maximum.y + padding.y,
      z: view.visibleBounds.maximum.z + padding.z,
    },
  };
  const keys = visiblePegeTileKeys(
    paddedBounds,
    view.distanceLy,
    MAX_VISIBLE_PEGE_TILES,
  );
  if (keys.length === 0) return cameraResidencyTilePlan(view.target);
  return keys.map((key) => {
    const edgeLy =
      (GALAXY_VIEW_TILE_EDGE_FIXED * 2 ** key.level) / FIXED_UNITS_PER_LY;
    const center = {
      x: (key.x + 0.5) * edgeLy,
      y: (key.y + 0.5) * edgeLy,
      z: (key.z + 0.5) * edgeLy,
    };
    const outside = (axis: "x" | "y" | "z") =>
      center[axis] < view.visibleBounds.minimum[axis]
        ? (view.visibleBounds.minimum[axis] - center[axis]) / padding[axis]
        : center[axis] > view.visibleBounds.maximum[axis]
          ? (center[axis] - view.visibleBounds.maximum[axis]) / padding[axis]
          : 0;
    const edgeDistance = Math.min(
      1,
      Math.max(outside("x"), outside("y"), outside("z")),
    );
    const smooth = edgeDistance * edgeDistance * (3 - 2 * edgeDistance);
    return { key, weight: 1 - 0.88 * smooth };
  });
}

export function taperedPegeTilePointBudget(
  cameraDistanceLy: number,
  lod: LodSetting,
  keyWeights: readonly { weight: number }[],
): number {
  if (cameraDistanceLy >= LOCAL_DETAIL_MAX_DISTANCE_LY) return 0;
  const fullBudget = pegeTilePointBudget(
    cameraDistanceLy,
    lod,
    H_NEIGHBORHOOD_TILE_COUNT,
  );
  if (fullBudget === 0 || keyWeights.length === 0) return 0;
  const neighborhoodFraction =
    Math.min(
      1,
      keyWeights.reduce(
        (total, { weight }) => total + Math.min(1, Math.max(0, weight)),
        0,
      ) / H_NEIGHBORHOOD_TILE_COUNT,
    );
  return Math.max(
    keyWeights.length,
    Math.ceil(fullBudget * neighborhoodFraction),
  );
}

export function progressivePegeTileShells<T extends { weight: number }>(
  keyWeights: readonly T[],
  totalTargetSystems: number,
): { keyWeights: T[]; totalTargetSystems: number }[] {
  if (keyWeights.length === 0 || totalTargetSystems <= 0) return [];
  const groups = new Map<number, T[]>();
  for (const entry of keyWeights) {
    const weight = Math.min(1, Math.max(0, entry.weight));
    const group = groups.get(weight);
    if (group) group.push(entry);
    else groups.set(weight, [entry]);
  }
  const shells = [...groups.entries()].sort(([left], [right]) => right - left);
  const shellWeightTotal = shells.reduce((total, [weight]) => total + weight, 0);
  let remaining = Math.max(keyWeights.length, Math.floor(totalTargetSystems));
  return shells.map(([weight, entries], index) => {
    const laterTileCount = shells
      .slice(index + 1)
      .reduce((total, [, later]) => total + later.length, 0);
    const requested = index === shells.length - 1
      ? remaining
      : Math.round(totalTargetSystems * weight / shellWeightTotal);
    const target = Math.max(
      entries.length,
      Math.min(remaining - laterTileCount, requested),
    );
    remaining -= target;
    return { keyWeights: entries, totalTargetSystems: target };
  });
}

function tileCountForRange(
  minimumFixedXyz: readonly [number, number, number],
  maximumExclusiveFixedXyz: readonly [number, number, number],
  edge: number,
): number {
  let count = 1;
  for (let axis = 0; axis < 3; axis += 1) {
    const first = Math.floor(minimumFixedXyz[axis]! / edge);
    const last = Math.floor((maximumExclusiveFixedXyz[axis]! - 1) / edge);
    count *= Math.max(0, last - first + 1);
  }
  return count;
}

function clippedFixedBounds(
  bounds: GalaxyViewBounds,
): {
  minimumFixedXyz: [number, number, number];
  maximumExclusiveFixedXyz: [number, number, number];
} | undefined {
  const minimumFixedXyz: [number, number, number] = [0, 0, 0];
  const maximumExclusiveFixedXyz: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    minimumFixedXyz[axis] = Math.max(
      PEGE_OVERVIEW_CONFIG.minimumFixedXyz[axis]!,
      Math.floor(bounds.minimum[axis === 0 ? "x" : axis === 1 ? "y" : "z"] * FIXED_UNITS_PER_LY),
    );
    maximumExclusiveFixedXyz[axis] = Math.min(
      PEGE_OVERVIEW_CONFIG.maximumExclusiveFixedXyz[axis]!,
      Math.ceil(bounds.maximum[axis === 0 ? "x" : axis === 1 ? "y" : "z"] * FIXED_UNITS_PER_LY),
    );
    if (minimumFixedXyz[axis] >= maximumExclusiveFixedXyz[axis]) return undefined;
  }
  return { minimumFixedXyz, maximumExclusiveFixedXyz };
}

export function pegeTileLevelForDistance(cameraDistanceLy: number): number {
  const distance = Math.max(GALAXY_VIEW_TILE_EDGE_FIXED / FIXED_UNITS_PER_LY, cameraDistanceLy);
  return Math.min(
    20,
    Math.max(
      0,
      Math.floor(
        Math.log2(distance / (GALAXY_VIEW_TILE_EDGE_FIXED / FIXED_UNITS_PER_LY)),
      ),
    ),
  );
}

export function visiblePegeTileKeys(
  bounds: GalaxyViewBounds,
  cameraDistanceLy: number,
  maximumTiles = MAX_VISIBLE_PEGE_TILES,
): PegeSpatialTileKey[] {
  const clipped = clippedFixedBounds(bounds);
  if (!clipped) return [];
  let level = pegeTileLevelForDistance(cameraDistanceLy);
  let edge = GALAXY_VIEW_TILE_EDGE_FIXED * 2 ** level;
  while (
    level < 20 &&
    tileCountForRange(
      clipped.minimumFixedXyz,
      clipped.maximumExclusiveFixedXyz,
      edge,
    ) > maximumTiles
  ) {
    level += 1;
    edge *= 2;
  }

  const first = clipped.minimumFixedXyz.map((value) =>
    Math.floor(value / edge),
  ) as [number, number, number];
  const last = clipped.maximumExclusiveFixedXyz.map((value) =>
    Math.floor((value - 1) / edge),
  ) as [number, number, number];
  const keys: PegeSpatialTileKey[] = [];
  for (let z = first[2]; z <= last[2]; z += 1) {
    for (let y = first[1]; y <= last[1]; y += 1) {
      for (let x = first[0]; x <= last[0]; x += 1) {
        keys.push({ level, x, y, z });
      }
    }
  }
  return keys.sort((left, right) =>
    galaxyViewTileKeyString(left).localeCompare(galaxyViewTileKeyString(right)),
  );
}

export function pegeTilePointBudget(
  cameraDistanceLy: number,
  lod: LodSetting,
  tileCount: number,
): number {
  if (tileCount <= 0) return 0;
  const farDistance = LOCAL_DETAIL_MAX_DISTANCE_LY;
  const fullDistance = 300;
  const normalized = Math.min(
    1,
    Math.max(
      0,
      (Math.log(farDistance) - Math.log(Math.max(fullDistance, cameraDistanceLy))) /
        (Math.log(farDistance) - Math.log(fullDistance)),
    ),
  );
  const smooth = normalized * normalized * (3 - 2 * normalized);
  const unquantizedMaximum = 20_000 + 40_000 * smooth;
  // Small stable steps avoid abort/restart churn on every wheel event while
  // still exposing visibly progressive detail throughout the zoom gesture.
  const maximum = Math.min(
    60_000,
    Math.max(20_000, Math.round(unquantizedMaximum / 1_000) * 1_000),
  );
  const fraction = lod === "all" ? 1 : Math.max(0.05, Math.min(1, lod / 100));
  return Math.max(tileCount, Math.ceil(maximum * fraction));
}
