import { describe, it, expect, beforeEach } from "vitest";
import { ED3DM } from "../src/index";

const SOL_TILE = {
  systems: [
    {
      name: "Sol",
      coords: { x: 0, y: 0, z: 0 },
      id64: "0",
      population: 22780000000,
      primary_economy: "Refinery",
      allegiance: "Federation",
      government: "Democracy",
    },
  ],
};

const CORE_TILE = {
  systems: [
    {
      name: "Sagittarius A*",
      coords: { x: 25.21875, y: -20.90625, z: 25899.96875 },
    },
  ],
};

const OVERVIEW = {
  cells: [
    {
      id: "sol",
      cx: 0,
      cy: 0,
      cz: 0,
      size: 80,
      count: 1,
      tile: "tiles/sol.json",
    },
    {
      id: "core",
      cx: 25,
      cy: -21,
      cz: 25900,
      size: 1280,
      count: 1,
      tile: "tiles/core.json",
    },
  ],
};

const SEARCH = {
  Sol: { x: 0, y: 0, z: 0, tile: "sol" },
  "Sagittarius A*": { x: 25.21875, y: -20.90625, z: 25899.96875, tile: "core" },
};

function mockCatalog() {
  const fetched: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    if (url.endsWith("overview.json")) {
      return json(OVERVIEW);
    }
    if (url.endsWith("search.json")) {
      return json(SEARCH);
    }
    if (url.endsWith("tiles/sol.json")) {
      return json(SOL_TILE);
    }
    if (url.endsWith("tiles/core.json")) {
      return json(CORE_TILE);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return fetched;
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

describe("LOD and search", () => {
  let fetched: string[];

  beforeEach(() => {
    fetched = mockCatalog();
  });

  it("setLod('all') fetches every tile", async () => {
    const map = await ED3DM.create({
      container: document.body,
      catalog: { overviewUrl: "/catalog/overview.json" },
    });
    fetched.length = 0;
    await map.setLod("all");
    expect(fetched.sort()).toEqual([
      "tiles/core.json",
      "tiles/sol.json",
    ]);
  });

  it("numeric LOD without a focus fetches no tiles", async () => {
    const map = await ED3DM.create({
      container: document.body,
      catalog: { overviewUrl: "/catalog/overview.json" },
    });
    fetched.length = 0;
    await map.setLod(500);
    expect(fetched).toEqual([]);
  });

  it("flyTo loads the search index and that System's tile", async () => {
    const map = await ED3DM.create({
      container: document.body,
      catalog: {
        overviewUrl: "/catalog/overview.json",
        searchIndexUrl: "/catalog/search.json",
      },
    });
    fetched.length = 0;
    const sys = await map.flyTo("Sol");
    expect(sys?.name).toBe("Sol");
    expect(fetched).toEqual([
      "/catalog/search.json",
      "tiles/sol.json",
    ]);
  });

  it("focus at Sol with default LOD loads that cell's tile", async () => {
    const map = await ED3DM.create({
      container: document.body,
      catalog: { overviewUrl: "/catalog/overview.json" },
    });
    fetched.length = 0;
    await map.focus({ x: 0, y: 0, z: 0 });
    expect(fetched).toEqual(["tiles/sol.json"]);
  });

  it("focus at Sol with LOD 200 loads nearby tiles only", async () => {
    const map = await ED3DM.create({
      container: document.body,
      catalog: { overviewUrl: "/catalog/overview.json" },
      lod: 200,
    });
    fetched.length = 0;
    await map.focus({ x: 0, y: 0, z: 0 });
    expect(fetched).toEqual(["tiles/sol.json"]);
  });

  it("lowering LOD unloads tiles outside the ring", async () => {
    const map = await ED3DM.create({
      container: document.body,
      catalog: { overviewUrl: "/catalog/overview.json" },
    });
    await map.setLod("all");
    expect(map.loadedTiles().sort()).toEqual([
      "tiles/core.json",
      "tiles/sol.json",
    ]);
    await map.focus({ x: 0, y: 0, z: 0 });
    await map.setLod(0);
    expect(map.loadedTiles()).toEqual(["tiles/sol.json"]);
  });

  it("clearSelection drops the selected System", async () => {
    const map = await ED3DM.create({
      container: document.body,
      catalog: {
        overviewUrl: "/catalog/overview.json",
        searchIndexUrl: "/catalog/search.json",
      },
    });
    await map.flyTo("Sol");
    expect(map.selected()?.name).toBe("Sol");
    map.clearSelection();
    expect(map.selected()).toBeUndefined();
  });
});
