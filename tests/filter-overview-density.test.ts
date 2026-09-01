import { describe, expect, it } from "vitest";
import {
  filterOverviewDensityCells,
  hasResidentReplacementCoverage,
} from "../src/filter-overview-density";
import type { System } from "../src/types";

describe("canonical overview density", () => {
  it("does not treat a sparse completed tile as a full mask replacement", () => {
    const tile = {
      key: "0/0/0/0",
      tileKey: { level: 0, x: 0, y: 0, z: 0 },
      targetSystems: 8,
      populationWeight: 1,
      systems: Array.from({ length: 4 }, (_, index) => ({
        name: `Sparse ${index}`,
        id64: String(index),
        coords: { x: index, y: 0, z: 0 },
      })),
      densityCells: [],
    };
    expect(hasResidentReplacementCoverage([tile], 8)).toBe(false);
    expect(hasResidentReplacementCoverage([
      { ...tile, systems: [...tile.systems, ...tile.systems] },
    ], 8)).toBe(true);
  });

  it("uses only exact matching overview systems when no asset is configured", () => {
    const systems: System[] = [
      { name: "Only X", id64: "1", coords: { x: 0, y: 0, z: 0 }, stellarType: "X", stellarColor: "#abcdef" },
      { name: "Not X", id64: "2", coords: { x: 1, y: 0, z: 0 }, stellarType: "G" },
    ];
    expect(filterOverviewDensityCells(systems, ["X"], []).map(({ sourceKey, color }) => ({ sourceKey, color })))
      .toEqual([{ sourceKey: "1", color: "#abcdef" }]);
  });
});
