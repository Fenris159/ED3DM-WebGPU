import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  convertSystems,
  parseDump,
  writeCatalog,
} from "../src/converter/convert";
import type { System } from "../src/types";

function sys(
  name: string,
  x: number,
  y: number,
  z: number,
  extra: Partial<System> = {},
): System {
  return { name, coords: { x, y, z }, ...extra };
}

describe("Converter", () => {
  it("parses an EDSM-style JSON array and skips rows without coords", () => {
    const systems = parseDump(
      JSON.stringify([
        { name: "Sol", coords: { x: 0, y: 0, z: 0 }, id64: 10477373803 },
        { name: "NoPos" },
        {
          name: "Colonia",
          x: -9530.5,
          y: -910.28,
          z: 19808.13,
          primaryEconomy: "Colony",
        },
      ]),
    );
    expect(systems.map((s) => s.name)).toEqual(["Sol", "Colonia"]);
    expect(systems[1]?.primary_economy).toBe("Colony");
  });

  it("parses NDJSON dumps", () => {
    const systems = parseDump(
      '{"name":"A","coords":{"x":1,"y":2,"z":3}}\n{"name":"B","coords":{"x":4,"y":5,"z":6}}\n',
    );
    expect(systems).toHaveLength(2);
    expect(systems[0]?.coords).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("splits dense core cells smaller than rim cells and writes one file per tile", () => {
    const systems: System[] = [];
    for (let i = 0; i < 12; i++) {
      systems.push(sys(`Core ${i}`, i * 2, 0, i * 2));
    }
    systems.push(sys("Rim A", 18000, 0, 0));
    systems.push(sys("Rim B", 18100, 10, 40));

    const catalog = convertSystems(systems, { budget: 4, finest: 10, coarsest: 1280 });

    expect(catalog.overview.cells.length).toBeGreaterThanOrEqual(2);
    const tilePaths = Object.keys(catalog.tiles);
    expect(tilePaths.length).toBe(catalog.overview.cells.length);
    expect(tilePaths.every((p) => p.startsWith("tiles/") && p.endsWith(".json"))).toBe(
      true,
    );

    const coreCells = catalog.overview.cells.filter(
      (c) => Math.hypot(c.cx, c.cz) < 500,
    );
    const rimCells = catalog.overview.cells.filter((c) => Math.hypot(c.cx, c.cz) > 10000);
    const minCore = Math.min(...coreCells.map((c) => c.size));
    const maxRim = Math.max(...rimCells.map((c) => c.size));
    expect(minCore).toBeLessThanOrEqual(maxRim);

    expect(catalog.search["Sol"]).toBeUndefined();
    expect(catalog.search["Rim A"]?.tile).toBeTruthy();
    expect(Object.keys(catalog.search)).toHaveLength(14);
  });

  it("keeps Station/Body lists in sidecars, not on tile Systems", () => {
    const systems = [
      sys("Sol", 0, 0, 0, {
        id64: "1",
        population: 10,
        primary_economy: "Refinery",
      }),
    ];
    const catalog = convertSystems(systems, {
      budget: 10,
      stations: {
        Sol: [{ name: "Abraham Lincoln", type: "Orbis", distanceToArrival: 500 }],
      },
      bodies: { Sol: [{ name: "Earth", type: "Earth-like world" }] },
    });
    const tile = Object.values(catalog.tiles)[0];
    expect(tile?.systems[0]).not.toHaveProperty("stations");
    expect(tile?.systems[0]).not.toHaveProperty("bodies");
    expect(catalog.stations?.Sol[0]?.name).toBe("Abraham Lincoln");
    expect(catalog.bodies?.Sol[0]?.name).toBe("Earth");
  });

  it("bins tiles onto Stellar Forge boxels, not cubes that treat Sol as a corner", () => {
    const catalog = convertSystems([sys("Sol", 0, 0, 0), sys("Near", 1, 1, 1)], {
      budget: 10,
      finest: 10,
      coarsest: 80,
    });
    expect(catalog.overview.cells).toHaveLength(1);
    const cell = catalog.overview.cells[0]!;
    expect(cell.size).toBe(80);
    expect(cell.cx).toBe(-65 + 40);
    expect(cell.cy).toBe(-25 + 40);
    expect(cell.cz).toBe(-25 + 40);
    expect(catalog.tiles[cell.tile!]?.systems[0]?.coords).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("writes the Catalog layout the Map app already loads", () => {
    const dir = mkdtempSync(join(tmpdir(), "ed3dm-cat-"));
    const catalog = convertSystems(
      [sys("Sol", 0, 0, 0), sys("Far", 20000, 0, 0)],
      { budget: 8 },
    );
    writeCatalog(dir, catalog);
    expect(existsSync(join(dir, "overview.json"))).toBe(true);
    expect(existsSync(join(dir, "search.json"))).toBe(true);
    const overview = JSON.parse(readFileSync(join(dir, "overview.json"), "utf8"));
    for (const cell of overview.cells) {
      expect(existsSync(join(dir, cell.tile))).toBe(true);
    }
  });
});
