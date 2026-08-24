import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BOXEL_ORIGIN, snapDown } from "../boxel";
import type {
  CatalogCell,
  DensityOverview,
  SearchIndex,
  System,
  TileFile,
} from "../types";

export type StationRecord = {
  name: string;
  type?: string;
  distanceToArrival?: number;
};

export type BodyRecord = {
  name: string;
  type?: string;
};

export type ConvertOptions = {
  budget?: number;
  finest?: number;
  coarsest?: number;
  stations?: Record<string, StationRecord[]>;
  bodies?: Record<string, BodyRecord[]>;
};

export type ConvertedCatalog = {
  overview: DensityOverview;
  tiles: Record<string, TileFile>;
  search: SearchIndex;
  stations?: Record<string, StationRecord[]>;
  bodies?: Record<string, BodyRecord[]>;
};

type Box = {
  ox: number;
  oy: number;
  oz: number;
  size: number;
  systems: System[];
};

/** Lower face of the Forge cube of `size` that contains Elite-space `v`. */
function origin(v: number, axis: "x" | "y" | "z", size: number): number {
  return snapDown(v, BOXEL_ORIGIN[axis], size);
}

function boxKey(b: Box): string {
  return `${b.ox}_${b.oy}_${b.oz}_${b.size}`;
}

function split(box: Box): Box[] {
  const h = box.size / 2;
  const bins: System[][] = Array.from({ length: 8 }, () => []);
  for (const s of box.systems) {
    const ix = s.coords.x >= box.ox + h ? 1 : 0;
    const iy = s.coords.y >= box.oy + h ? 1 : 0;
    const iz = s.coords.z >= box.oz + h ? 1 : 0;
    bins[ix + iy * 2 + iz * 4]!.push(s);
  }
  const out: Box[] = [];
  for (let i = 0; i < 8; i++) {
    const systems = bins[i]!;
    if (!systems.length) continue;
    const ix = i & 1;
    const iy = (i >> 1) & 1;
    const iz = (i >> 2) & 1;
    out.push({
      ox: box.ox + ix * h,
      oy: box.oy + iy * h,
      oz: box.oz + iz * h,
      size: h,
      systems,
    });
  }
  return out;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function readCoords(row: Record<string, unknown>): System["coords"] | undefined {
  const nested = row.coords as Record<string, unknown> | undefined;
  const x = asNumber(nested?.x) ?? asNumber(row.x);
  const y = asNumber(nested?.y) ?? asNumber(row.y);
  const z = asNumber(nested?.z) ?? asNumber(row.z);
  if (x === undefined || y === undefined || z === undefined) return undefined;
  return { x, y, z };
}

export function parseDump(text: string): System[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let rows: unknown[] | undefined;
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    rows = Array.isArray(parsed) ? parsed : [];
  } else if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { systems?: unknown[] }).systems)
      ) {
        rows = (parsed as { systems: unknown[] }).systems;
      } else if (parsed && typeof parsed === "object") {
        rows = [parsed];
      } else rows = [];
    } catch {
      rows = undefined;
    }
  }
  if (!rows) {
    rows = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  }
  const systems: System[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const coords = readCoords(row);
    if (!coords) continue;
    const name = String(row.name ?? row.systemName ?? "").trim();
    if (!name) continue;
    const economy =
      (row.primary_economy as string | undefined) ??
      (row.primaryEconomy as string | undefined);
    systems.push({
      name,
      coords,
      id64: (row.id64 as string | number | undefined) ?? (row.id as string | number | undefined),
      population: asNumber(row.population),
      primary_economy: economy,
      allegiance: row.allegiance as string | undefined,
      government: row.government as string | undefined,
      cat: Array.isArray(row.cat) ? (row.cat as string[]) : undefined,
    });
  }
  return systems;
}

export function convertSystems(
  systems: System[],
  opts: ConvertOptions = {},
): ConvertedCatalog {
  const budget = opts.budget ?? 2000;
  const finest = opts.finest ?? 10;
  const coarsest = opts.coarsest ?? 1280;
  const grouped = new Map<string, Box>();
  for (const s of systems) {
    const box: Box = {
      ox: origin(s.coords.x, "x", coarsest),
      oy: origin(s.coords.y, "y", coarsest),
      oz: origin(s.coords.z, "z", coarsest),
      size: coarsest,
      systems: [],
    };
    const k = boxKey(box);
    const cur = grouped.get(k) ?? { ...box, systems: [] };
    cur.systems.push(s);
    grouped.set(k, cur);
  }
  const leaves: Box[] = [];
  const queue = [...grouped.values()];
  while (queue.length) {
    const box = queue.pop()!;
    if (box.systems.length > budget && box.size > finest) {
      queue.push(...split(box));
    } else {
      leaves.push(box);
    }
  }

  const tiles: Record<string, TileFile> = {};
  const search: SearchIndex = {};
  const cells: CatalogCell[] = [];
  for (const leaf of leaves) {
    const id = `x${leaf.ox}_y${leaf.oy}_z${leaf.oz}_s${leaf.size}`;
    const tile = `tiles/${id}.json`;
    const clean: System[] = leaf.systems.map((s) => ({
      name: s.name,
      coords: s.coords,
      id64: s.id64,
      population: s.population,
      primary_economy: s.primary_economy,
      allegiance: s.allegiance,
      government: s.government,
      cat: s.cat,
    }));
    tiles[tile] = { systems: clean };
    cells.push({
      id,
      cx: leaf.ox + leaf.size / 2,
      cy: leaf.oy + leaf.size / 2,
      cz: leaf.oz + leaf.size / 2,
      size: leaf.size,
      count: clean.length,
      tile,
    });
    for (const s of clean) {
      search[s.name] = { ...s.coords, tile: id };
    }
  }

  return {
    overview: { cells },
    tiles,
    search,
    stations: opts.stations,
    bodies: opts.bodies,
  };
}

export function writeCatalog(outDir: string, catalog: ConvertedCatalog): void {
  mkdirSync(join(outDir, "tiles"), { recursive: true });
  writeFileSync(
    join(outDir, "overview.json"),
    JSON.stringify(catalog.overview, null, 2),
  );
  writeFileSync(join(outDir, "search.json"), JSON.stringify(catalog.search, null, 2));
  for (const [rel, tile] of Object.entries(catalog.tiles)) {
    const path = join(outDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(tile));
  }
  if (catalog.stations) {
    writeFileSync(
      join(outDir, "stations.json"),
      JSON.stringify(catalog.stations, null, 2),
    );
  }
  if (catalog.bodies) {
    writeFileSync(
      join(outDir, "bodies.json"),
      JSON.stringify(catalog.bodies, null, 2),
    );
  }
}
