/**
 * Two coordinate systems:
 *
 * Elite space (player / EDSM / journals): Sol is exactly (0,0,0). System
 * positions, distances, HUD, and Three.js world use this frame.
 *
 * Stellar Forge boxel lattice: a nested cubic grid for generation, procedural
 * names, Catalog tiles, and the drawn grid. Its origin is BOXEL_ORIGIN in Elite
 * space, so Sol sits *inside* a cube — not on a corner. Conversion is a
 * translation, not a scale:
 *
 *   boxel = elite − BOXEL_ORIGIN
 *   elite = boxel + BOXEL_ORIGIN
 *
 * Sol’s mass-code **d** (80 ly) cube has its lower-front-left corner at
 * (−65, −25, −25); Sol is offset (+65, +25, +25) from that corner.
 *
 * The drawn grid is a window onto this world-fixed lattice (Y = height plane).
 * Cell size is the selected mass code — never thinned by camera angle.
 * Zoom only changes which mass code is the finest allowed.
 */
export const MASS_CODES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
export type MassCode = (typeof MASS_CODES)[number];

export const BOXEL_ORIGIN = { x: -49985, y: -40985, z: -24105 };
export const GALAXY_DIAMETER = 100000;
/** Max line count per axis in the current view (window cap, not a cell-size change). */
export const MAX_BOXEL_LINES = 256;
/** Tight views still draw this many cells around the look-at so close zoom never empties the lattice. */
export const MIN_BOXEL_CELLS = 24;
/** A cell smaller than this on screen is too fine; bump to the next mass code. */
export const MIN_BOXEL_PX = 8;
/** Position-float capacity for the densest allowed window, including snap slack. */
export const MAX_BOXEL_FLOATS = (MAX_BOXEL_LINES + 8 + 1) * 2 * 6;

export type BoxelWindow = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  size: number;
  stride: number;
};

export type EliteCoords = { x: number; y: number; z: number };

export function boxelSize(code: MassCode): number {
  return 10 * 2 ** (code.charCodeAt(0) - 97);
}

export function massCodeIndex(code: MassCode): number {
  return MASS_CODES.indexOf(code);
}

/** Elite space → Forge-grid coordinates (Sol maps to −BOXEL_ORIGIN). */
export function playerToBoxel(p: EliteCoords): EliteCoords {
  return {
    x: p.x - BOXEL_ORIGIN.x,
    y: p.y - BOXEL_ORIGIN.y,
    z: p.z - BOXEL_ORIGIN.z,
  };
}

/** Forge-grid coordinates → Elite space (Sol stays at the origin). */
export function boxelToPlayer(b: EliteCoords): EliteCoords {
  return {
    x: b.x + BOXEL_ORIGIN.x,
    y: b.y + BOXEL_ORIGIN.y,
    z: b.z + BOXEL_ORIGIN.z,
  };
}

/** Integer boxel index along one axis for a player-space coordinate. */
export function boxelIndex(coord: number, origin: number, size: number): number {
  return Math.floor((coord - origin) / size);
}

/**
 * Lower-front-left corner, in Elite space, of the mass-code cube that contains
 * `coords`. Systems stay at player coordinates; only the cube is lattice-aligned.
 */
export function containingBoxel(
  coords: EliteCoords,
  code: MassCode,
): { ox: number; oy: number; oz: number; size: number } {
  const size = boxelSize(code);
  return {
    ox: snapDown(coords.x, BOXEL_ORIGIN.x, size),
    oy: snapDown(coords.y, BOXEL_ORIGIN.y, size),
    oz: snapDown(coords.z, BOXEL_ORIGIN.z, size),
    size,
  };
}

export function snapDown(coord: number, origin: number, size: number): number {
  return origin + Math.floor((coord - origin) / size) * size;
}

export function snapUp(coord: number, origin: number, size: number): number {
  return origin + Math.ceil((coord - origin) / size) * size;
}

export function snapNearest(coord: number, origin: number, size: number): number {
  return origin + Math.round((coord - origin) / size) * size;
}

/** True when `coord` lies on a boxel face for this mass-code size. */
export function onBoxelLattice(coord: number, origin: number, size: number, eps = 1e-4): boolean {
  const t = (coord - origin) / size;
  return Math.abs(t - Math.round(t)) < eps;
}

/**
 * Finest mass code whose cells are still at least `minPx` on screen at this
 * camera distance. Coarser codes are always allowed; finer ones stay locked.
 */
export function finestMassCode(
  distance: number,
  fovDeg: number,
  viewportPx: number,
  minPx = MIN_BOXEL_PX,
): MassCode {
  const half = Math.max(viewportPx, 1) / 2;
  const worldPerPixel =
    Math.max(distance, 1) * Math.tan((fovDeg * Math.PI) / 360) / half;
  const minWorld = worldPerPixel * minPx;
  for (const code of MASS_CODES) {
    if (boxelSize(code) >= minWorld) return code;
  }
  return "h";
}

/** If `code` is finer than `finest`, bump up to `finest`. */
export function clampMassCode(code: MassCode, finest: MassCode): MassCode {
  return massCodeIndex(code) < massCodeIndex(finest) ? finest : code;
}

/**
 * Lattice-aligned window covering the visible AABB on the galactic plane.
 * Step is always one mass-code cell. A huge view is clipped to MAX_BOXEL_LINES
 * around `look` so orbiting cannot change cell size.
 */
export function boxelWindowForView(
  view: { minX: number; maxX: number; minZ: number; maxZ: number },
  code: MassCode,
  prev?: BoxelWindow,
  look?: { x: number; z: number },
): BoxelWindow {
  const S = boxelSize(code);
  const pad = S * 2;
  let vx0 = view.minX - pad;
  let vx1 = view.maxX + pad;
  let vz0 = view.minZ - pad;
  let vz1 = view.maxZ + pad;
  const maxSpan = MAX_BOXEL_LINES * S;
  const minSpan = S * MIN_BOXEL_CELLS;
  const cx = look?.x ?? (vx0 + vx1) / 2;
  const cz = look?.z ?? (vz0 + vz1) / 2;
  if (!(vx1 - vx0 >= minSpan) || !Number.isFinite(vx0)) {
    vx0 = cx - minSpan / 2;
    vx1 = cx + minSpan / 2;
  }
  if (!(vz1 - vz0 >= minSpan) || !Number.isFinite(vz0)) {
    vz0 = cz - minSpan / 2;
    vz1 = cz + minSpan / 2;
  }
  if (vx1 - vx0 > maxSpan) {
    vx0 = cx - maxSpan / 2;
    vx1 = cx + maxSpan / 2;
  }
  if (vz1 - vz0 > maxSpan) {
    vz0 = cz - maxSpan / 2;
    vz1 = cz + maxSpan / 2;
  }
  const minX = snapDown(vx0, BOXEL_ORIGIN.x, S);
  const maxX = snapUp(vx1, BOXEL_ORIGIN.x, S);
  const minZ = snapDown(vz0, BOXEL_ORIGIN.z, S);
  const maxZ = snapUp(vz1, BOXEL_ORIGIN.z, S);

  if (
    prev &&
    prev.size === S &&
    prev.stride === 1 &&
    prev.minX === minX &&
    prev.maxX === maxX &&
    prev.minZ === minZ &&
    prev.maxZ === maxZ
  ) {
    return prev;
  }
  return { minX, maxX, minZ, maxZ, size: S, stride: 1 };
}

/** World-space XZ line pairs (Y = 0) for a lattice window. */
export function boxelGridWorld(win: BoxelWindow, into?: Float32Array): Float32Array {
  const step = win.size * win.stride;
  const nx = Math.max(1, Math.round((win.maxX - win.minX) / step));
  const nz = Math.max(1, Math.round((win.maxZ - win.minZ) / step));
  const needed = (nx + 1 + nz + 1) * 6;
  const verts = into && into.length >= needed ? into : new Float32Array(needed);
  let p = 0;
  for (let i = 0; i <= nx; i++) {
    const x = win.minX + i * step;
    verts[p++] = x;
    verts[p++] = 0;
    verts[p++] = win.minZ;
    verts[p++] = x;
    verts[p++] = 0;
    verts[p++] = win.maxZ;
  }
  for (let j = 0; j <= nz; j++) {
    const z = win.minZ + j * step;
    verts[p++] = win.minX;
    verts[p++] = 0;
    verts[p++] = z;
    verts[p++] = win.maxX;
    verts[p++] = 0;
    verts[p++] = z;
  }
  return verts.length === p ? verts : verts.subarray(0, p);
}

/** X coordinates of the north–south lines in a window (world-fixed). */
export function boxelGridXs(win: BoxelWindow): number[] {
  const step = win.size * win.stride;
  const nx = Math.max(1, Math.round((win.maxX - win.minX) / step));
  const xs: number[] = [];
  for (let i = 0; i <= nx; i++) xs.push(win.minX + i * step);
  return xs;
}
