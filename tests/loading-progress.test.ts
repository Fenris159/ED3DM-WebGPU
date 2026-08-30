import { describe, expect, it } from "vitest";
import {
  detailLoadPresentation,
  galaxyLoadPresentation,
} from "../src/loading-progress";

describe("galaxy loading progress", () => {
  it("reports monotonic application-owned generation phases", () => {
    const points = [
      galaxyLoadPresentation({ phase: "download", completed: 5, total: 10 }),
      galaxyLoadPresentation({ phase: "decode", completed: 1, total: 1 }),
      galaxyLoadPresentation({ phase: "overview", completed: 50, total: 100 }),
      galaxyLoadPresentation({ phase: "prepare", completed: 1, total: 1 }),
    ];
    expect(points.map((point) => point.percent)).toEqual([28, 68, 81, 98]);
    expect(points[2]!.label).toBe("Generating the galaxy overview");
  });

  it("presents local generation progress as a clamped percentage", () => {
    expect(
      detailLoadPresentation({ phase: "detail", completed: 15, total: 100 }),
    ).toEqual({ percent: 15, label: "Loaded... Please Wait" });
    expect(
      detailLoadPresentation({ phase: "detail", completed: 900, total: 800 }).percent,
    ).toBe(100);
  });
});
