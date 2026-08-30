import { describe, expect, it, vi } from "vitest";
import type { GalaxySource, System } from "../src/types";

const sceneHarness = vi.hoisted(() => ({
  handlers: undefined as undefined | { onSelectSystem(index: number): void },
}));

vi.mock("../src/scene", () => ({
  cameraZoomPercent: () => 0,
  attachScene: vi.fn(async (_container, handlers) => {
    sceneHarness.handlers = handlers;
    return {
      sync: vi.fn(),
      flyCamera: vi.fn(),
      setPlaneHeight: vi.fn(),
      planeHeight: () => 0,
      setMassCode: vi.fn(),
      resetTopView: vi.fn(),
      viewState: () => ({
        target: { x: 0, y: 0, z: 0 },
        position: { x: 0, y: 10, z: 10 },
        direction: { x: 0, y: -1, z: -1 },
        distanceLy: 100,
        verticalFovDegrees: 50,
        aspect: 1,
        visibleBounds: {
          minimum: { x: -100, y: -100, z: -100 },
          maximum: { x: 100, y: 100, z: 100 },
        },
      }),
      destroy: vi.fn(),
    };
  }),
}));

import { ED3DM } from "../src/index";

describe("selected-System enrichment", () => {
  it("resolves a clicked rendered System through PEGE before publishing its details", async () => {
    Object.defineProperty(navigator, "gpu", { configurable: true, value: {} });
    const userAgent = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 ED3DM integration test",
    });
    const rendered: System = {
      name: "Known System",
      id64: "42",
      coords: { x: 1, y: 2, z: 3 },
      stellarType: "G",
    };
    const enriched: System = {
      ...rendered,
      stellarSubclass: 2,
      stellarLuminosityClass: "V",
      stellarComponents: [{ bodyId: 0, starType: "G", subclass: 2, luminosityClass: "V", validation: "exact" }],
      stellarPrimaryBodyId: 0,
    };
    const resolve = vi.fn(async () => enriched);
    const onSystemClick = vi.fn();
    const source: GalaxySource = {
      loadOverview: vi.fn(async () => ({ systems: [rendered] })),
      loadRegion: vi.fn(async () => []),
      resolve,
      suggest: vi.fn(async () => []),
      resolveDisplayName: vi.fn(async () => rendered.name),
      destroy: vi.fn(),
    };

    try {
      const map = await ED3DM.create({ container: document.body, source, onSystemClick });
      sceneHarness.handlers!.onSelectSystem(0);
      await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith("42"));
      await vi.waitFor(() => expect(onSystemClick).toHaveBeenLastCalledWith(enriched));
      expect(map.selected()).toBe(enriched);
      map.destroy();
    } finally {
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value: userAgent,
      });
    }
  });
});
