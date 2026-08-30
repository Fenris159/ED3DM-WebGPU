import { galaxyViewTileKeyString } from "pege";
import { describe, expect, it } from "vitest";
import {
  MAX_VISIBLE_PEGE_TILES,
  cameraViewResidencyTilePlan,
  cameraResidencyTileKeys,
  cameraResidencyTilePlan,
  focusedPegeTileKey,
  pegeTileLevelForDistance,
  pegeTilePointBudget,
  progressivePegeTileShells,
  taperedPegeTilePointBudget,
  visiblePegeTileKeys,
} from "../src/pege-tiles";

describe("PEGE spatial tile view", () => {
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
    expect(pegeTilePointBudget(500, 10, 8)).toBe(6_000);
    expect(pegeTilePointBudget(500, "all", 8)).toBe(60_000);
    expect(pegeTilePointBudget(30_000, 10, 4)).toBe(1_000);
    expect(pegeTilePointBudget(30_000, 0, 4)).toBe(500);
    const plan = cameraResidencyTilePlan({ x: 0, y: 0, z: 0 });
    expect(taperedPegeTilePointBudget(500, 10, plan)).toBe(716);
    expect(taperedPegeTilePointBudget(8_000, "all", plan)).toBeGreaterThan(0);
    expect(taperedPegeTilePointBudget(10_000, "all", plan)).toBe(0);
    expect(taperedPegeTilePointBudget(90_000, 10, plan)).toBe(0);
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
});
