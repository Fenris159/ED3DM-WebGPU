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
  visibility?: number;
  opacityNoise?: number;
  detail?: boolean;
};

export const GALAXY_DENSITY_REFERENCE_SYSTEMS = 400_000_000_000;

const _inverse = new Matrix4();
const _ray = new Ray();
const _pos = new Vector3();
const _world = new Vector3();
const ORB_DISTANCE_SCALE = 100;
const ORB_LOCAL_MIN_DIAMETER_PX = 0.15;
const ORB_GALAXY_MIN_DIAMETER_PX = 3;

function smoothstepNumber(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function representedSystemsPerOverviewPoint(
  overviewPointCount: number,
): number {
  if (!Number.isFinite(overviewPointCount) || overviewPointCount <= 0) return 0;
  return Math.round(GALAXY_DENSITY_REFERENCE_SYSTEMS / overviewPointCount);
}

export function densityFieldOpacity(viewDistance: number): number {
  return smoothstepNumber(180, 8_000, Math.max(0, viewDistance));
}

export function minimumOrbDiameter(
  viewDistance: number,
  visibility = 0.75,
): number {
  const overview = smoothstepNumber(10_000, 100_000, viewDistance);
  const base =
    ORB_LOCAL_MIN_DIAMETER_PX +
    (ORB_GALAXY_MIN_DIAMETER_PX - ORB_LOCAL_MIN_DIAMETER_PX) * overview;
  const galaxyVariation = galaxyOrbVisibilityScale(visibility);
  const antiPopFloor =
    ORB_LOCAL_MIN_DIAMETER_PX + (1 - ORB_LOCAL_MIN_DIAMETER_PX) * overview;
  return Math.max(
    antiPopFloor,
    base * (1 + (galaxyVariation - 1) * overview),
  );
}

export function galaxyOrbVisibilityScale(visibility: number): number {
  return (
    0.08 +
    1.02 * smoothstepNumber(0.55, 1, Math.min(1, Math.max(0, visibility)))
  );
}

export function orbPickRadiusWorld(
  cameraDistance: number,
  verticalFovDegrees: number,
  viewportHeight: number,
  radiusPx = 5,
): number {
  const distance = Math.max(0.1, cameraDistance);
  const height = Math.max(1, viewportHeight);
  const fovRadians = (Math.max(1, verticalFovDegrees) * Math.PI) / 180;
  const worldPerPixel =
    (2 * distance * Math.tan(fovRadians * 0.5)) / height;
  return Math.max(0.05, worldPerPixel * Math.max(1, radiusPx));
}

export function stableOrbNoise(key: string, salt = 0): number {
  let hash = (0x811c9dc5 ^ salt) >>> 0;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0x1_0000_0000;
}

export function stableOrbVisibility(key: string): number {
  return stableOrbNoise(key, 0x51f15e);
}

export function farFieldOrbOpacity(
  opacityNoise: number,
  viewDistance: number,
): number {
  const overview = smoothstepNumber(10_000, 100_000, viewDistance);
  const galaxyOpacity =
    0.08 +
    0.92 *
      smoothstepNumber(0.15, 1, Math.min(1, Math.max(0, opacityNoise)));
  return 1 + (galaxyOpacity - 1) * overview;
}

export function layeredOrbOpacity(
  opacityNoise: number,
  viewDistance: number,
  detail: boolean,
): number {
  if (detail) return 1;
  const localPresence =
    0.015 + 0.985 * smoothstepNumber(180, 8_000, viewDistance);
  return localPresence * farFieldOrbOpacity(opacityNoise, viewDistance);
}

export function projectedOrbDiameter(
  scale: number,
  distance: number,
  pixelRatio = 1,
  viewDistance = distance,
  maxPx = 12,
  visibility = 0.75,
): number {
  const projected =
    (Math.max(0, scale) * ORB_DISTANCE_SCALE * Math.max(0.1, pixelRatio)) /
    Math.max(2, distance);
  return Math.min(
    maxPx,
    Math.max(minimumOrbDiameter(viewDistance, visibility), projected),
  );
}

function pixelWidthNode(
  maxPx: number,
  uViewDistance: ReturnType<typeof uniform>,
) {
  const instanceScale = attribute("instanceScale", "float");
  const uMax = uniform(maxPx);
  const uPR = uniform(Math.min(window.devicePixelRatio, 2));
  return Fn(() => {
    const instancePosition = attribute("instancePosition").xyz;
    const instanceVisibility = attribute("instanceVisibility", "float");
    const mv = modelViewMatrix.mul(vec4(instancePosition, 1.0));
    const dist = max(float(2), mv.z.negate());
    const overview = smoothstep(float(10_000), float(100_000), uViewDistance);
    const minPx = mix(
      float(ORB_LOCAL_MIN_DIAMETER_PX),
      float(ORB_GALAXY_MIN_DIAMETER_PX),
      overview,
    );
    const galaxyVariation = mix(
      float(0.08),
      float(1.1),
      smoothstep(float(0.55), float(1), instanceVisibility),
    );
    const presentationScale = mix(float(1), galaxyVariation, overview);
    const antiPopFloor = mix(
      float(ORB_LOCAL_MIN_DIAMETER_PX),
      float(1),
      overview,
    );
    return clamp(
      instanceScale.mul(ORB_DISTANCE_SCALE).div(dist).mul(uPR),
      max(antiPopFloor, minPx.mul(presentationScale)),
      uMax,
    ).mul(0.5);
  })();
}

function farFieldOpacityNode(uViewDistance: ReturnType<typeof uniform>) {
  const overview = smoothstep(float(10_000), float(100_000), uViewDistance);
  const galaxyOpacity = mix(
    float(0.08),
    float(1),
    smoothstep(
      float(0.15),
      float(1),
      attribute("instanceOpacityNoise", "float"),
    ),
  );
  const presentationOpacity = mix(float(1), galaxyOpacity, overview);
  const localPresence = mix(
    float(0.015),
    float(1),
    smoothstep(float(180), float(8_000), uViewDistance),
  );
  return mix(
    localPresence.mul(presentationOpacity),
    float(1),
    attribute("instanceDetail", "float"),
  );
}

function densityFieldWidthNode(uViewDistance: ReturnType<typeof uniform>) {
  const presence = smoothstep(float(180), float(8_000), uViewDistance);
  const galaxyScale = smoothstep(float(8_000), float(100_000), uViewDistance);
  const width = mix(
    float(4),
    float(14),
    attribute("instanceVisibility", "float"),
  ).mul(mix(float(0.65), float(1), galaxyScale));
  return width.mul(presence).mul(0.5);
}

function densityFieldOpacityNode(uViewDistance: ReturnType<typeof uniform>) {
  const presence = smoothstep(float(180), float(8_000), uViewDistance);
  const galaxyScale = smoothstep(float(8_000), float(100_000), uViewDistance);
  const variation = mix(
    float(0.45),
    float(1),
    attribute("instanceOpacityNoise", "float"),
  );
  return presence.mul(mix(float(0.035), float(0.11), galaxyScale)).mul(variation);
}

class SoftDiscMaterial extends InstancedPointsNodeMaterial {
  constructor(
    maxPx: number,
    additive: boolean,
    viewDistance: ReturnType<typeof uniform>,
    density: boolean,
  ) {
    super({
      vertexColors: true,
      transparent: true,
      depthWrite: !additive,
      blending: additive ? AdditiveBlending : NormalBlending,
    });
    this.useColor = true;
    this.alphaToCoverage = false;
    this.pointWidthNode = density
      ? densityFieldWidthNode(viewDistance)
      : pixelWidthNode(maxPx, viewDistance);
    this.opacityNode = density
      ? densityFieldOpacityNode(viewDistance)
      : farFieldOpacityNode(viewDistance);
    this.pointColorNode = attribute("instanceColor").mul(
      mix(
        float(0.9),
        float(1.65),
        smoothstep(
          float(0.55),
          float(1),
          attribute("instanceVisibility", "float"),
        ),
      ),
    );
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
  viewDistance: ReturnType<typeof uniform>,
): InstancedPointsNodeMaterial {
  const mat = new InstancedPointsNodeMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: additive ? AdditiveBlending : NormalBlending,
  });
  mat.useColor = true;
  mat.alphaToCoverage = false;
  mat.pointWidthNode = pixelWidthNode(maxPx, viewDistance);
  mat.opacityNode = farFieldOpacityNode(viewDistance);
  mat.pointColorNode = attribute("instanceColor").mul(
    mix(
      float(0.9),
      float(1.65),
      smoothstep(
        float(0.55),
        float(1),
        attribute("instanceVisibility", "float"),
      ),
    ),
  );
  return mat;
}

function attachPointRaycast(mesh: Mesh) {
  mesh.raycast = (raycaster: Raycaster, intersects: Intersection[]) => {
    const pos = mesh.geometry.getAttribute("instancePosition");
    if (!pos) return;
    const details = mesh.userData.orbDetails as Float32Array | undefined;
    const opacityNoise = mesh.userData.orbOpacityNoise as Float32Array | undefined;
    const viewDistance = Number(mesh.userData.orbViewDistance?.value) || 30_000;
    _inverse.copy(mesh.matrixWorld).invert();
    _ray.copy(raycaster.ray).applyMatrix4(_inverse);
    for (let i = 0; i < pos.count; i++) {
      if (
        layeredOrbOpacity(
          opacityNoise?.[i] ?? 1,
          viewDistance,
          Boolean(details?.[i]),
        ) < 0.04
      ) continue;
      _pos.fromBufferAttribute(pos, i);
      _world.copy(_pos).applyMatrix4(mesh.matrixWorld);
      const camera = raycaster.camera;
      const threshold =
        camera && "isPerspectiveCamera" in camera && camera.isPerspectiveCamera
          ? orbPickRadiusWorld(
              raycaster.ray.origin.distanceTo(_world),
              (camera as unknown as { fov: number }).fov,
              Number(mesh.userData.orbViewportHeight) || window.innerHeight,
            )
          : 0.5;
      if (_ray.distanceSqToPoint(_pos) >= threshold * threshold) continue;
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
    soft?: boolean;
    density?: boolean;
    pickable?: boolean;
  },
): Mesh {
  const pos = new Float32Array(items.length * 3);
  const scale = new Float32Array(items.length);
  const visibility = new Float32Array(items.length);
  const opacityNoise = new Float32Array(items.length);
  const detail = new Float32Array(items.length);
  const cols = new Float32Array(items.length * 3);
  const tint = new Color();
  items.forEach((p, i) => {
    pos[i * 3] = p.x;
    pos[i * 3 + 1] = p.y;
    pos[i * 3 + 2] = p.z;
    scale[i] = p.r;
    visibility[i] = p.visibility ?? 1;
    opacityNoise[i] = p.opacityNoise ?? 1;
    detail[i] = p.detail ? 1 : 0;
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
  geo.setAttribute(
    "instanceVisibility",
    new InstancedBufferAttribute(visibility, 1),
  );
  geo.setAttribute(
    "instanceOpacityNoise",
    new InstancedBufferAttribute(opacityNoise, 1),
  );
  geo.setAttribute("instanceDetail", new InstancedBufferAttribute(detail, 1));
  const viewDistance = uniform(30_000);
  const mat = opts.soft
    ? new SoftDiscMaterial(
        opts.maxPx,
        Boolean(opts.additive),
        viewDistance,
        Boolean(opts.density),
      )
    : hardDiscMaterial(opts.maxPx, Boolean(opts.additive), viewDistance);
  const mesh = new InstancedPoints(geo, mat);
  mesh.userData.orbViewDistance = viewDistance;
  mesh.userData.orbDetails = detail;
  mesh.userData.orbOpacityNoise = opacityNoise;
  mesh.userData.orbViewportHeight = window.innerHeight;
  mesh.frustumCulled = false;
  if (opts.pickable !== false) attachPointRaycast(mesh);
  return mesh;
}
