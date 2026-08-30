import { describe, it, expect } from "vitest";
import { colorFor, mapEconomy, orbScale } from "../src/palettes";
import { projectedOrbDiameter } from "../src/orbs";

describe("reference palettes", () => {
  it("keeps UNUSED holes in the economy list", () => {
    expect(mapEconomy[4]).toBe("UNUSED");
    expect(colorFor({ primary_economy: "UNUSED" }, "economy")).toBe("#666666");
  });

  it("uses a compact monotonic scale for stellar radius", () => {
    expect(orbScale(undefined)).toBe(90);
    expect(orbScale(0)).toBe(90);
    expect(orbScale(695_700_000)).toBe(90);
    expect(orbScale(6_957_000_000)).toBeGreaterThan(orbScale(695_700_000));
    expect(orbScale(6_957_000_000)).toBeLessThanOrEqual(260);
  });

  it("lets distant stars become sub-pixel points instead of an opaque ball", () => {
    const defaultScale = orbScale(undefined);
    expect(projectedOrbDiameter(defaultScale, 72_000, 2, 120_000)).toBeCloseTo(1.515);
    expect(projectedOrbDiameter(defaultScale, 72_000, 2, 58)).toBeLessThan(1);
    expect(projectedOrbDiameter(defaultScale, 58, 2, 58)).toBeLessThanOrEqual(12);
  });
});
