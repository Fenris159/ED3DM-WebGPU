import { describe, expect, it } from "vitest";
import {
  detailLoadPresentation,
  filterApplyPresentation,
  filteredDetailResultPresentation,
  galaxyLoadProgressComplete,
  galaxyLoadPresentation,
} from "../src/loading-progress";

describe("galaxy loading progress", () => {
  it("distinguishes completed generation from the intentional 99% render gate", () => {
    const completed = { phase: "detail", completed: 1, total: 1 } as const;
    expect(detailLoadPresentation(completed).percent).toBe(99);
    expect(galaxyLoadProgressComplete(completed)).toBe(true);
    expect(galaxyLoadProgressComplete({
      phase: "detail",
      completed: 0.99,
      total: 1,
    })).toBe(false);
  });

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
    ).toBe(99);
    expect(
      detailLoadPresentation({ phase: "detail", completed: 1, total: 1 }),
    ).toEqual({ percent: 99, label: "Rendering stars... Please Wait" });
    expect(
      detailLoadPresentation({ phase: "detail", completed: 1, total: 1 }, true),
    ).toEqual({ percent: 100, label: "Loaded" });
  });

  it("uses the reusable detail pill for filter generation through final render", () => {
    expect(
      filterApplyPresentation({ phase: "overview", completed: 5_000, total: 20_000 }),
    ).toEqual({
      percent: 23,
      label: "Applying stellar filter... Please Wait",
    });
    expect(
      filterApplyPresentation({ phase: "prepare", completed: 1, total: 1 }),
    ).toEqual({
      percent: 94,
      label: "Preparing filtered stars... Please Wait",
    });
    expect(
      filterApplyPresentation({ phase: "detail", completed: 1, total: 1 }),
    ).toEqual({
      percent: 99,
      label: "Rendering filtered stars... Please Wait",
    });
    expect(
      filterApplyPresentation({ phase: "detail", completed: 1, total: 1 }, true),
    ).toEqual({ percent: 100, label: "Filter applied" });
  });

  it("reports the number of factual filtered points that reached the renderer", () => {
    expect(filteredDetailResultPresentation(4)).toEqual({
      percent: 100,
      label: "Loaded · 4 matching stars",
    });
    expect(filteredDetailResultPresentation(1)).toEqual({
      percent: 100,
      label: "Loaded · 1 matching star",
    });
    expect(filteredDetailResultPresentation(0)).toEqual({
      percent: 100,
      label: "Loaded · no matching stars in this area",
    });
    expect(filteredDetailResultPresentation(0, false)).toEqual({
      percent: 100,
      label: "Overview ready · zoom in for factual stars",
    });
  });
});
