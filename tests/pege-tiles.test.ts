import { galaxyViewTileKeyString } from "pege";
import { describe, expect, it } from "vitest";
import {
  MAX_VISIBLE_PEGE_TILES,
  cameraViewResidencyTilePlan,
  cameraResidencyAnchor,
  cameraResidencyTileKeys,
  cameraResidencyTilePlan,
  focusedPegeTileKey,
  pegeTileLevelForDistance,
  pegeTilePointBudget,
  progressivePegeTileShells,
  radialSpatialShellContains,
  radialSpatialShellPlan,
  radialSpatialShellTargets,
  taperedPegeTilePointBudget,
  visiblePegeTileKeys,
} from "../src/pege-tiles";

describe("PEGE spatial tile view", () => {
  it("anchors residency to selection, then camera focus plus height as fallback", () => {
    expect(
      cameraResidencyAnchor(
        { x: 1, y: 2, z: 3 },
        { x: 100, y: 200, z: 300 },
        400,
      ),
    ).toEqual({ x: 1, y: 2, z: 3 });
    expect(
      cameraResidencyAnchor(
        undefined,
        { x: 100, y: 200, z: 300 },
        400,
      ),
    ).toEqual({ x: 100, y: 400, z: 300 });
  });

  it("keeps foreground residency in the one camera-target tile", () => {
    expect(focusedPegeTileKey({ x: 0, y: 0, z: 0 }, 30_000)).toEqual({
      level: pegeTileLevelForDistance(30_000),
      x: 0,
      y: 0,
      z: 0,
    });
    expect(focusedPegeTileKey({ x: -1, y: -1, z: -1 }, 30_000)).toEqual({
      level: pegeTileLevelForDistance(30_000),
      x: -1,
      y: -1,
      z: -1,
    });
  });

  it("adds only the h-scale neighbors that can blend a nearby boundary", () => {
    const sol = cameraResidencyTileKeys({ x: 0, y: 0, z: 0 });
    // Forge's h lattice puts Sol close to the negative X/Y/Z boundaries,
    // so the center, three faces, three edges, and corner are resident.
    expect(sol).toHaveLength(8);
    expect(sol.length).toBeLessThanOrEqual(MAX_VISIBLE_PEGE_TILES);
    expect(new Set(sol.map(({ level }) => level))).toEqual(new Set([0]));

    const stillInside = cameraResidencyTileKeys({ x: 100, y: 100, z: 100 });
    expect(stillInside).toEqual(sol);
    expect(cameraResidencyTileKeys({ x: 635, y: 635, z: 635 })).toHaveLength(1);
    const crossed = cameraResidencyTileKeys({ x: 1_300, y: 100, z: 100 });
    expect(crossed).not.toEqual(sol);
    expect(crossed.filter((key) => sol.some((old) => galaxyViewTileKeyString(old) === galaxyViewTileKeyString(key))).length)
      .toBeGreaterThanOrEqual(sol.length / 2);
  });

  it("tapers adjacent h-boxel residency instead of loading the shell uniformly", () => {
    const plan = cameraResidencyTilePlan({ x: 0, y: 0, z: 0 });
    const weights = plan.map(({ weight }) => weight);
    expect(Math.max(...weights)).toBeGreaterThan(0.9);
    expect(Math.min(...weights)).toBeCloseTo(0.12);
    expect(weights.filter((weight) => weight === 1)).toHaveLength(1);
    expect(weights.filter((weight) => weight === 0.45)).toHaveLength(3);
    expect(weights.filter((weight) => weight === 0.25)).toHaveLength(3);
    expect(weights.filter((weight) => weight === 0.12)).toHaveLength(1);
    expect(plan.map(({ key }) => key)).toEqual(
      cameraResidencyTileKeys({ x: 0, y: 0, z: 0 }),
    );
  });

  it("keeps the complete tapered h-boxel shell resident at exact-local range", () => {
    const plan = cameraResidencyTilePlan({ x: 635, y: 635, z: 635 }, true);
    expect(plan).toHaveLength(27);
    expect(plan.filter(({ weight }) => weight === 1)).toHaveLength(1);
    expect(plan.filter(({ weight }) => weight === 0.45)).toHaveLength(6);
    expect(plan.filter(({ weight }) => weight === 0.25)).toHaveLength(12);
    expect(plan.filter(({ weight }) => weight === 0.12)).toHaveLength(8);
  });

  it("publishes the center before progressively smaller adjacent shells", () => {
    const plan = cameraResidencyTilePlan({ x: 635, y: 635, z: 635 }, true);
    const shells = progressivePegeTileShells(plan, 10_000);
    expect(shells.map(({ keyWeights }) => keyWeights.length)).toEqual([1, 6, 12, 8]);
    expect(shells.map(({ totalTargetSystems }) => totalTargetSystems)).toEqual([
      5_495,
      2_473,
      1_374,
      658,
    ]);
    expect(shells.reduce((total, shell) => total + shell.totalTargetSystems, 0))
      .toBe(10_000);
  });
  it("uses globally anchored tiles on both sides of Sol", () => {
    const keys = visiblePegeTileKeys(
      {
        minimum: { x: -100, y: -100, z: -100 },
        maximum: { x: 100, y: 100, z: 100 },
      },
      500,
    );
    expect(keys).toHaveLength(8);
    expect(keys.map(galaxyViewTileKeyString)).toContain("0/-1/-1/-1");
    expect(keys.map(galaxyViewTileKeyString)).toContain("0/0/0/0");
  });

  it("raises the tile level until a whole-galaxy frustum stays bounded", () => {
    const keys = visiblePegeTileKeys(
      {
        minimum: { x: -100_000, y: -100_000, z: -100_000 },
        maximum: { x: 100_000, y: 100_000, z: 100_000 },
      },
      90_000,
    );
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.length).toBeLessThanOrEqual(MAX_VISIBLE_PEGE_TILES);
    expect(new Set(keys.map(({ level }) => level))).toEqual(
      new Set([keys[0]!.level]),
    );
    expect(keys[0]!.level).toBeGreaterThanOrEqual(
      pegeTileLevelForDistance(90_000),
    );
  });

  it("uses zoom and LOD for a bounded tile-local point budget", () => {
    expect(pegeTilePointBudget(100, "all", 8)).toBeGreaterThan(0);
    expect(pegeTilePointBudget(100, "all", 8)).toBeGreaterThanOrEqual(
      pegeTilePointBudget(500, "all", 8),
    );
    expect(pegeTilePointBudget(500, 10, 8)).toBe(5_800);
    expect(pegeTilePointBudget(500, "all", 8)).toBe(58_000);
    expect(pegeTilePointBudget(30_000, 10, 4)).toBe(2_000);
    expect(pegeTilePointBudget(30_000, 0, 4)).toBe(1_000);
    const plan = cameraResidencyTilePlan({ x: 0, y: 0, z: 0 });
    expect(taperedPegeTilePointBudget(500, 10, plan)).toBe(692);
    expect(taperedPegeTilePointBudget(8_000, "all", plan)).toBeGreaterThan(0);
    expect(taperedPegeTilePointBudget(10_000, "all", plan)).toBe(0);
    expect(taperedPegeTilePointBudget(90_000, 10, plan)).toBe(0);
  });

  it("ramps local detail continuously through the 30 to 70 percent zoom range", () => {
    const budgets = [9_012, 3_802, 1_604, 677, 286].map((distance) =>
      pegeTilePointBudget(distance, "all", 27),
    );
    expect(budgets).toEqual([...budgets].sort((left, right) => left - right));
    expect(new Set(budgets).size).toBe(budgets.length);
    expect(budgets[0]).toBeGreaterThanOrEqual(20_000);
    expect(budgets.at(-1)).toBe(60_000);
  });

  it("pads residency around the camera-visible window instead of exposing its edge", () => {
    const plan = cameraViewResidencyTilePlan({
      target: { x: 635, y: 635, z: 635 },
      position: { x: 635, y: -42, z: 650 },
      direction: { x: 0, y: 1, z: 0 },
      distanceLy: 677,
      verticalFovDegrees: 50,
      aspect: 1.6,
      visibleBounds: {
        minimum: { x: -700, y: -700, z: -700 },
        maximum: { x: 1_970, y: 1_970, z: 1_970 },
      },
    });
    expect(plan.length).toBeGreaterThan(1);
    expect(plan.some(({ weight }) => weight < 1)).toBe(true);
    expect(plan.length).toBeLessThanOrEqual(MAX_VISIBLE_PEGE_TILES);
  });

  it("does not let an asymmetric camera window turn local residency into a one-way wedge", () => {
    const plan = cameraViewResidencyTilePlan({
      target: { x: 635, y: 635, z: 635 },
      position: { x: 635, y: -1_100, z: 650 },
      direction: { x: 0, y: 1, z: 0 },
      distanceLy: 1_734,
      verticalFovDegrees: 50,
      aspect: 1.6,
      visibleBounds: {
        minimum: { x: 500, y: -600, z: 500 },
        maximum: { x: 5_500, y: 1_900, z: 5_500 },
      },
    });
    const center = focusedPegeTileKey({ x: 635, y: 635, z: 635 }, 1_280);
    expect(Math.min(...plan.map(({ key }) => key.x))).toBeLessThan(center.x);
    expect(Math.max(...plan.map(({ key }) => key.x))).toBeGreaterThan(center.x);
    expect(Math.min(...plan.map(({ key }) => key.z))).toBeLessThan(center.z);
    expect(Math.max(...plan.map(({ key }) => key.z))).toBeGreaterThan(center.z);
  });

  it("centers an H-sized core and tapered G/F/E-width area tiers on all six sides", () => {
    const focus = { x: 635, y: -73, z: 219 };
    const shells = radialSpatialShellPlan(focus);
    expect(shells.map(({ tier }) => tier)).toEqual(["h", "g", "f", "e"]);
    expect(shells.map(({ weight }) => weight)).toEqual([1, 0.45, 0.25, 0.12]);
    expect(shells.map(({ outerBounds }) =>
      outerBounds.maximum.x - outerBounds.minimum.x,
    )).toEqual([1_280, 2_560, 3_200, 3_520]);
    expect(shells.map(({ outerBounds }) =>
      outerBounds.maximum.z - outerBounds.minimum.z,
    )).toEqual([1_280, 2_560, 3_200, 3_520]);
    expect(shells.map(({ outerBounds }) =>
      outerBounds.maximum.y - outerBounds.minimum.y,
    )).toEqual([1_280, 2_560, 3_200, 3_520]);
    expect(shells.every(({ outerBounds }) =>
      (outerBounds.minimum.x + outerBounds.maximum.x) / 2 === focus.x &&
      (outerBounds.minimum.y + outerBounds.maximum.y) / 2 === focus.y &&
      (outerBounds.minimum.z + outerBounds.maximum.z) / 2 === focus.z,
    )).toBe(true);
    expect(shells.every(({ keys }) =>
      keys.length > 0 && keys.length <= MAX_VISIBLE_PEGE_TILES,
    )).toBe(true);
    expect(shells[0]!.keys.every(({ level }) => level === 0)).toBe(true);
    expect(shells.slice(1).every(({ keys }) =>
      keys.every(({ level }) => level >= 1),
    )).toBe(true);

    const [h, g, f, e] = shells;
    const hBounds = h!.outerBounds;
    const centerX = (hBounds.minimum.x + hBounds.maximum.x) / 2;
    const centerZ = (hBounds.minimum.z + hBounds.maximum.z) / 2;
    expect(radialSpatialShellContains(h!, focus)).toBe(true);
    expect(radialSpatialShellContains(g!, {
      x: hBounds.minimum.x - 1,
      y: focus.y,
      z: centerZ,
    })).toBe(true);
    expect(radialSpatialShellContains(g!, {
      x: hBounds.maximum.x,
      y: focus.y,
      z: centerZ,
    })).toBe(true);
    expect(radialSpatialShellContains(g!, {
      x: centerX,
      y: hBounds.minimum.y - 1,
      z: centerZ,
    })).toBe(true);
    expect(radialSpatialShellContains(g!, {
      x: centerX,
      y: hBounds.maximum.y,
      z: centerZ,
    })).toBe(true);
    expect(radialSpatialShellContains(g!, {
      x: centerX,
      y: focus.y,
      z: hBounds.minimum.z - 1,
    })).toBe(true);
    expect(radialSpatialShellContains(g!, {
      x: centerX,
      y: focus.y,
      z: hBounds.maximum.z,
    })).toBe(true);
    expect(radialSpatialShellContains(g!, focus)).toBe(false);
    expect(radialSpatialShellContains(f!, {
      x: g!.outerBounds.minimum.x - 1,
      y: focus.y,
      z: centerZ,
    })).toBe(true);
    expect(radialSpatialShellContains(e!, {
      x: f!.outerBounds.minimum.x - 1,
      y: focus.y,
      z: centerZ,
    })).toBe(true);

    const targets = radialSpatialShellTargets(shells, 60_000);
    expect(targets.reduce((sum, target) => sum + target, 0)).toBe(60_000);
    expect(targets[0]).toBeGreaterThan(targets[1]!);
    expect(targets[1]).toBeGreaterThan(targets[2]!);
    expect(targets[2]).toBeGreaterThan(targets[3]!);
  });
});
