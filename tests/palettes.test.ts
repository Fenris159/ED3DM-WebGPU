import { describe, it, expect } from "vitest";
import { colorFor, mapEconomy, orbScale } from "../src/palettes";

describe("reference palettes", () => {
  it("keeps UNUSED holes in the economy list", () => {
    expect(mapEconomy[4]).toBe("UNUSED");
    expect(colorFor({ primary_economy: "UNUSED" }, "economy")).toBe("#666666");
  });

  it("scales inhabited Systems from population", () => {
    expect(orbScale(undefined)).toBe(130);
    expect(orbScale(0)).toBe(130);
    expect(orbScale(22_780_959_567)).toBeGreaterThan(orbScale(1_000_000_000));
    expect(orbScale(22_780_959_567)).toBeLessThanOrEqual(360);
  });
});
