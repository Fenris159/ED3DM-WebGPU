import { describe, it, expect } from "vitest";
import * as THREE from "three/webgpu";
import { gizmoCameraAxes } from "../src/view-gizmo";

function topDown() {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.up.set(0, 1, 0);
  camera.position.set(0, 100, -4);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

describe("view compass axes", () => {
  it("top-down: +Z toward the core (screen up), +Y height toward the viewer", () => {
    const d = gizmoCameraAxes(topDown());
    expect(d.z.y).toBeGreaterThan(0.9);
    expect(Math.abs(d.z.x)).toBeLessThan(0.2);
    expect(Math.abs(d.y.z)).toBeGreaterThan(0.9);
    expect(Math.abs(d.y.x)).toBeLessThan(0.2);
  });

  it("looking toward the core along +Z: Y is height", () => {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    camera.up.set(0, 1, 0);
    camera.position.set(0, 0, -100);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const d = gizmoCameraAxes(camera);
    expect(d.y.y).toBeGreaterThan(0.9);
    expect(d.z.z).toBeLessThan(-0.9);
  });
});
