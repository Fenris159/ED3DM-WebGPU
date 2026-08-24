import {
  AdditiveBlending,
  Color,
  InstancedBufferAttribute,
  InstancedPointsNodeMaterial,
  Matrix4,
  Mesh,
  NodeMaterial,
  NormalBlending,
  Ray,
  Vector3,
  type Intersection,
  type Raycaster,
} from "three/webgpu";
import InstancedPointsGeometry from "three/examples/jsm/geometries/InstancedPointsGeometry.js";
import InstancedPoints from "three/examples/jsm/objects/InstancedPoints.js";
import {
  Fn,
  attribute,
  cameraProjectionMatrix,
  clamp,
  float,
  length,
  lengthSq,
  max,
  mix,
  modelViewMatrix,
  positionGeometry,
  smoothstep,
  uniform,
  uv,
  vec4,
  viewport,
} from "three/tsl";

export type OrbItem = {
  x: number;
  y: number;
  z: number;
  r: number;
  hex?: string;
};

const _inverse = new Matrix4();
const _ray = new Ray();
const _pos = new Vector3();
const _world = new Vector3();

function pixelWidthNode(maxPx: number) {
  const instanceScale = attribute("instanceScale", "float");
  const uMax = uniform(maxPx);
  const uPR = uniform(Math.min(window.devicePixelRatio, 2));
  return Fn(() => {
    const instancePosition = attribute("instancePosition").xyz;
    const mv = modelViewMatrix.mul(vec4(instancePosition, 1.0));
    const dist = max(float(2), mv.z.negate());
    return clamp(instanceScale.mul(280).div(dist).mul(uPR), float(2), uMax).mul(
      0.5,
    );
  })();
}

function fogColorNode(fogColor: number) {
  const uFogNear = uniform(8000);
  const uFogFar = uniform(72000);
  const uFogColor = uniform(new Color(fogColor));
  return Fn(() => {
    const instanceColor = attribute("instanceColor");
    const instancePosition = attribute("instancePosition").xyz;
    const mv = modelViewMatrix.mul(vec4(instancePosition, 1.0));
    const depth = max(float(0), mv.z.negate());
    const fog = smoothstep(uFogNear, uFogFar, depth);
    return mix(instanceColor, uFogColor, fog);
  })();
}

class SoftDiscMaterial extends InstancedPointsNodeMaterial {
  constructor(maxPx: number, fogColor: number, additive: boolean) {
    super({
      vertexColors: true,
      transparent: true,
      depthWrite: !additive,
      blending: additive ? AdditiveBlending : NormalBlending,
    });
    this.useColor = true;
    this.alphaToCoverage = false;
    this.pointWidthNode = pixelWidthNode(maxPx);
    this.pointColorNode = fogColorNode(fogColor);
  }

  setup(builder: Parameters<NodeMaterial["setup"]>[0]) {
    const width = this.pointWidthNode ?? float(this.pointWidth);
    this.vertexNode = Fn(() => {
      const instancePosition = attribute("instancePosition").xyz;
      const mvPos = vec4(modelViewMatrix.mul(vec4(instancePosition, 1.0)));
      const aspect = viewport.z.div(viewport.w);
      const clipPos = cameraProjectionMatrix.mul(mvPos);
      const offset = positionGeometry.xy.toVar();
      offset.mulAssign(width);
      offset.assign(offset.div(viewport.z));
      offset.y.assign(offset.y.mul(aspect));
      offset.assign(offset.mul(clipPos.w));
      clipPos.addAssign(vec4(offset, 0, 0));
      return clipPos;
    })();
    const tint = this.pointColorNode;
    this.fragmentNode = Fn(() => {
      const d = length(uv().mul(2).sub(1));
      d.greaterThan(1.0).discard();
      const inner = mix(float(0.55), float(0.18), smoothstep(float(0), float(0.35), d));
      const alpha = mix(inner, float(0), smoothstep(float(0.35), float(1), d));
      return vec4(tint, alpha);
    })();
    NodeMaterial.prototype.setup.call(this, builder);
  }
}

function hardDiscMaterial(
  maxPx: number,
  additive: boolean,
  fogColor: number,
): InstancedPointsNodeMaterial {
  const mat = new InstancedPointsNodeMaterial({
    vertexColors: true,
    transparent: additive,
    depthWrite: !additive,
    blending: additive ? AdditiveBlending : NormalBlending,
  });
  mat.useColor = true;
  mat.alphaToCoverage = false;
  mat.pointWidthNode = pixelWidthNode(maxPx);
  mat.pointColorNode = fogColorNode(fogColor);
  return mat;
}

function attachPointRaycast(mesh: Mesh, threshold = 25) {
  mesh.raycast = (raycaster: Raycaster, intersects: Intersection[]) => {
    const pos = mesh.geometry.getAttribute("instancePosition");
    if (!pos) return;
    _inverse.copy(mesh.matrixWorld).invert();
    _ray.copy(raycaster.ray).applyMatrix4(_inverse);
    const limit = threshold * threshold;
    for (let i = 0; i < pos.count; i++) {
      _pos.fromBufferAttribute(pos, i);
      if (_ray.distanceSqToPoint(_pos) >= limit) continue;
      _world.copy(_pos).applyMatrix4(mesh.matrixWorld);
      intersects.push({
        distance: raycaster.ray.origin.distanceTo(_world),
        point: _world.clone(),
        object: mesh,
        index: i,
        instanceId: i,
      });
    }
  };
}

/** Camera-facing discs. WebGPU has no sized point primitives, so these are instanced quads. */
export function orbCloud(
  items: OrbItem[],
  color: Color,
  opts: {
    maxPx: number;
    additive?: boolean;
    fogColor?: number;
    soft?: boolean;
  },
): Mesh {
  const pos = new Float32Array(items.length * 3);
  const scale = new Float32Array(items.length);
  const cols = new Float32Array(items.length * 3);
  const tint = new Color();
  items.forEach((p, i) => {
    pos[i * 3] = p.x;
    pos[i * 3 + 1] = p.y;
    pos[i * 3 + 2] = p.z;
    scale[i] = p.r;
    if (p.hex) tint.set(p.hex);
    else tint.copy(color);
    cols[i * 3] = tint.r;
    cols[i * 3 + 1] = tint.g;
    cols[i * 3 + 2] = tint.b;
  });
  const geo = new InstancedPointsGeometry();
  geo.setPositions(pos);
  geo.setColors(cols);
  geo.setAttribute("instanceScale", new InstancedBufferAttribute(scale, 1));
  const fog = opts.fogColor ?? 0xeaeae8;
  const mat = opts.soft
    ? new SoftDiscMaterial(opts.maxPx, fog, Boolean(opts.additive))
    : hardDiscMaterial(opts.maxPx, Boolean(opts.additive), fog);
  const mesh = new InstancedPoints(geo, mat);
  mesh.frustumCulled = false;
  attachPointRaycast(mesh);
  return mesh;
}
