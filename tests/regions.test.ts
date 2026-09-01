import { describe, it, expect, beforeEach } from "vitest";
import { ED3DM } from "../src/index";
import { onBoxelLattice } from "../src/boxel";
import {
  GALACTIC_REGIONS,
  GALAXY_CORE,
  REGION_GRID_XZ,
  distToRegionOutline,
  fitLabelHeight,
  regionLabelPlacement,
  regionLabelUp,
  snapRegionOutline,
} from "../src/regions";

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
  ],
};

describe("Codex region grid", () => {
  beforeEach(() => {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("overview.json")) {
        return new Response(JSON.stringify(OVERVIEW), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
  });

  it("places all 42 Codex titles, Inner Orion Spur near Sol, Centre near Sgr A*", () => {
    expect(GALACTIC_REGIONS).toHaveLength(42);
    expect(GALACTIC_REGIONS.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        "Inner Orion Spur",
        "Galactic Centre",
        "Inner Scutum-Centaurus Arm",
        "The Abyss",
        "The Void",
      ]),
    );
    const spur = GALACTIC_REGIONS.find((r) => r.name === "Inner Orion Spur")!;
    expect(Math.hypot(spur.coords.x, spur.coords.z)).toBeLessThan(8000);
    const centre = GALACTIC_REGIONS.find((r) => r.name === "Galactic Centre")!;
    expect(
      Math.hypot(centre.coords.x - GALAXY_CORE.x, centre.coords.z - GALAXY_CORE.z),
    ).toBeLessThan(8000);
    const colonia = { x: -9530, z: 19808 };
    const scutum = GALACTIC_REGIONS.find(
      (r) => r.name === "Inner Scutum-Centaurus Arm",
    )!;
    expect(
      Math.hypot(scutum.coords.x - colonia.x, scutum.coords.z - colonia.z),
    ).toBeLessThan(12000);
  });

  it("stores region outlines as Elite-space line pairs", () => {
    expect(REGION_GRID_XZ.length % 4).toBe(0);
    expect(REGION_GRID_XZ.length / 4).toBeGreaterThan(1000);
  });

  it("snaps every outline vertex onto the Sol-aligned 10 ly map grid", () => {
    const snapped = snapRegionOutline([10517, -22032, 10912, -22032]);
    expect(snapped[0]).toBe(10520);
    expect(snapped[2]).toBe(10910);
    expect(onBoxelLattice(snapped[1]!, 0, 10)).toBe(true);
    expect(snapRegionOutline([5, -5, 5, -5])).toEqual([]);
    let off = 0;
    let collapsed = 0;
    for (let i = 0; i + 3 < REGION_GRID_XZ.length; i += 4) {
      const x1 = REGION_GRID_XZ[i]!;
      const z1 = REGION_GRID_XZ[i + 1]!;
      const x2 = REGION_GRID_XZ[i + 2]!;
      const z2 = REGION_GRID_XZ[i + 3]!;
      if (!onBoxelLattice(x1, 0, 10)) off += 1;
      if (!onBoxelLattice(z1, 0, 10)) off += 1;
      if (!onBoxelLattice(x2, 0, 10)) off += 1;
      if (!onBoxelLattice(z2, 0, 10)) off += 1;
      if (x1 === x2 && z1 === z2) collapsed += 1;
    }
    expect(off).toBe(0);
    expect(collapsed).toBe(0);
  });

  it("sizes long titles smaller than short ones in the same clearance", () => {
    const long = "Inner Scutum-Centaurus Arm";
    expect(fitLabelHeight(long, 400)).toBeLessThan(fitLabelHeight("The Void", 400));
    expect(fitLabelHeight(long, 400)).toBeLessThan(fitLabelHeight(long, 4000));
  });

  it("faces other titles toward the galactic core", () => {
    const spur = GALACTIC_REGIONS.find((r) => r.name === "Inner Orion Spur")!;
    const up = regionLabelUp(spur);
    expect(up.x * (GALAXY_CORE.x - spur.coords.x) + up.z * (GALAXY_CORE.z - spur.coords.z)).toBeGreaterThan(
      0,
    );
  });

  it("tunes inner-region label size and placement", () => {
    const centre = GALACTIC_REGIONS.find((r) => r.name === "Galactic Centre")!;
    const arcadia = GALACTIC_REGIONS.find((r) => r.name === "Arcadian Stream")!;
    const conflux = GALACTIC_REGIONS.find(
      (r) => r.name === "Inner Orion-Perseus Conflux",
    )!;
    const scutum = GALACTIC_REGIONS.find(
      (r) => r.name === "Inner Scutum-Centaurus Arm",
    )!;
    const empyrean = GALACTIC_REGIONS.find((r) => r.name === "Empyrean Straits")!;
    const ryker = GALACTIC_REGIONS.find((r) => r.name === "Ryker's Hope")!;
    const outer = GALACTIC_REGIONS.find((r) => r.name === "Outer Orion Spur")!;
    const sag = GALACTIC_REGIONS.find((r) => r.name === "Sagittarius-Carina Arm")!;

    const c = regionLabelPlacement(centre);
    expect(c.height).toBeLessThan(300);
    expect(c.upX).toBe(0);
    expect(c.upZ).toBeGreaterThan(0);

    const a = regionLabelPlacement(arcadia);
    expect(a.height).toBeGreaterThan(300);
    expect(a.z).toBeGreaterThan(arcadia.coords.z + 2000);

    const cf = regionLabelPlacement(conflux);
    expect(cf.height).toBeLessThan(fitLabelHeight(conflux.name, distToRegionOutline(conflux.coords.x, conflux.coords.z)));

    const sc = regionLabelPlacement(scutum);
    expect(sc.height).toBeGreaterThan(300);

    const em = regionLabelPlacement(empyrean);
    const unrot = regionLabelUp({
      ...empyrean,
      coords: { ...empyrean.coords, x: em.x, z: em.z },
    });
    const yaw = Math.atan2(em.upX, em.upZ);
    const base = Math.atan2(unrot.x, unrot.z);
    expect(Math.abs(yaw - base)).toBeGreaterThan(0.25);
    expect(em.upZ).toBeGreaterThan(unrot.z);

    expect(regionLabelPlacement(ryker).x).toBeGreaterThan(ryker.coords.x);
    expect(regionLabelPlacement(outer).x).toBeGreaterThan(outer.coords.x);
    expect(regionLabelPlacement(sag).x).toBeLessThan(sag.coords.x);
    expect(regionLabelPlacement(empyrean).x).toBe(empyrean.coords.x);
    expect(regionLabelPlacement(empyrean).z).toBe(empyrean.coords.z);
  });

  it("sets Galactic Centre along +X, upright in a top-down view", () => {
    const centre = GALACTIC_REGIONS.find((r) => r.name === "Galactic Centre")!;
    const up = regionLabelUp(centre);
    expect(up.x).toBe(0);
    expect(up.z).toBeGreaterThan(0);
    const p = regionLabelPlacement(centre);
    expect(p.height).toBeLessThan(300);
  });

  it("setRegionGrid is on the map API", async () => {
    const map = await ED3DM.create({
      container: document.body,
      catalog: { overviewUrl: "/catalog/overview.json" },
    });
    map.setRegionGrid(false);
    map.setRegionGrid(true);
    expect(map.cells()).toHaveLength(1);
  });
});
