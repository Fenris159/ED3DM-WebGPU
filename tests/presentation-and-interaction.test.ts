import { readFileSync } from "node:fs";
import { Color } from "three";
import { describe, expect, it, vi } from "vitest";
import { ED3DM } from "../src/index";
import { orbScale } from "../src/palettes";
import {
  stellarBrightnessScale,
  stellarLuminositySolar,
} from "../src/stellar-presentation";
import {
  cameraProximityOpacity,
  focusedOrbDiameterCap,
  minimumOrbDiameter,
  farFieldOrbOpacity,
  layeredOrbOpacity,
  densityFieldOpacity,
  representedSystemsPerOverviewPoint,
  galaxyOrbVisibilityScale,
  orbCloud,
  orbPickRadiusWorld,
  projectedOrbDiameter,
  softDiscAlpha,
  stableOrbVisibility,
  stableOrbNoise,
  densityFieldColor,
} from "../src/orbs";
import {
  cameraAnchorTarget,
  cameraAnchorAfterPlanePanStart,
  cameraCruiseProgress,
  isPrimaryClickGesture,
  regionLabelsVisible,
  selectionRingScale,
  selectionPlaneHeight,
  selectionRailIndexes,
  railSelectableIndex,
  planarPanDelta,
  createSceneResizeScheduler,
  scenePixelRatio,
  localNameLabelIndexes,
  localNameLabelSystems,
  localSystemNamesVisible,
  translatedCameraPosition,
} from "../src/scene";
import type { GalaxyRegionRequest, GalaxySource, System } from "../src/types";

describe("galaxy presentation and interaction regressions", () => {
  it("keeps local stellar points pronounced while preserving solar-radius ordering", () => {
    const brownDwarf = orbScale(0.1 * 695_700_000);
    const sol = orbScale(695_700_000);
    const giant = orbScale(25 * 695_700_000);

    expect(brownDwarf).toBeGreaterThanOrEqual(72);
    expect(brownDwarf).toBeLessThan(sol);
    expect(sol).toBeLessThan(giant);
    expect(minimumOrbDiameter(60, 0.75, true)).toBeGreaterThanOrEqual(6);
  });

  it("translates camera and target together when selecting without changing orientation", () => {
    const camera = { x: 40, y: -30, z: 80 };
    const currentTarget = { x: 10, y: 5, z: 15 };
    const selected = { x: -400, y: 22, z: 900 };
    const nextCamera = translatedCameraPosition(camera, currentTarget, selected);

    expect(nextCamera).toEqual({ x: -370, y: -13, z: 965 });
    expect(nextCamera.x - selected.x).toBe(camera.x - currentTarget.x);
    expect(nextCamera.y - selected.y).toBe(camera.y - currentTarget.y);
    expect(nextCamera.z - selected.z).toBe(camera.z - currentTarget.z);
  });

  it("limits System name labels to the selected 10 ly cell and its adjacent shell", () => {
    const system = (name: string, x: number, y: number, z: number): System => ({
      name,
      coords: { x, y, z },
    });
    const systems = [
      system("center", 1, 1, 1),
      system("adjacent", 14.9, -14.9, 14.9),
      system("outside", 15.1, 0, 0),
      system("placeholder", 2, 2, 2),
    ];
    systems[3]!.name = "ID64 123";

    expect(localNameLabelIndexes(systems, { x: 0, y: 0, z: 0 })).toEqual([
      0,
      1,
    ]);
  });

  it("keeps local name labels bound to stable Systems when resident order changes", () => {
    const sol: System = { name: "Sol", coords: { x: 0, y: 0, z: 0 } };
    const neighbor: System = {
      name: "Alpha Centauri",
      coords: { x: 3.031, y: -0.093, z: 3.156 },
    };
    const systems = [sol, neighbor];
    const labels = localNameLabelSystems(systems, sol.coords);

    systems.reverse();

    expect(labels[0]).toBe(sol);
    expect(labels[0]!.coords).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("shows local System names only after entering the close map view", () => {
    expect(localSystemNamesVisible(81)).toBe(false);
    expect(localSystemNamesVisible(80)).toBe(true);
    expect(localSystemNamesVisible(20)).toBe(true);
  });

  it("derives a bounded realistic brightness from factual stellar luminosity", () => {
    expect(stellarLuminositySolar(695_700_000, 5_772)).toBeCloseTo(1, 6);
    expect(stellarLuminositySolar(undefined, undefined, 4.83)).toBeCloseTo(1, 6);
    expect(stellarBrightnessScale(undefined)).toBe(1);
    expect(stellarBrightnessScale(0.0001)).toBeLessThan(1);
    expect(stellarBrightnessScale(10_000)).toBeGreaterThan(1);
    expect(stellarBrightnessScale(1_000_000_000)).toBeLessThanOrEqual(1.7);
    const cloud = orbCloud([
      { x: 0, y: 0, z: 0, r: 90, brightness: 1.4 },
      { x: 1, y: 0, z: 0, r: 90 },
    ], new Color(0xffffff), { maxPx: 12 });
    const presentation = cloud.geometry.getAttribute("instancePresentation");
    expect(presentation.itemSize).toBe(4);
    expect(presentation.getW(0)).toBeCloseTo(1.4);
    expect(presentation.getW(1)).toBe(1);
    cloud.geometry.dispose();
  });

  it("packs orb presentation state below the WebGPU vertex-buffer limit", () => {
    const cloud = orbCloud(
      [{
        x: 0,
        y: 0,
        z: 0,
        r: 110,
        visibility: 0.7,
        opacityNoise: 0.4,
        detail: true,
        selected: true,
        focused: true,
        brightness: 1.2,
      }],
      new Color(0xffffff),
      { maxPx: 12, soft: true },
    );
    const presentation = cloud.geometry.getAttribute("instancePresentation");
    const state = cloud.geometry.getAttribute("instanceState");

    expect(presentation.itemSize).toBe(4);
    expect(presentation.getX(0)).toBe(110);
    expect(presentation.getY(0)).toBeCloseTo(0.7);
    expect(presentation.getZ(0)).toBeCloseTo(0.4);
    expect(presentation.getW(0)).toBeCloseTo(1.2);
    expect(state.itemSize).toBe(4);
    expect([state.getX(0), state.getY(0), state.getZ(0)]).toEqual([1, 1, 1]);
    expect(cloud.geometry.getAttribute("instanceDetail")).toBeUndefined();
    cloud.geometry.dispose();
  });

  it("fades and click-masks camera-side foreground stars without hiding the target plane", () => {
    const camera = { x: 0, y: 100, z: 0 };
    const target = { x: 0, y: 0, z: 0 };
    expect(
      cameraProximityOpacity(
        { x: 0, y: 92, z: 0 },
        camera,
        100,
        0,
        false,
        false,
        target,
      ),
    ).toBeLessThan(0.1);
    expect(
      cameraProximityOpacity(
        { x: 0, y: 0, z: 0 },
        camera,
        100,
        0,
        false,
        false,
        target,
      ),
    ).toBe(1);
    expect(
      cameraProximityOpacity(
        { x: 0, y: 92, z: 0 },
        camera,
        100,
        0,
        true,
        true,
        target,
      ),
    ).toBe(1);
    expect(
      cameraProximityOpacity(
        { x: 0, y: 50, z: 0 },
        camera,
        100,
        0,
        false,
        true,
        target,
      ),
    ).toBeLessThan(0.02);
    expect(
      cameraProximityOpacity(
        { x: 0, y: -10, z: 0 },
        camera,
        100,
        0,
        false,
        true,
        target,
      ),
    ).toBe(1);
    expect(
      cameraProximityOpacity(
        { x: 20, y: 50, z: 0 },
        camera,
        100,
        0,
        false,
        true,
        target,
      ),
    ).toBe(1);
  });

  it("composes soft-disc falloff with the per-star opacity mask", () => {
    expect(softDiscAlpha(0, 0)).toBe(0);
    expect(softDiscAlpha(0, 0.25)).toBeCloseTo(0.2375);
    expect(softDiscAlpha(0.75, 1)).toBeGreaterThan(0);
    expect(softDiscAlpha(1, 1)).toBe(0);
  });

  it("grows selected and connected orbs only past 85% zoom with camera-depth perspective", () => {
    expect(focusedOrbDiameterCap(100, 100, true)).toBe(12);
    expect(focusedOrbDiameterCap(58, 58, true)).toBeGreaterThan(12);
    expect(focusedOrbDiameterCap(58, 40, true)).toBeGreaterThan(
      focusedOrbDiameterCap(58, 58, true),
    );
    expect(focusedOrbDiameterCap(58, 80, true)).toBeLessThan(
      focusedOrbDiameterCap(58, 58, true),
    );
    expect(focusedOrbDiameterCap(20, 20, true)).toBeGreaterThan(40);
    expect(focusedOrbDiameterCap(20, 20, true)).toBeLessThanOrEqual(53);
    expect(focusedOrbDiameterCap(20, 20, false)).toBe(12);
  });

  function luminance(hex: string): number {
    const rgb = hex.match(/[\da-f]{2}/gi)!.map((part) => {
      const value = Number.parseInt(part, 16) / 255;
      return value <= 0.04045
        ? value / 12.92
        : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
  }

  function contrast(left: string, right: string): number {
    const [bright, dark] = [luminance(left), luminance(right)].sort(
      (a, b) => b - a,
    );
    return (bright! + 0.05) / (dark! + 0.05);
  }

  it("does not inflate distant stars into overlapping multi-pixel rows", () => {
    expect(minimumOrbDiameter(100_000)).toBeLessThanOrEqual(1.8);
    expect(minimumOrbDiameter(100_000, 0)).toBeGreaterThanOrEqual(1);
    expect(minimumOrbDiameter(100_000, 1)).toBeGreaterThan(2.2);
    expect(projectedOrbDiameter(48, 100_000, 1, 100_000)).toBeLessThanOrEqual(1.8);
  });

  it("uses stable per-System visibility variation to break uniform row energy", () => {
    const sample = Array.from({ length: 256 }, (_, index) =>
      stableOrbVisibility(String(index)),
    );
    expect(stableOrbVisibility("10477373803")).toBe(
      stableOrbVisibility("10477373803"),
    );
    expect(Math.min(...sample)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...sample)).toBeLessThan(1);
    expect(Math.max(...sample) - Math.min(...sample)).toBeGreaterThan(0.9);
    expect(galaxyOrbVisibilityScale(0.5)).toBeLessThan(0.1);
    expect(galaxyOrbVisibilityScale(1)).toBeGreaterThan(1);
  });

  it("keeps the selection hit radius close to the rendered star", () => {
    const localRadius = orbPickRadiusWorld(60, 50, 800);
    const galaxyRadius = orbPickRadiusWorld(30_000, 50, 800);
    expect(localRadius).toBeLessThan(1);
    expect(galaxyRadius).toBeGreaterThan(100);
    expect(galaxyRadius).toBeLessThan(300);
  });

  it("keeps the selection ring legible at a whole-galaxy distance", () => {
    expect(selectionRingScale(30_000)).toBeGreaterThan(100);
  });

  it("anchors rotation to the selected System's full three-dimensional position", () => {
    expect(cameraAnchorTarget({ x: 12, y: -345, z: 67 }, 90)).toEqual({
      x: 12,
      y: -345,
      z: 67,
    });
    expect(cameraAnchorTarget(undefined, 90)).toBeUndefined();
  });

  it("does not classify a left-button rotation drag as a deselection click", () => {
    expect(isPrimaryClickGesture(0, 120, 80, 122, 82)).toBe(true);
    expect(isPrimaryClickGesture(0, 120, 80, 160, 105)).toBe(false);
    expect(isPrimaryClickGesture(2, 120, 80, 120, 80)).toBe(false);
  });

  it("fades the persistent overview at close range without fading factual detail", () => {
    expect(layeredOrbOpacity(0.5, 50, false)).toBeLessThan(0.03);
    expect(layeredOrbOpacity(0.5, 50, true)).toBe(1);
    expect(layeredOrbOpacity(0.5, 8_000, false)).toBeGreaterThan(0.99);
  });

  it("uses a non-pickable aggregate density field that yields to factual local detail", () => {
    expect(representedSystemsPerOverviewPoint(50_000)).toBe(8_000_000);
    expect(densityFieldOpacity(100_000)).toBeGreaterThan(0.9);
    expect(densityFieldOpacity(8_000)).toBeGreaterThan(0.7);
    expect(densityFieldOpacity(1_600)).toBe(1);
    expect(densityFieldOpacity(300)).toBeGreaterThan(0);
    expect(densityFieldOpacity(20)).toBe(1);
    expect(densityFieldOpacity(0)).toBe(0);
  });

  it("colors aggregate density from a cool core into a varied warm outer disk", () => {
    const core = densityFieldColor({ x: 25.2, y: 0, z: 25_900 }, "core");
    const rim = densityFieldColor({ x: 40_025.2, y: 0, z: 25_900 }, "rim");
    const nearbyRim = densityFieldColor(
      { x: 39_900, y: 0, z: 25_900 },
      "nearby-rim",
    );
    expect(core.b).toBeGreaterThan(core.r);
    expect(rim.r).toBeGreaterThan(rim.b);
    expect(nearbyRim).not.toEqual(rim);
    expect(densityFieldColor({ x: 25.2, y: 0, z: 25_900 }, "core")).toEqual(core);
  });

  it("moves the grid plane to a newly selected System without rewinding on deselection", () => {
    expect(selectionPlaneHeight(12, { x: 1, y: -345, z: 2 })).toBe(-345);
    expect(selectionPlaneHeight(-345, undefined)).toBe(-345);
  });

  it("constrains an active selection to its five connected nearest neighbors", () => {
    const selected: System = {
      name: "Selected",
      id64: "1",
      coords: { x: 0, y: 0, z: 0 },
    };
    const systems: System[] = [
      selected,
      ...Array.from({ length: 6 }, (_, index) => ({
        name: `Neighbor ${index + 1}`,
        id64: String(index + 2),
        coords: { x: index + 1, y: 0, z: 0 },
      })),
      { name: "Too far", id64: "99", coords: { x: 500, y: 0, z: 0 } },
    ];
    const rails = selectionRailIndexes(systems, selected);
    expect(rails).toEqual([1, 2, 3, 4, 5]);
    expect(railSelectableIndex(3, rails, true)).toBe(true);
    expect(railSelectableIndex(6, rails, true)).toBe(false);
    expect(railSelectableIndex(6, rails, false)).toBe(true);
  });

  it("releases the selected rotation anchor when a planar pan begins", () => {
    expect(cameraAnchorAfterPlanePanStart({ x: 1, y: 2, z: 3 })).toBeUndefined();
  });

  it("maps right-drag vertical motion in the same grab direction as the pointer", () => {
    const right = { x: 1, z: 0 };
    const forward = { x: 0, z: 1 };
    expect(planarPanDelta(10, 0, 2, right, forward)).toEqual({ x: -20, z: 0 });
    expect(planarPanDelta(0, 10, 2, right, forward)).toEqual({ x: 0, z: 20 });
  });

  it("coalesces a resize storm into one renderer allocation using the final dimensions", () => {
    let width = 1_200;
    let height = 800;
    let pending: (() => void) | undefined;
    let handle = 0;
    const apply = vi.fn();
    const cancel = vi.fn();
    const resize = createSceneResizeScheduler(
      () => ({ width, height }),
      apply,
      (callback) => {
        pending = callback;
        handle += 1;
        return handle;
      },
      cancel,
    );

    for (let index = 0; index < 100; index += 1) {
      width = 1_200 + index;
      height = index % 2 === 0 ? 0 : 800 + index;
      resize.request();
    }
    expect(apply).not.toHaveBeenCalled();
    expect(pending).toBeDefined();
    expect(cancel).toHaveBeenCalledTimes(99);

    height = 899;
    pending!();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(1_299, 899);

    width = 0;
    height = 0;
    resize.request();
    pending!();
    expect(apply).toHaveBeenCalledTimes(1);

    width = 1_400;
    height = 900;
    resize.request();
    resize.destroy();
    expect(cancel).toHaveBeenLastCalledWith(102);
    pending!();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("caps resize framebuffer area on high-DPI displays", () => {
    expect(scenePixelRatio(1_920, 1_080, 2)).toBe(2);
    const large = scenePixelRatio(7_680, 4_320, 2);
    expect(7_680 * 4_320 * large * large).toBeLessThanOrEqual(12_000_001);
    expect(large).toBeGreaterThanOrEqual(0.5);
  });

  it("uses independent stable noise to diffuse far-field row energy", () => {
    const size = Array.from({ length: 1_024 }, (_, index) =>
      stableOrbNoise(String(45_243_364_000_000n + BigInt(index) * 8n), 0x51f15e),
    );
    const opacity = Array.from({ length: 1_024 }, (_, index) =>
      stableOrbNoise(String(45_243_364_000_000n + BigInt(index) * 8n), 0xa17fa9),
    );
    const mean = (values: number[]) =>
      values.reduce((total, value) => total + value, 0) / values.length;
    const sizeMean = mean(size);
    const opacityMean = mean(opacity);
    const covariance = mean(
      size.map((value, index) =>
        (value - sizeMean) * (opacity[index]! - opacityMean),
      ),
    );
    expect(Math.min(...opacity)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...opacity)).toBeLessThan(1);
    expect(Math.abs(covariance)).toBeLessThan(0.02);
    expect(farFieldOrbOpacity(0, 0)).toBe(1);
    expect(farFieldOrbOpacity(0, 100_000)).toBeGreaterThan(0);
    expect(farFieldOrbOpacity(0, 100_000)).toBeGreaterThanOrEqual(0.07);
    expect(farFieldOrbOpacity(0, 100_000)).toBeLessThan(0.1);
    expect(farFieldOrbOpacity(1, 100_000)).toBe(1);

    const overviewOpacity = Array.from({ length: 1_000 }, (_, index) =>
      farFieldOrbOpacity(
        stableOrbNoise(String(45_243_364_000_000n + BigInt(index) * 8n), 0xa17fa9),
        100_000,
      ),
    );
    expect(overviewOpacity.filter((opacity) => opacity > 0.2).length).toBeGreaterThan(550);
    expect(overviewOpacity.filter((opacity) => opacity > 0.2).length).toBeLessThan(750);
  });

  it("finishes camera travel by elapsed time instead of frame count", () => {
    expect(cameraCruiseProgress(0)).toBe(0);
    expect(cameraCruiseProgress(325)).toBeCloseTo(0.875);
    expect(cameraCruiseProgress(650)).toBe(1);
    expect(cameraCruiseProgress(5_000)).toBe(1);
  });

  it("hides galaxy-scale region titles from close local views", () => {
    expect(regionLabelsVisible(1_999)).toBe(false);
    expect(regionLabelsVisible(2_000)).toBe(true);
  });

  it("selects and focuses a resolved search result before detail finishes", async () => {
    const sol: System = {
      name: "Sol",
      id64: "10477373803",
      coords: { x: 0, y: 0, z: 0 },
      generation: "authored",
    };
    let finishDetail!: (systems: System[]) => void;
    const source: GalaxySource = {
      loadOverview: vi.fn(async () => ({ systems: [] })),
      loadRegion: vi.fn(
        () => new Promise<System[]>((resolve) => { finishDetail = resolve; }),
      ),
      resolve: vi.fn(async () => sol),
      suggest: vi.fn(async () => []),
      resolveDisplayName: vi.fn(async () => "Sol"),
      destroy: vi.fn(),
    };

    const map = await ED3DM.create({ container: document.body, source, lod: 10 });
    const flying = map.flyTo("Sol");
    await expect(flying).resolves.toBe(sol);
    expect(map.selected()).toBe(sol);
    finishDetail([sol]);
    await vi.waitFor(() => expect(map.visibleSystems()).toContain(sol));
    map.destroy();
  });

  it("starts local residency at a decoded boxel while exact name replay continues", async () => {
    const preview = {
      name: "Dense generated candidate",
      id64: "42",
      coords: { x: 200, y: -30, z: 400 },
      exactPosition: false,
    };
    const exact: System = {
      name: preview.name,
      id64: preview.id64,
      coords: { x: 212, y: -24, z: 391 },
      generation: "ordinary",
    };
    let finishResolve!: (system: System) => void;
    const loadRegion = vi.fn(async (_request: GalaxyRegionRequest) => [] as System[]);
    const source: GalaxySource = {
      loadOverview: vi.fn(async () => ({ systems: [] })),
      loadRegion,
      preview: vi.fn(async () => [preview]),
      resolve: vi.fn(
        () => new Promise<System>((resolve) => { finishResolve = resolve; }),
      ),
      suggest: vi.fn(async () => []),
      resolveDisplayName: vi.fn(async () => exact.name),
      destroy: vi.fn(),
    };

    const map = await ED3DM.create({ container: document.body, source, lod: "all" });
    const flying = map.flyTo(preview.name);
    await vi.waitFor(() => expect(loadRegion).toHaveBeenCalled());
    const firstRequest = loadRegion.mock.calls[0]![0];
    expect(firstRequest.bounds?.minimum.x).toBeLessThanOrEqual(preview.coords.x);
    expect(firstRequest.bounds?.minimum.y).toBeLessThanOrEqual(preview.coords.y);
    expect(firstRequest.bounds?.minimum.z).toBeLessThanOrEqual(preview.coords.z);
    expect(firstRequest.bounds?.maximum.x).toBeGreaterThan(preview.coords.x);
    expect(firstRequest.bounds?.maximum.y).toBeGreaterThan(preview.coords.y);
    expect(firstRequest.bounds?.maximum.z).toBeGreaterThan(preview.coords.z);
    expect(map.selected()).toBeUndefined();

    finishResolve(exact);
    await expect(flying).resolves.toBe(exact);
    expect(map.selected()).toBe(exact);
    map.destroy();
  });

  it("boots the demo and its loading status in realistic mode", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).toMatch(/<html[^>]+data-theme="realistic"/);
    expect(html).toMatch(
      /data-theme="realistic" aria-pressed="true" title="Realistic stars"/,
    );
    expect(html).toContain("Downloading PEGE 1.6 engine data");
    expect(html).toContain('id="detail-loading-status"');
    expect(html).toContain("Loaded... Please Wait");
    expect(html).not.toContain("Density glow is not selectable");
    expect(html).not.toContain("Click any factual star");
    expect(html).toContain("Left-drag rotates freely");
    expect(html).toContain("Right-drag grabs and pans X/Z");
    expect(html).toContain("<span>zoom</span>");
    expect(html).toContain('id="zoom-percent"');
    expect(html).toMatch(/<label>Grid size\s*<select id="grid-size"/);
    expect(html).toMatch(/<option value="h" selected>1280 ly<\/option>/);
    expect(html).toMatch(/<label>Mass code\s*<select id="masscode-filter"/);
    expect(html).toContain('<option value="all" selected>All</option>');
    expect(html).toContain('id="masscode-children"');
    expect(html).toContain("show child boxels");
    expect(html).not.toMatch(/id="grid"[^>]+checked/);
    expect(html).not.toMatch(/id="regions"[^>]+checked/);
    expect(html).not.toContain('optgroup label="Generation"');
    expect(html).not.toContain('value="generation:authored"');
    expect(html).toContain('id="filter-options"');
    expect(html).toContain('id="filter-summary"');
    expect(html).toMatch(/#detail-loading-status\s*\{[^}]*background: var\(--surface\)/s);
    expect(html).toMatch(/#panel\s*\{[^}]*max-height: calc\(100vh - 144px\)/s);
    expect(html).not.toMatch(/#panel\s*\{[^}]*bottom: 72px/s);
  });

  it("keeps primary and muted UI text readable in every theme", () => {
    const themes = [
      { background: "#eaeae8", ink: "#1a1a19", mute: "#5f5f5a" },
      { background: "#1c1c1b", ink: "#f4f2eb", mute: "#bbb9b1" },
      { background: "#07060c", ink: "#f6f2e9", mute: "#c0bac9" },
    ];
    for (const theme of themes) {
      expect(contrast(theme.ink, theme.background)).toBeGreaterThanOrEqual(7);
      expect(contrast(theme.mute, theme.background)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
