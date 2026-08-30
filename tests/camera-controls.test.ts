import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";
import {
  cameraZoomPercent,
  cameraPlanarPanAxes,
  createMapControls,
  planarPanDelta,
} from "../src/scene";

function cameraAt(y: number, z: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 250_000);
  camera.up.set(0, 1, 0);
  camera.position.set(0, y, z);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

describe("side-independent map controls", () => {
  it("reports zoom from 0% at the far stop to 100% at the near stop", () => {
    expect(cameraZoomPercent(120_000, 20, 120_000)).toBe(0);
    expect(cameraZoomPercent(20, 20, 120_000)).toBe(100);
    expect(cameraZoomPercent(Math.sqrt(20 * 120_000), 20, 120_000)).toBe(50);
  });

  it("uses a free trackball rotation path without built-in right-button panning", () => {
    const camera = cameraAt(-100, 4);
    const canvas = document.createElement("canvas");
    const controls = createMapControls(camera, canvas);
    expect(controls).toBeInstanceOf(TrackballControls);
    expect(controls.noPan).toBe(true);
    expect(controls.mouseButtons.RIGHT).toBeNull();
    controls.dispose();
  });

  it.each([
    ["above", cameraAt(100, -4)],
    ["below", cameraAt(-100, 4)],
  ])("keeps grabbed-point panning screen-relative from %s the plane", (_side, camera) => {
    const axes = cameraPlanarPanAxes(camera);
    const delta = planarPanDelta(12, -7, 2, axes.right, axes.up);
    expect(delta.x * axes.right.x + delta.z * axes.right.z).toBeCloseTo(-24);
    expect(delta.x * axes.up.x + delta.z * axes.up.z).toBeCloseTo(-14);
  });
});
