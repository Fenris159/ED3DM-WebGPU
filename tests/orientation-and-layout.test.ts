import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { makeRegionLayer } from "../src/region-labels";

describe("map orientation and responsive height controls", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      fillStyle: "",
      font: "",
      lineJoin: "round",
      lineWidth: 1,
      measureText: (text: string) => ({ width: text.length * 52 }),
      miterLimit: 2,
      strokeStyle: "",
      textAlign: "center",
      textBaseline: "middle",
      fillText: vi.fn(),
      strokeText: vi.fn(),
    } as never);
  });

  afterEach(() => vi.restoreAllMocks());

  it("faces region label fronts toward the negative-Y map view", () => {
    const layer = makeRegionLayer(0xffffff);
    const label = layer.children.find((child) => child.userData.regionLabel);
    expect(label).toBeInstanceOf(THREE.Mesh);
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(label!.quaternion);
    expect(normal.y).toBeLessThan(-0.99);
  });

});
