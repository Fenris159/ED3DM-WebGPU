import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { topViewCameraPosition } from "../src/scene";
import { gizmoCameraAxes } from "../src/view-gizmo";

describe("default map orientation", () => {
  it("looks through the galactic plane from negative Y with +Z screen-up", () => {
    const target = new THREE.Vector3(25.2, 0, 25_900);
    const position = topViewCameraPosition(target.x, target.y, target.z, 90_000);
    expect(position.y).toBeLessThan(target.y);
    expect(position.z).toBeGreaterThan(target.z);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 250_000);
    camera.up.set(0, 1, 0);
    camera.position.set(position.x, position.y, position.z);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    const axes = gizmoCameraAxes(camera);
    expect(axes.z.y).toBeGreaterThan(0.99);
    expect(axes.y.z).toBeLessThan(-0.99);
  });
});
