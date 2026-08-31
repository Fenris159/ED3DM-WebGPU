import { describe, it, expect, beforeEach } from "vitest";
import { ED3DM } from "../src/index";
import { colorFor } from "../src/palettes";

const OVERVIEW = {
  cells: [
    {
      id: "sol",
      cx: 0,
      cy: 0,
      cz: 0,
      size: 80,
      count: 4,
      tile: "tiles/sol.json",
    },
  ],
};

const TILE = {
  systems: [
    {
      name: "Sol",
      coords: { x: 0, y: 0, z: 0 },
      primary_economy: "Refinery",
      allegiance: "Federation",
      government: "Democracy",
      cat: ["home"],
      stellarColor: "#fff1a8",
      stellarType: "G",
    },
    {
      name: "Hutton",
      coords: { x: 1, y: 0, z: 0 },
      primary_economy: "Extraction",
      allegiance: "Independent",
      government: "Anarchy",
      cat: ["poi"],
    },
    {
      name: "Nomad",
      coords: { x: 2, y: 0, z: 0 },
      cat: ["extra"],
      stellarType: "RoguePlanet",
    },
    {
      name: "Veil",
      coords: { x: 3, y: 0, z: 0 },
      cat: ["extra"],
      stellarType: "Nebula",
    },
  ],
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

describe("color-by and Category filters", () => {
  beforeEach(() => {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("overview.json")) return json(OVERVIEW);
      if (url.endsWith("tiles/sol.json")) return json(TILE);
      throw new Error(`unexpected fetch: ${url}`);
    };
  });

  it("paints Refinery with the reference economy palette slot", () => {
    expect(colorFor({ primary_economy: "Refinery" }, "economy")).toBe("#ff7f00");
    expect(colorFor({ allegiance: "Federation" }, "allegiance")).toBe("#fe0000");
    expect(colorFor({ government: "Democracy" }, "government")).toBe("#7fff00");
    expect(colorFor({ primary_economy: "Refinery" }, "none")).toBe("#2e2e2c");
  });

  it("setFilter hides Systems whose Category is off", async () => {
    const map = await ED3DM.create({
      container: document.body,
      catalog: { overviewUrl: "/catalog/overview.json" },
    });
    await map.focus({ x: 0, y: 0, z: 0 });
    expect(map.visibleSystems().map((s) => s.name).sort()).toEqual(["Hutton", "Sol"]);
    map.setFilter({ categories: ["home"] });
    expect(map.visibleSystems().map((s) => s.name)).toEqual(["Sol"]);
    map.setFilter({});
    expect(map.visibleSystems().map((s) => s.name).sort()).toEqual(["Hutton", "Sol"]);
  });

  it("can exclude rogue planets from All and opt them in alone or with stars", async () => {
    const map = await ED3DM.create({
      container: document.body,
      catalog: { overviewUrl: "/catalog/overview.json" },
    });
    await map.focus({ x: 0, y: 0, z: 0 });
    map.setFilter({ excludedStellarTypes: ["RoguePlanet"] });
    expect(map.visibleSystems().map((s) => s.name).sort()).toEqual([
      "Hutton",
      "Sol",
    ]);
    map.setFilter({ stellarTypes: ["RoguePlanet"] });
    expect(map.visibleSystems().map((s) => s.name)).toEqual(["Nomad"]);
    map.setFilter({ stellarTypes: ["G", "RoguePlanet"] });
    expect(map.visibleSystems().map((s) => s.name).sort()).toEqual([
      "Nomad",
      "Sol",
    ]);
  });

  it("retains nebula metadata without admitting nebulae to the star renderer", async () => {
    const map = await ED3DM.create({
      container: document.body,
      catalog: { overviewUrl: "/catalog/overview.json" },
    });
    await map.focus({ x: 0, y: 0, z: 0 });
    map.setFilter({ stellarTypes: ["Nebula"] });
    expect(map.visibleSystems()).toEqual([]);
  });

  it("setColorBy changes orbColor independently of the Category filter", async () => {
    const map = await ED3DM.create({
      container: document.body,
      catalog: { overviewUrl: "/catalog/overview.json" },
    });
    await map.focus({ x: 0, y: 0, z: 0 });
    map.setFilter({ categories: ["home"] });
    map.setColorBy("economy");
    expect(map.orbColor("Sol")).toBe("#ff7f00");
    expect(map.visibleSystems().map((s) => s.name)).toEqual(["Sol"]);
  });

  it("setTheme accepts paper, charcoal, and realistic", async () => {
    const map = await ED3DM.create({
      container: document.body,
      catalog: { overviewUrl: "/catalog/overview.json" },
    });
    map.setTheme("charcoal");
    await map.focus({ x: 0, y: 0, z: 0 });
    expect(map.orbColor("Sol")).toBe("#eceae4");
    map.setTheme("realistic");
    expect(map.orbColor("Sol")).toBe("#fff1a8");
    map.setTheme("paper");
    map.setGrid(false);
    map.setRegionGrid(false);
    map.setPlaneHeight(120);
    map.setMassCode("h");
    expect(map.planeHeight()).toBe(0);
    expect(map.orbColor("missing")).toBeUndefined();
  });

  it("destroy drops loaded tiles", async () => {
    const map = await ED3DM.create({
      container: document.body,
      catalog: { overviewUrl: "/catalog/overview.json" },
    });
    await map.focus({ x: 0, y: 0, z: 0 });
    expect(map.loadedTiles().length).toBeGreaterThan(0);
    map.destroy();
    expect(map.loadedTiles()).toEqual([]);
    expect(map.visibleSystems()).toEqual([]);
  });
});
