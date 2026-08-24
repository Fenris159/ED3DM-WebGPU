/**
 * Simplex stroke font (A–Z, space, apostrophe, hyphen).
 * Glyphs live in a 0–7 × 0–10 box; y=10 is the top of the letter.
 */
type Poly = readonly number[];

const G: Record<string, readonly Poly[]> = {
  " ": [],
  "'": [[2.2, 10, 2.2, 7.6, 1.4, 6.8]],
  "-": [[1.2, 5, 5.8, 5]],
  A: [
    [0.2, 0, 3.5, 10, 6.8, 0],
    [1.6, 3.6, 5.4, 3.6],
  ],
  B: [
    [0.4, 0, 0.4, 10, 4.6, 10, 6.4, 8.8, 6.4, 6.6, 4.6, 5.2, 0.4, 5.2],
    [4.6, 5.2, 6.6, 3.8, 6.6, 1.4, 4.8, 0, 0.4, 0],
  ],
  C: [[6.4, 8.4, 5.2, 10, 2, 10, 0.4, 8, 0.4, 2, 2, 0, 5.2, 0, 6.4, 1.6]],
  D: [[0.4, 0, 0.4, 10, 4.4, 10, 6.6, 7.8, 6.6, 2.2, 4.4, 0, 0.4, 0]],
  E: [
    [6.4, 10, 0.4, 10, 0.4, 0, 6.4, 0],
    [0.4, 5.2, 5.2, 5.2],
  ],
  F: [
    [0.4, 0, 0.4, 10, 6.4, 10],
    [0.4, 5.2, 5.2, 5.2],
  ],
  G: [
    [6.2, 8.4, 5, 10, 2, 10, 0.4, 8, 0.4, 2, 2, 0, 5.2, 0, 6.6, 1.8, 6.6, 5, 3.6, 5],
  ],
  H: [
    [0.4, 0, 0.4, 10],
    [6.6, 0, 6.6, 10],
    [0.4, 5.2, 6.6, 5.2],
  ],
  I: [
    [1.6, 10, 5.4, 10],
    [3.5, 10, 3.5, 0],
    [1.6, 0, 5.4, 0],
  ],
  J: [
    [2.4, 10, 6.2, 10],
    [5.2, 10, 5.2, 2.2, 4, 0, 1.6, 0, 0.4, 1.6],
  ],
  K: [
    [0.4, 0, 0.4, 10],
    [6.6, 10, 0.4, 5.2, 6.6, 0],
  ],
  L: [[0.4, 10, 0.4, 0, 6.2, 0]],
  M: [[0.2, 0, 0.2, 10, 3.5, 4.2, 6.8, 10, 6.8, 0]],
  N: [[0.4, 0, 0.4, 10, 6.6, 0, 6.6, 10]],
  O: [[2, 10, 5, 10, 6.6, 8, 6.6, 2, 5, 0, 2, 0, 0.4, 2, 0.4, 8, 2, 10]],
  P: [[0.4, 0, 0.4, 10, 4.8, 10, 6.6, 8.4, 6.6, 6.4, 4.8, 5, 0.4, 5]],
  Q: [
    [2, 10, 5, 10, 6.6, 8, 6.6, 2.4, 5, 0.4, 2, 0.4, 0.4, 2.4, 0.4, 8, 2, 10],
    [4.2, 2.4, 6.8, 0],
  ],
  R: [
    [0.4, 0, 0.4, 10, 4.8, 10, 6.6, 8.4, 6.6, 6.4, 4.8, 5, 0.4, 5],
    [3.6, 5, 6.6, 0],
  ],
  S: [[6.2, 8.6, 5, 10, 2, 10, 0.6, 8.6, 0.6, 6.8, 6.4, 3.2, 6.4, 1.4, 5, 0, 2, 0, 0.6, 1.4]],
  T: [
    [0.2, 10, 6.8, 10],
    [3.5, 10, 3.5, 0],
  ],
  U: [[0.4, 10, 0.4, 2.2, 2, 0, 5, 0, 6.6, 2.2, 6.6, 10]],
  V: [[0.2, 10, 3.5, 0, 6.8, 10]],
  W: [[0.2, 10, 1.8, 0, 3.5, 6, 5.2, 0, 6.8, 10]],
  X: [
    [0.4, 10, 6.6, 0],
    [6.6, 10, 0.4, 0],
  ],
  Y: [
    [0.2, 10, 3.5, 5.2, 6.8, 10],
    [3.5, 5.2, 3.5, 0],
  ],
  Z: [[0.4, 10, 6.6, 10, 0.4, 0, 6.6, 0]],
};

const UNIT_W = 7.4;
const UNIT_H = 10;
/** World width of one glyph as a fraction of letter height. */
export const LETTER_ADVANCE = UNIT_W / UNIT_H;

function segsFromPoly(poly: Poly, ox: number, oz: number, sx: number, sz: number, out: number[]) {
  for (let i = 0; i + 3 < poly.length; i += 2) {
    out.push(
      ox + poly[i]! * sx,
      oz + (UNIT_H - poly[i + 1]!) * sz,
      ox + poly[i + 2]! * sx,
      oz + (UNIT_H - poly[i + 3]!) * sz,
    );
  }
}

/**
 * Elite-space XZ line pairs for `text`, centered on (cx, cz).
 * `(upX, upZ)` is the direction the top of the letters should face.
 */
export function strokeTextXZ(
  text: string,
  cx: number,
  cz: number,
  letterHeight: number,
  upX = 0,
  upZ = -1,
): number[] {
  const chars = [...text.toUpperCase()];
  const sx = letterHeight / UNIT_H;
  const sz = letterHeight / UNIT_H;
  const advance = UNIT_W * sx;
  const width = chars.length * advance;
  let x = cx - width / 2;
  const z = cz - letterHeight / 2;
  const out: number[] = [];
  for (const ch of chars) {
    const glyph = G[ch] ?? G["-"]!;
    for (const poly of glyph) segsFromPoly(poly, x, z, sx, sz, out);
    x += advance;
  }
  const ul = Math.hypot(upX, upZ) || 1;
  const nx = upX / ul;
  const nz = upZ / ul;
  const theta = Math.atan2(nx, -nz);
  if (theta === 0) return out;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  for (let i = 0; i < out.length; i += 2) {
    const lx = out[i]! - cx;
    const lz = out[i + 1]! - cz;
    out[i] = cx + lx * c - lz * s;
    out[i + 1] = cz + lx * s + lz * c;
  }
  return out;
}

/** Duplicate each stroke with a pair of parallel offsets — medium weight, not bold. */
export function thickenStrokeXZ(xz: number[], offset: number): number[] {
  if (offset <= 0) return xz;
  const out: number[] = [];
  for (let i = 0; i + 3 < xz.length; i += 4) {
    const x1 = xz[i]!;
    const z1 = xz[i + 1]!;
    const x2 = xz[i + 2]!;
    const z2 = xz[i + 3]!;
    out.push(x1, z1, x2, z2);
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz) || 1;
    const px = (-dz / len) * offset;
    const pz = (dx / len) * offset;
    out.push(x1 + px, z1 + pz, x2 + px, z2 + pz);
    out.push(x1 - px, z1 - pz, x2 - px, z2 - pz);
  }
  return out;
}
