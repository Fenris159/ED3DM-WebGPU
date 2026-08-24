import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, "RegionMapData.json"), "utf8"));
const names = raw.regions;
const rows = raw.regionmap;
const width = 2048;
const height = rows.length;
const X0 = -49985;
const Z0 = -24105;
const SCALE = 4096 / 83;
const STEP = 2;

function expandRow(rle) {
  const row = new Uint8Array(width);
  let x = 0;
  for (const [len, id] of rle) {
    const end = Math.min(width, x + len);
    if (id) row.fill(id, x, end);
    x = end;
    if (x >= width) break;
  }
  return row;
}

const decoded = rows.map(expandRow);
const sums = Array.from({ length: 43 }, () => ({ x: 0, z: 0, n: 0 }));

for (let pz = 0; pz < height; pz += 1) {
  const row = decoded[pz];
  for (let px = 0; px < width; px += 1) {
    const id = row[px];
    if (!id) continue;
    sums[id].x += px;
    sums[id].z += pz;
    sums[id].n += 1;
  }
}

function sample(px, pz) {
  if (px < 0 || pz < 0 || px >= width || pz >= height) return 0;
  return decoded[pz][px];
}

function snapNearest(coord, origin, size) {
  return origin + Math.round((coord - origin) / size) * size;
}

function toX(px) {
  return snapNearest(Math.round(X0 + px * SCALE), X0, 10);
}
function toZ(pz) {
  return snapNearest(Math.round(Z0 + pz * SCALE), Z0, 10);
}

function pushSeg(x1, z1, x2, z2) {
  if (x1 === x2 && z1 === z2) return;
  segs.push(x1, z1, x2, z2);
}

const segs = [];

for (let pz = 0; pz <= height; pz += STEP) {
  let run = null;
  for (let px = 0; px <= width; px += STEP) {
    const a = sample(px, pz - STEP);
    const b = sample(px, pz);
    const edge = a !== b && (a !== 0 || b !== 0);
    if (edge) {
      if (!run) run = { x0: px, z: pz };
      run.x1 = px + STEP;
    } else if (run) {
      pushSeg(toX(run.x0), toZ(run.z), toX(run.x1), toZ(run.z));
      run = null;
    }
  }
  if (run) pushSeg(toX(run.x0), toZ(run.z), toX(run.x1), toZ(run.z));
}

for (let px = 0; px <= width; px += STEP) {
  let run = null;
  for (let pz = 0; pz <= height; pz += STEP) {
    const a = sample(px - STEP, pz);
    const b = sample(px, pz);
    const edge = a !== b && (a !== 0 || b !== 0);
    if (edge) {
      if (!run) run = { z0: pz, x: px };
      run.z1 = pz + STEP;
    } else if (run) {
      pushSeg(toX(run.x), toZ(run.z0), toX(run.x), toZ(run.z1));
      run = null;
    }
  }
  if (run) pushSeg(toX(run.x), toZ(run.z0), toX(run.x), toZ(run.z1));
}

const regions = [];
for (let id = 1; id <= 42; id += 1) {
  const s = sums[id];
  if (!s.n) throw new Error(`region ${id} has no pixels`);
  regions.push({
    name: names[id],
    coords: {
      x: Math.round(X0 + (s.x / s.n + 0.5) * SCALE),
      y: 80,
      z: Math.round(Z0 + (s.z / s.n + 0.5) * SCALE),
    },
  });
}

const payload = { regions, xz: segs };
const out = JSON.stringify(payload);
writeFileSync(join(here, "..", "src", "region-grid-data.json"), out);
console.log(
  JSON.stringify(
    {
      rows: height,
      segments: segs.length / 4,
      bytes: out.length,
      sample: regions.slice(0, 3),
      innerOrion: regions.find((r) => r.name === "Inner Orion Spur"),
      centre: regions.find((r) => r.name === "Galactic Centre"),
      scutum: regions.find((r) => r.name === "Inner Scutum-Centaurus Arm"),
    },
    null,
    2,
  ),
);
