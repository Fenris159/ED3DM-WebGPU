// @vitest-environment node

import { readFileSync } from "node:fs";
import {
  GALAXY_SYSTEM_STRIDE_BYTES,
  GALAXY_SPATIAL_SELECTION_VERSION,
  STELLAR_SYSTEM_ATTRIBUTE_STRIDE_BYTES,
  STELLAR_TYPES,
  GalaxySystemFlags,
  Pege,
  decodeGalaxyRuntimeData,
  estimateGalaxyViewTilePopulation,
  recommendGalaxyViewTileTargets,
  streamPackedGalaxyTilesAsync,
  streamPackedGalaxyViewAsync,
  type StellarLodPolicy,
} from "pege";
import { describe, expect, it } from "vitest";
import { PEGE_OVERVIEW_CONFIG } from "../src/pege-overview";
import { resolvePegeQuery, suggestPegeQueries } from "../src/pege-worker";

type ViewResult = {
  ids: string[];
  classes: Map<string, number>;
  chunks: number;
  spatialSelectionVersion: number;
};

const runtimeFile = readFileSync(
  new URL("../node_modules/pege/data/pege-runtime.bin", import.meta.url),
);
const runtimeData = runtimeFile.buffer.slice(
  runtimeFile.byteOffset,
  runtimeFile.byteOffset + runtimeFile.byteLength,
) as ArrayBuffer;
const pege = new Pege(decodeGalaxyRuntimeData(runtimeData), {
  cache: {
    maxBytes: 128 * 1024 * 1024,
    trimToBytes: 96 * 1024 * 1024,
  },
});

async function collectView(
  targetSystems: number,
  stellarLod: StellarLodPolicy,
): Promise<ViewResult> {
  const ids: string[] = [];
  const classes = new Map<string, number>();
  let chunks = 0;
  let spatialSelectionVersion = -1;

  for await (const chunk of streamPackedGalaxyViewAsync(
    pege,
    {
      minimumFixedXyz: PEGE_OVERVIEW_CONFIG.minimumFixedXyz,
      maximumExclusiveFixedXyz: PEGE_OVERVIEW_CONFIG.maximumExclusiveFixedXyz,
      targetSystems,
      selectionSeed: BigInt(PEGE_OVERVIEW_CONFIG.selectionSeed),
      attributes: "spatial-primary-render",
      stellarLod,
    },
    { maxChunkBytes: 4_096, yieldEveryBoxels: 8 },
  )) {
    expect(chunk.sample.selectionOffset).toBe(ids.length);
    spatialSelectionVersion = chunk.sample.spatialSelectionVersion;
    expect(chunk.records.byteLength / GALAXY_SYSTEM_STRIDE_BYTES).toBe(
      chunk.systemCount,
    );
    expect(
      chunk.stellarRecords.byteLength / STELLAR_SYSTEM_ATTRIBUTE_STRIDE_BYTES,
    ).toBe(chunk.systemCount);
    expect(chunk.stellarRadii.byteLength / Float32Array.BYTES_PER_ELEMENT).toBe(
      chunk.systemCount,
    );

    const spatial = new DataView(chunk.records);
    const stellar = new DataView(chunk.stellarRecords);
    for (let index = 0; index < chunk.systemCount; index += 1) {
      const offset = index * GALAXY_SYSTEM_STRIDE_BYTES;
      const low = spatial.getUint32(offset, true);
      const high = spatial.getUint32(offset + 4, true);
      ids.push(((BigInt(high) << 32n) | BigInt(low)).toString());
      expect(spatial.getUint32(offset + 20, true) & GalaxySystemFlags.ExactPosition).not.toBe(
        0,
      );
      for (let axis = 0; axis < 3; axis += 1) {
        const value = spatial.getInt32(offset + 8 + axis * 4, true);
        expect(value).toBeGreaterThanOrEqual(
          PEGE_OVERVIEW_CONFIG.minimumFixedXyz[axis]!,
        );
        expect(value).toBeLessThan(
          PEGE_OVERVIEW_CONFIG.maximumExclusiveFixedXyz[axis]!,
        );
      }
      const classIndex = stellar.getUint32(
        index * STELLAR_SYSTEM_ATTRIBUTE_STRIDE_BYTES,
        true,
      );
      const stellarClass = STELLAR_TYPES[classIndex] ?? "unknown";
      classes.set(stellarClass, (classes.get(stellarClass) ?? 0) + 1);
    }
    chunks += 1;
  }

  expect(new Set(ids).size).toBe(ids.length);
  return { ids, classes, chunks, spatialSelectionVersion };
}

function classCount(classes: Map<string, number>, names: readonly string[]): number {
  return names.reduce((total, name) => total + (classes.get(name) ?? 0), 0);
}

describe("published PEGE representative galaxy view", () => {
  it("resolves exact generated names through the map worker seam", () => {
    const system = resolvePegeQuery(pege, "Graea Hypue KE-E c13-41");
    expect(system?.name).toBe("Graea Hypue KE-E c13-41");
    expect(system?.generation).not.toBe("authored");
  });
  it("offers an exact generated name as a search suggestion", () => {
    expect(suggestPegeQueries(pege, "Graea Hypue KE-E c13-41", 12)[0]).toEqual(
      expect.objectContaining({ name: "Graea Hypue KE-E c13-41" }),
    );
  });
  it("forwards modeled secondary stars and their physical and orbital details", () => {
    const system = resolvePegeQuery(pege, "10577971419");
    expect(system?.stellarType).toBe("A");
    expect(system?.stellarLuminositySolar ?? 0).toBeGreaterThan(0);
    expect(system?.stellarComponents).toHaveLength(2);
    expect(system?.stellarComponents?.[1]).toEqual(expect.objectContaining({
      bodyId: 1,
      starType: "F",
      validation: "estimated",
      parents: [{ bodyType: "Star", bodyId: 0 }],
    }));
    expect(system?.stellarComponents?.[1]?.luminositySolar ?? 0).toBeGreaterThan(0);
    expect(
      system?.stellarComponents?.[1]?.orbitalElements?.semiMajorAxisMeters ?? 0,
    ).toBeGreaterThan(0);
  });
  it("forwards rogue planets at their generated positions", () => {
    const system = resolvePegeQuery(pege, "4103303088608");
    expect(system).toEqual(expect.objectContaining({
      id64: "4103303088608",
      stellarType: "RoguePlanet",
      coords: { x: -11773.96875, y: -124.25, z: -464.96875 },
    }));
    expect(system?.stellarComponents).toHaveLength(1);
  });
  it("is aligned, deterministic, nested, exact, and presentation-balanced", async () => {
    const balancedPolicy = {
      mode: "presentation-balanced",
      strength: 1,
    } as const;
    const smaller = await collectView(256, balancedPolicy);
    pege.clearCaches();
    const larger = await collectView(512, balancedPolicy);
    pege.clearCaches();
    const repeated = await collectView(512, balancedPolicy);
    pege.clearCaches();
    const natural = await collectView(512, { mode: "natural" });

    expect(smaller.ids).toEqual(larger.ids.slice(0, smaller.ids.length));
    expect(larger.spatialSelectionVersion).toBe(GALAXY_SPATIAL_SELECTION_VERSION);
    expect(repeated.ids).toEqual(larger.ids);
    expect(larger.chunks).toBeGreaterThan(1);
    expect(classCount(larger.classes, ["O", "B", "A"])).toBeLessThan(
      classCount(natural.classes, ["O", "B", "A"]),
    );
    expect(classCount(larger.classes, ["G", "K", "M"])).toBeGreaterThan(
      classCount(natural.classes, ["G", "K", "M"]),
    );
  }, 90_000);

  it("plans independent population-weighted spatial tiles", async () => {
    const keys = [
      { level: 0, x: -1, y: -1, z: -1 },
      { level: 0, x: 0, y: -1, z: -1 },
    ] as const;
    const estimates = keys.map((key) =>
      estimateGalaxyViewTilePopulation(pege, key),
    );
    const plan = recommendGalaxyViewTileTargets(estimates, 2);
    expect(plan.map(({ targetSystems }) => targetSystems)).toEqual([1, 1]);
    expect(plan[0]!.populationWeight).not.toBe(plan[1]!.populationWeight);

    const collect = async (
      orderedKeys: readonly (typeof keys)[number][],
    ) => {
      const selected = new Map<string, string[]>();
      for await (const chunk of streamPackedGalaxyTilesAsync(
        pege,
        {
          tiles: orderedKeys.map((key) => ({ key, targetSystems: 1 })),
          selectionSeed: 42n,
          attributes: "spatial-primary-render",
          stellarLod: { mode: "presentation-balanced", strength: 1 },
        },
        { maxChunkBytes: 65_536, yieldEveryBoxels: 8 },
      )) {
        expect(chunk.sample.spatialSelectionVersion).toBe(
          GALAXY_SPATIAL_SELECTION_VERSION,
        );
        const spatial = new DataView(chunk.records);
        const ids = selected.get(chunk.tileKeyString) ?? [];
        for (let index = 0; index < chunk.systemCount; index += 1) {
          const offset = index * GALAXY_SYSTEM_STRIDE_BYTES;
          ids.push(
            (
              (BigInt(spatial.getUint32(offset + 4, true)) << 32n) |
              BigInt(spatial.getUint32(offset, true))
            ).toString(),
          );
        }
        selected.set(chunk.tileKeyString, ids);
      }
      return selected;
    };

    const forward = await collect(keys);
    pege.clearCaches();
    const reversed = await collect([...keys].reverse());
    expect(reversed).toEqual(forward);
  }, 10_000);
});
