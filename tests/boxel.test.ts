import { describe, it, expect } from "vitest";
import {
  BOXEL_ORIGIN,
  MASS_CODES,
  MAX_BOXEL_LINES,
  MIN_BOXEL_CELLS,
  boxelSize,
  boxelToPlayer,
  boxelWindowForView,
  boxelGridXs,
  clampMassCode,
  containingBoxel,
  finestMassCode,
  massCodeIndex,
  onBoxelLattice,
  playerToBoxel,
  snapDown,
  snapNearest,
} from "../src/boxel";

describe("Elite mass-code boxels", () => {
  it("matches the in-game side lengths a–h", () => {
    expect(MASS_CODES.map(boxelSize)).toEqual([10, 20, 40, 80, 160, 320, 640, 1280]);
  });

  it("keeps a 10 ly a-grid on a huge view instead of thinning the cell size", () => {
    const disc = { minX: -50000, maxX: 50000, minZ: -50000, maxZ: 50000 };
    const h = boxelWindowForView(disc, "h", undefined, { x: 0, z: 0 });
    expect(h.stride).toBe(1);
    expect(h.size).toBe(1280);
    expect(h.maxX - h.minX).toBeGreaterThan(80_000);

    const a = boxelWindowForView(disc, "a", undefined, { x: 0, z: 0 });
    expect(a.stride).toBe(1);
    expect(a.size).toBe(10);
    const lines = (a.maxX - a.minX) / a.size;
    expect(lines).toBeLessThanOrEqual(MAX_BOXEL_LINES + 4);
    expect(onBoxelLattice(a.minX, BOXEL_ORIGIN.x, boxelSize("a"))).toBe(true);
  });

  it("does not change cell size when the view AABB grows at a fixed look-at", () => {
    const look = { x: 0, z: 0 };
    const tight = boxelWindowForView(
      { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
      "a",
      undefined,
      look,
    );
    const wide = boxelWindowForView(
      { minX: -20000, maxX: 20000, minZ: -20000, maxZ: 20000 },
      "a",
      tight,
      look,
    );
    expect(wide.size).toBe(tight.size);
    expect(wide.stride).toBe(1);
    expect(wide.size).toBe(10);
  });

  it("keeps overlapping lines at the same world X when the view pans", () => {
    const first = boxelWindowForView(
      { minX: -30, maxX: 30, minZ: -30, maxZ: 30 },
      "a",
    );
    const panned = boxelWindowForView(
      { minX: -18, maxX: 42, minZ: -30, maxZ: 30 },
      "a",
      first,
    );
    const shared = boxelGridXs(first).filter((x) => x >= panned.minX && x <= panned.maxX);
    const next = new Set(boxelGridXs(panned));
    expect(shared.length).toBeGreaterThan(4);
    for (const x of shared) expect(next.has(x)).toBe(true);
  });

  it("keeps at least 24 a-cells around the look-at when the view AABB is tiny or inverted", () => {
    const look = { x: 5, z: -5 };
    const tiny = boxelWindowForView(
      { minX: 4, maxX: 6, minZ: -6, maxZ: -4 },
      "a",
      undefined,
      look,
    );
    expect(tiny.size).toBe(10);
    expect(tiny.maxX - tiny.minX).toBeGreaterThanOrEqual(MIN_BOXEL_CELLS * 10);
    expect(tiny.maxZ - tiny.minZ).toBeGreaterThanOrEqual(MIN_BOXEL_CELLS * 10);
    expect(tiny.minX).toBeLessThanOrEqual(look.x);
    expect(tiny.maxX).toBeGreaterThanOrEqual(look.x);
    expect(onBoxelLattice(tiny.minX, BOXEL_ORIGIN.x, 10)).toBe(true);

    const inverted = boxelWindowForView(
      { minX: 8000, maxX: -200, minZ: 9000, maxZ: -50 },
      "a",
      undefined,
      { x: 0, z: 0 },
    );
    expect(inverted.maxX).toBeGreaterThan(inverted.minX);
    expect(inverted.minX).toBeLessThanOrEqual(0);
    expect(inverted.maxX).toBeGreaterThanOrEqual(0);
  });

  it("shifts the window by one cell when the look-at crosses a lattice face", () => {
    const a = boxelSize("a");
    const first = boxelWindowForView(
      { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
      "a",
      undefined,
      { x: 0, z: 0 },
    );
    const still = boxelWindowForView(
      { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
      "a",
      first,
      { x: 4, z: 0 },
    );
    expect(still).toBe(first);

    const crossed = boxelWindowForView(
      { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
      "a",
      first,
      { x: -10, z: 0 },
    );
    expect(first.minX - crossed.minX).toBe(a);
    expect(first.maxX - crossed.maxX).toBe(a);
  });

  it("snaps half-box offsets onto the a-grid faces", () => {
    expect(snapNearest(0, BOXEL_ORIGIN.x, 10)).toBe(5);
    expect(snapNearest(10517, BOXEL_ORIGIN.x, 10)).toBe(10515);
    expect(onBoxelLattice(snapNearest(-22032, BOXEL_ORIGIN.z, 10), BOXEL_ORIGIN.z, 10)).toBe(
      true,
    );
  });

  it("unlocks a at Sol distance and requires a coarser code at galaxy distance", () => {
    expect(finestMassCode(56, 50, 800)).toBe("a");
    const far = finestMassCode(30000, 50, 800);
    expect(massCodeIndex(far)).toBeGreaterThan(massCodeIndex("a"));
    expect(clampMassCode("a", far)).toBe(far);
    expect(clampMassCode("h", "a")).toBe("h");
  });

  it("does not put Sol on an a-boxel corner — Stellar Forge origin is offset", () => {
    const a = boxelSize("a");
    expect(onBoxelLattice(0, BOXEL_ORIGIN.x, a)).toBe(false);
    expect(onBoxelLattice(0, BOXEL_ORIGIN.y, a)).toBe(false);
    expect(onBoxelLattice(0, BOXEL_ORIGIN.z, a)).toBe(false);
    expect(onBoxelLattice(-5, BOXEL_ORIGIN.x, a)).toBe(true);
    expect(onBoxelLattice(-5, BOXEL_ORIGIN.y, a)).toBe(true);
    expect(onBoxelLattice(-5, BOXEL_ORIGIN.z, a)).toBe(true);
  });

  it("treats Sol as Elite-space origin and a point inside the Forge lattice", () => {
    const sol = { x: 0, y: 0, z: 0 };
    expect(playerToBoxel(sol)).toEqual({ x: 49985, y: 40985, z: 24105 });
    expect(boxelToPlayer({ x: 49985, y: 40985, z: 24105 })).toEqual(sol);

    const d = containingBoxel(sol, "d");
    expect(d.size).toBe(80);
    expect(d).toEqual({ ox: -65, oy: -25, oz: -25, size: 80 });
    expect(sol.x - d.ox).toBe(65);
    expect(sol.y - d.oy).toBe(25);
    expect(sol.z - d.oz).toBe(25);
    expect(onBoxelLattice(d.ox, BOXEL_ORIGIN.x, d.size)).toBe(true);
    expect(onBoxelLattice(0, BOXEL_ORIGIN.x, d.size)).toBe(false);
    expect(snapDown(0, BOXEL_ORIGIN.x, 80)).toBe(-65);
  });
});

