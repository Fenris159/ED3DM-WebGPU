export function lodScore(low: number, high: number): number {
  let value = (low ^ Math.imul(high, 0x9e3779b1)) >>> 0;
  value = (value ^ (value >>> 16)) >>> 0;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value = (value ^ (value >>> 15)) >>> 0;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value = (value ^ (value >>> 16)) >>> 0;
  return value / 0x1_0000_0000;
}

export function localEdgeScore(low: number, high: number): number {
  return lodScore(low ^ 0xa511_e9b3, high ^ 0x63d8_35a7);
}

export function localBoxelScore(low: number, high: number): number {
  return lodScore(low ^ 0xc2b2_ae35, high ^ 0x27d4_eb2f);
}

export function boundedLocalSamplePlan(
  boxelCount: number,
  maximumBoxels: number,
  systemThreshold: number,
): { boxelThreshold: number; systemThreshold: number } {
  const total = Math.max(0, Math.floor(boxelCount));
  const maximum = Math.max(1, Math.floor(maximumBoxels));
  const boxelThreshold = total <= maximum ? 1 : maximum / total;
  return {
    boxelThreshold,
    systemThreshold: Math.min(
      1,
      Math.max(0, systemThreshold) / boxelThreshold,
    ),
  };
}

export function localEdgeWeight(normalizedDistance: number): number {
  if (normalizedDistance <= 0.6) return 1;
  if (normalizedDistance >= 1) return 0;
  const value = (normalizedDistance - 0.6) / 0.4;
  const smooth = value * value * (3 - 2 * value);
  return 1 - smooth;
}

export function focusedResidencyRegion(
  target: { x: number; y: number; z: number },
  cameraDistanceLy: number,
): {
  center: { x: number; y: number; z: number };
  radiusLy: number;
  minimum: { x: number; y: number; z: number };
  maximum: { x: number; y: number; z: number };
  key: string;
} {
  const distance = Math.max(10, cameraDistanceLy);
  const size = Math.min(
    1_280,
    10 * 2 ** Math.max(0, Math.floor(Math.log2(distance / 10))),
  );
  const origin = { x: -49_985, y: -40_985, z: -24_105 };
  const cell = (coordinate: number, axisOrigin: number) =>
    axisOrigin + Math.floor((coordinate - axisOrigin) / size) * size;
  const ox = cell(target.x, origin.x);
  const oy = cell(target.y, origin.y);
  const oz = cell(target.z, origin.z);
  return {
    center: { x: ox + size / 2, y: oy + size / 2, z: oz + size / 2 },
    radiusLy: size / 2,
    minimum: { x: ox, y: oy, z: oz },
    maximum: { x: ox + size, y: oy + size, z: oz + size },
    key: `${size}:${ox}:${oy}:${oz}`,
  };
}
