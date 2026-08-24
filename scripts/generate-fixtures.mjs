import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../public/catalog");
mkdirSync(join(dir, "tiles"), { recursive: true });

const SGR = { x: 25.2, y: -20.9, z: 25900 };
const COLONIA = { x: -9530.5, y: -910.28, z: 19808.13 };
const RADIUS = 40000;
/** Stellar Forge lattice origin in Elite space (Sol is (0,0,0), not a cube corner). */
const BOXEL_ORIGIN = { x: -49985, y: -40985, z: -24105 };

function snapDown(coord, origin, size) {
  return origin + Math.floor((coord - origin) / size) * size;
}

function forgeCell(id, coords, size, count, tile) {
  const ox = snapDown(coords.x, BOXEL_ORIGIN.x, size);
  const oy = snapDown(coords.y, BOXEL_ORIGIN.y, size);
  const oz = snapDown(coords.z, BOXEL_ORIGIN.z, size);
  return {
    id,
    cx: ox + size / 2,
    cy: oy + size / 2,
    cz: oz + size / 2,
    size,
    count,
    tile,
  };
}

function hash01(i, seed) {
  const n = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

function discDensity(x, y, z) {
  const dx = x - SGR.x;
  const dy = y - SGR.y;
  const dz = z - SGR.z;
  const r = Math.sqrt(dx * dx + dz * dz);
  const h = Math.abs(dy);
  const disc = Math.exp(-r / 12500) * Math.exp(-h / 420);
  const theta = Math.atan2(dx, dz);
  const arms = 0.4 + 0.6 * Math.pow(Math.cos(2 * theta - r / 3400), 2);
  const solBump = Math.exp(-(x * x + y * y + z * z) / (900 * 900)) * 0.4;
  const coloniaBump =
    Math.exp(
      -((x - COLONIA.x) ** 2 + (z - COLONIA.z) ** 2) / (700 * 700),
    ) * 0.25;
  return disc * arms + solBump + coloniaBump;
}

const cells = [];
let n = 0;
const step = 1100;
for (let iz = -RADIUS; iz <= RADIUS; iz += step) {
  const row = Math.round((iz + RADIUS) / step);
  for (let ix = -RADIUS; ix <= RADIUS; ix += step) {
    const xj = SGR.x + ix + (row % 2) * (step * 0.5);
    const zj = SGR.z + iz;
    const radial = Math.hypot(xj - SGR.x, zj - SGR.z);
    if (radial > RADIUS) {
      n += 1;
      continue;
    }
    const y = (hash01(n, 3) - 0.5) * 260 * Math.exp(-radial / 15000);
    const d = discDensity(xj, y, zj);
    if (d < 0.032 && radial > 1800) {
      n += 1;
      continue;
    }
    const nearCore = radial < 6000;
    const size = nearCore ? 650 : radial < 14000 ? 950 : 1400;
    const count = Math.max(8, Math.min(90, Math.round(d * 220)));
    cells.push({
      id: `cell-${n}`,
      cx: xj + (hash01(n, 1) - 0.5) * size * 0.4,
      cy: y,
      cz: zj + (hash01(n, 2) - 0.5) * size * 0.4,
      size,
      count,
    });
    n += 1;
  }
}

cells.push(
  forgeCell("boxel-sol", { x: 0, y: 0, z: 0 }, 80, 28, "tiles/boxel-sol.json"),
);
cells.push(forgeCell("boxel-colonia", COLONIA, 160, 18, "tiles/boxel-colonia.json"));
cells.push(forgeCell("boxel-core", SGR, 640, 70, "tiles/boxel-core.json"));

function scatterSystems(origin, count, radius, named) {
  const systems = [];
  for (let i = 0; i < count; i++) {
    const name = named[i];
    const u = hash01(i, origin.x + 9);
    const v = hash01(i, origin.z + 4);
    const w = hash01(i, origin.y + 2);
    const r = name ? 0 : radius * Math.sqrt(u);
    const theta = v * Math.PI * 2;
    const phi = Math.acos(2 * w - 1);
    systems.push({
      name: name ?? `SYS ${origin.z | 0}-${i}`,
      coords: {
        x: origin.x + r * Math.sin(phi) * Math.cos(theta),
        y: origin.y + r * Math.cos(phi) * 0.35,
        z: origin.z + r * Math.sin(phi) * Math.sin(theta),
      },
      population: name === "Sol" ? 22780959567 : name === "Colonia" ? 560000 : 0,
      primary_economy:
        name === "Sol" ? "Refinery" : name === "Colonia" ? "Colony" : "None",
      allegiance:
        name === "Sol"
          ? "Federation"
          : name === "Colonia"
            ? "Independent"
            : "None",
      government:
        name === "Sol"
          ? "Democracy"
          : name === "Colonia"
            ? "Cooperative"
            : "None",
      cat: name === "Sol" ? ["home"] : name === "Colonia" ? ["colonia"] : undefined,
    });
  }
  return { systems };
}

writeFileSync(join(dir, "overview.json"), JSON.stringify({ cells }));
writeFileSync(
  join(dir, "tiles/boxel-sol.json"),
  JSON.stringify(
    scatterSystems({ x: 0, y: 0, z: 0 }, 24, 55, [
      "Sol",
      "Alpha Centauri",
      "Barnard's Star",
    ]),
  ),
);
writeFileSync(
  join(dir, "tiles/boxel-colonia.json"),
  JSON.stringify(scatterSystems(COLONIA, 16, 80, ["Colonia"])),
);
writeFileSync(
  join(dir, "tiles/boxel-core.json"),
  JSON.stringify(scatterSystems(SGR, 48, 220, ["Sagittarius A*"])),
);
writeFileSync(
  join(dir, "search.json"),
  JSON.stringify({
    Sol: { x: 0, y: 0, z: 0, tile: "boxel-sol" },
    Colonia: { ...COLONIA, tile: "boxel-colonia" },
    "Sagittarius A*": { ...SGR, tile: "boxel-core" },
  }),
);
writeFileSync(join(dir, "routes.json"), JSON.stringify({ routes: [] }));
console.log(`cells ${cells.length}`);
