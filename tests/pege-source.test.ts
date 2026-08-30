import {
  GALAXY_SPATIAL_SELECTION_VERSION,
  GalaxySystemFlags,
  StellarSystemAttributeFlags,
} from "pege";
import { describe, expect, it, vi } from "vitest";
import { ED3DM } from "../src/index";
import { containingBoxel, distanceFromSol } from "../src/boxel";
import {
  boundedLocalSamplePlan,
  focusedResidencyRegion,
  localEdgeScore,
  localEdgeWeight,
  lodScore,
} from "../src/lod";
import {
  combinePackedBatches,
  populatePackedDisplayNames,
  resolvePegeQuery,
  thinPackedBatch,
} from "../src/pege-worker";
import {
  massCodesForView,
  mapDetailProgress,
  maximumBoxelsForView,
  PegeGalaxySource,
  thresholdForView,
  unpackPegeBatch,
} from "../src/pege-source";
import {
  PEGE_OVERVIEW_CONFIG,
  pegeOverviewCacheId,
} from "../src/pege-overview";
import { radialMassCodeShellPlan } from "../src/pege-tiles";
import type {
  GalaxyRegionRequest,
  GalaxyOverviewRequest,
  GalaxySource,
  GalaxySpatialTile,
  GalaxySpatialTileRequest,
  System,
  SystemSuggestion,
} from "../src/types";
import type { PegeWorkerResponse } from "../src/pege-protocol";

class FakePegeWorker {
  readonly messages: unknown[] = [];
  #listener?: (event: MessageEvent<PegeWorkerResponse>) => void;

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<PegeWorkerResponse>) => void,
  ) {
    this.#listener = listener;
  }

  removeEventListener() {
    this.#listener = undefined;
  }

  postMessage(message: unknown) {
    this.messages.push(message);
  }

  emit(message: PegeWorkerResponse) {
    this.#listener?.({ data: message } as MessageEvent<PegeWorkerResponse>);
  }

  terminate() {}
}

function packedRecord(): ArrayBuffer {
  const buffer = new ArrayBuffer(24);
  const view = new DataView(buffer);
  const address = 10_477_373_803n;
  view.setUint32(0, Number(address & 0xffff_ffffn), true);
  view.setUint32(4, Number(address >> 32n), true);
  view.setInt32(8, 32, true);
  view.setInt32(12, -64, true);
  view.setInt32(16, 96, true);
  view.setUint32(
    20,
    GalaxySystemFlags.Authored | GalaxySystemFlags.ExactPosition,
    true,
  );
  return buffer;
}

function packedStellarRecord(): ArrayBuffer {
  const buffer = new ArrayBuffer(32);
  const view = new DataView(buffer);
  view.setUint32(0, 4, true); // G
  view.setUint32(
    12,
    StellarSystemAttributeFlags.HasProfile |
      StellarSystemAttributeFlags.HasPrimaryMass |
      StellarSystemAttributeFlags.HasPrimaryTemperature |
      StellarSystemAttributeFlags.HasDisplayColor |
      StellarSystemAttributeFlags.ExactDisplayColor |
      StellarSystemAttributeFlags.ExactPrimaryClass |
      StellarSystemAttributeFlags.ExactPrimaryMass |
      StellarSystemAttributeFlags.ExactPrimaryTemperature |
      StellarSystemAttributeFlags.ExactPrimaryRadius,
    true,
  );
  view.setFloat32(16, 1, true);
  view.setFloat32(20, 5778, true);
  view.setUint32(28, 0xff80c0ff, true);
  return buffer;
}

describe("PEGE galaxy adapter", () => {
  it("maps successive local-detail requests into one monotonic progress range", () => {
    expect(mapDetailProgress(5, 10, { start: 0.35, end: 0.55 })).toEqual({
      phase: "detail",
      completed: 0.45,
      total: 1,
    });
    expect(mapDetailProgress(12, 10, { start: 0.55, end: 1 })).toEqual({
      phase: "detail",
      completed: 1,
      total: 1,
    });
  });

  it("attaches decoded generated names to packed ordinary Systems", () => {
    const records = packedRecord();
    const view = new DataView(records);
    const address = 8_256_182n;
    view.setUint32(0, Number(address & 0xffff_ffffn), true);
    view.setUint32(4, Number(address >> 32n), true);
    view.setUint32(20, GalaxySystemFlags.Ordinary, true);
    const named = populatePackedDisplayNames(
      {
        displayNameForResolvedSystem: vi.fn(() => ({
          status: "resolved" as const,
          name: "Glaisue ZE-A g0",
          source: "procedural-sector",
        })),
      },
      { records, names: [] },
    );
    expect(named.names).toEqual([
      { systemIndex: 0, name: "Glaisue ZE-A g0" },
    ]);
  });

  it("carries every PEGE stellar component through selected-System resolution", () => {
    const pege = {
      resolveAddress: vi.fn(() => ({
        status: "procedural" as const,
        branch: "ordinary" as const,
        systemAddress: 42n,
        position: { starPosXyz: [1, 2, 3] as const },
      })),
      resolveDisplayName: vi.fn(() => ({
        status: "resolved" as const,
        name: "Test System",
      })),
      resolveStellarProfile: vi.fn(() => ({
        status: "resolved" as const,
        source: "compiled-catalogue" as const,
        profile: {
          systemAddress: 42n,
          primaryBodyId: 0,
          composition: "complete" as const,
          components: [
            {
              bodyId: 0,
              starType: "G" as const,
              subclass: 2,
              luminosityClass: "V" as const,
              stellarMassSolar: 1,
              surfaceTemperatureKelvin: 5778,
              displayColor: { srgb: [1, 0.9, 0.6] as const, source: "engine-palette" as const },
              provenance: "procedural-engine" as const,
              validation: "exact" as const,
            },
            {
              bodyId: 1,
              name: "Test System B",
              parents: [{ bodyType: "Null" as const, bodyId: 0 }],
              starType: "M" as const,
              subclass: 4,
              luminosityClass: "V" as const,
              stellarMassSolar: 0.3,
              provenance: "procedural-engine" as const,
              validation: "exact" as const,
            },
          ],
        },
      })),
    };

    expect(resolvePegeQuery(pege as never, "42")).toEqual(
      expect.objectContaining({
        stellarComponents: [
          expect.objectContaining({ bodyId: 0, starType: "G", subclass: 2 }),
          expect.objectContaining({ bodyId: 1, name: "Test System B", starType: "M" }),
        ],
      }),
    );
  });

  it("versions every PEGE view-selection input in the overview cache identity", () => {
    expect(PEGE_OVERVIEW_CONFIG).toEqual({
      minimumFixedXyz: [-1_280_000, -160_000, -451_200],
      maximumExclusiveFixedXyz: [1_283_200, 160_000, 2_112_000],
      targetSystems: 50_000,
      selectionSeed: "42",
      stellarLod: { mode: "presentation-balanced", strength: 1 },
      compositionVersion: "pege-final-systems-v2-display-names",
    });
    expect(pegeOverviewCacheId("/pege-runtime.bin", "https://example.test/map")).toBe(
      `pege-1.6-spatial-v3:https://example.test/pege-runtime.bin:${GALAXY_SPATIAL_SELECTION_VERSION}:50000:42:presentation-balanced:1:-1280000,-160000,-451200:1283200,160000,2112000:pege-final-systems-v2-display-names`,
    );
  });

  it("accepts PEGE's final authored-name stream as one LOD population", async () => {
    const worker = new FakePegeWorker();
    const source = new PegeGalaxySource({
      runtimeUrl: "/pege-runtime.bin?v=1.5.0",
      worker: worker as unknown as Worker,
    });

    const loading = source.loadOverview({ lod: 20 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const request = worker.messages[1] as { requestId: number };
    expect(request).toEqual({
      type: "overview",
      requestId: 1,
      minimumFixedXyz: PEGE_OVERVIEW_CONFIG.minimumFixedXyz,
      maximumExclusiveFixedXyz: PEGE_OVERVIEW_CONFIG.maximumExclusiveFixedXyz,
      targetSystems: 50_000,
      selectionSeed: "42",
      stellarLod: { mode: "presentation-balanced", strength: 1 },
    });

    worker.emit({
      type: "batch",
      requestId: request.requestId,
      batch: {
        records: packedRecord(),
        names: [{ systemIndex: 0, name: "View System" }],
      },
    } as PegeWorkerResponse);
    worker.emit({
      type: "batch",
      requestId: request.requestId,
      batch: {
        records: packedRecord(),
        names: [{ systemIndex: 0, name: "View System 2" }],
      },
    } as PegeWorkerResponse);
    worker.emit({ type: "complete", requestId: request.requestId });

    const overview = await loading;
    expect(overview.systems.map(({ name }) => name)).toEqual([
      "View System",
      "View System 2",
    ]);
    source.destroy();
  });

  it("keeps interactive name queries responsive while galaxy generation is busy", async () => {
    const galaxyWorker = new FakePegeWorker();
    const queryWorker = new FakePegeWorker();
    const source = new PegeGalaxySource({
      runtimeUrl: "/pege-runtime.bin?v=1.5.0",
      worker: galaxyWorker as unknown as Worker,
      queryWorker: queryWorker as unknown as Worker,
    });

    const generating = source.loadRegion({
      center: { x: 0, y: 0, z: 0 },
      radiusLy: 100,
      cameraDistanceLy: 1_000,
      lod: 50,
    });
    const searching = source.suggest("Sol", 12);

    const galaxyRequest = galaxyWorker.messages[1] as { requestId: number };
    const queryRequest = queryWorker.messages[1] as { requestId: number };
    expect(galaxyRequest).toMatchObject({ type: "generate" });
    expect(queryRequest).toEqual({
      type: "suggest",
      requestId: 2,
      query: "Sol",
      limit: 12,
    });
    expect(galaxyWorker.messages).not.toContainEqual(queryRequest);

    queryWorker.emit({
      type: "suggestions",
      requestId: queryRequest.requestId,
      suggestions: [
        {
          name: "Sol",
          id64: "10477373803",
          coords: { x: 0, y: 0, z: 0 },
        },
      ],
    });
    await expect(searching).resolves.toEqual([
      {
        name: "Sol",
        id64: "10477373803",
        coords: { x: 0, y: 0, z: 0 },
      },
    ]);

    galaxyWorker.emit({ type: "complete", requestId: galaxyRequest.requestId });
    await expect(generating).resolves.toEqual([]);
    source.destroy();
  });

  it("reuses the complete local zone while zoom changes inside that zone", async () => {
    const worker = new FakePegeWorker();
    const source = new PegeGalaxySource({
      runtimeUrl: "/pege-runtime.bin?v=1.5.0",
      worker: worker as unknown as Worker,
    });
    const residency = focusedResidencyRegion({ x: 0, y: 0, z: 0 }, 285);
    const request = (cameraDistanceLy: number): GalaxyRegionRequest => ({
      center: residency.center,
      radiusLy: residency.radiusLy,
      bounds: {
        minimum: residency.minimum,
        maximum: residency.maximum,
      },
      cameraDistanceLy,
      lod: "all",
    });
    const firstLoad = source.loadRegion(request(285));
    const generate = worker.messages[1] as { requestId: number };
    worker.emit({ type: "complete", requestId: generate.requestId });
    await expect(firstLoad).resolves.toEqual([]);
    const messagesAfterFirstLoad = worker.messages.length;

    await expect(source.loadRegion(request(42))).resolves.toEqual([]);
    expect(worker.messages).toHaveLength(messagesAfterFirstLoad);
    source.destroy();
  });

  it("returns a decoded name location preview on the query worker", async () => {
    const galaxyWorker = new FakePegeWorker();
    const queryWorker = new FakePegeWorker();
    const source = new PegeGalaxySource({
      runtimeUrl: "/pege-runtime.bin?v=1.5.0",
      worker: galaxyWorker as unknown as Worker,
      queryWorker: queryWorker as unknown as Worker,
    });

    const loading = source.preview("Juenae SL-J d10-10430");
    const request = queryWorker.messages[1] as { requestId: number };
    expect(request).toEqual({
      type: "preview",
      requestId: 1,
      query: "Juenae SL-J d10-10430",
    });
    queryWorker.emit({
      type: "previews",
      requestId: request.requestId,
      previews: [{
        name: "Juenae SL-J d10-10430",
        id64: "358382615647195",
        coords: { x: 295, y: -65, z: 26735 },
        exactPosition: false,
      }],
    });

    await expect(loading).resolves.toEqual([{
      name: "Juenae SL-J d10-10430",
      id64: "358382615647195",
      coords: { x: 295, y: -65, z: 26735 },
      exactPosition: false,
    }]);
    source.destroy();
  });

  it("cancels a partial overview without accepting later Worker completion", async () => {
    const worker = new FakePegeWorker();
    const source = new PegeGalaxySource({
      runtimeUrl: "/pege-runtime.bin?v=1.5.0",
      worker: worker as unknown as Worker,
    });
    const controller = new AbortController();
    const loading = source.loadOverview({ lod: 20 }, controller.signal);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const request = worker.messages[1] as { requestId: number };

    worker.emit({
      type: "batch",
      requestId: request.requestId,
      batch: { records: packedRecord(), names: [] },
    });
    controller.abort();

    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.messages).toContainEqual({
      type: "cancel",
      requestId: request.requestId,
    });
    worker.emit({ type: "complete", requestId: request.requestId });
    source.destroy();
  });

  it("reuses the densest complete PEGE spatial tiles within one camera zone", async () => {
    const worker = new FakePegeWorker();
    const source = new PegeGalaxySource({
      runtimeUrl: "/pege-runtime.bin?v=1.5.0",
      worker: worker as unknown as Worker,
    });
    const keys = [
      { level: 0, x: -1, y: 0, z: 0 },
      { level: 0, x: 0, y: 0, z: 0 },
    ] as const;
    const plan = keys.map((key, index) => ({
      key,
      keyString: `${key.level}/${key.x}/${key.y}/${key.z}`,
      targetSystems: index + 1,
      populationWeight: index + 0.5,
    }));

    const firstLoad = source.loadSpatialTiles!({
      keys,
      totalTargetSystems: 3,
      cacheScope: "h:zone-a",
      keyWeights: [
        { key: keys[0], weight: 1 },
        { key: keys[1], weight: 0.25 },
      ],
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const firstPlanRequest = worker.messages[1] as { requestId: number };
    expect(firstPlanRequest).toEqual({
      type: "plan-tiles",
      requestId: 1,
      keys,
      totalTargetSystems: 3,
      keyWeights: [1, 0.25],
    });
    worker.emit({
      type: "tile-plan",
      requestId: firstPlanRequest.requestId,
      tiles: plan,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const tileRequest = worker.messages[2] as { requestId: number };
    expect(tileRequest).toEqual(
      expect.objectContaining({
        type: "tiles",
        requestId: 2,
        tiles: plan.map(({ key, targetSystems }) => ({ key, targetSystems })),
        selectionSeed: "42",
      }),
    );
    for (const tile of plan) {
      worker.emit({
        type: "tile-batch",
        requestId: tileRequest.requestId,
        tileKey: tile.key,
        tileKeyString: tile.keyString,
        selectionOffset: 0,
        batch: {
          records: packedRecord(),
          names: [{ systemIndex: 0, name: tile.keyString }],
        },
      });
    }
    worker.emit({ type: "complete", requestId: tileRequest.requestId });
    const first = await firstLoad;
    expect(first.map(({ key }) => key)).toEqual(plan.map(({ keyString }) => keyString));
    expect(first.map(({ systems }) => systems.length)).toEqual([1, 1]);

    const secondLoad = source.loadSpatialTiles!({
      keys,
      totalTargetSystems: 2,
      cacheScope: "h:zone-a",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const secondPlanRequest = worker.messages[3] as { requestId: number };
    const lowerPlan = plan.map((tile) => ({
      ...tile,
      targetSystems: 1,
    }));
    worker.emit({
      type: "tile-plan",
      requestId: secondPlanRequest.requestId,
      tiles: lowerPlan,
    });
    expect(await secondLoad).toEqual(first);
    expect(
      worker.messages.filter(
        (message) => (message as { type?: string }).type === "tiles",
      ),
    ).toHaveLength(1);
    source.destroy();
  });

  it("never publishes or caches a cancelled partial spatial tile", async () => {
    const worker = new FakePegeWorker();
    const source = new PegeGalaxySource({
      runtimeUrl: "/pege-runtime.bin?v=1.5.0",
      worker: worker as unknown as Worker,
    });
    const key = { level: 0, x: 0, y: 0, z: 0 } as const;
    const controller = new AbortController();
    const loading = source.loadSpatialTiles!(
      { keys: [key], totalTargetSystems: 2 },
      controller.signal,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const planRequest = worker.messages[1] as { requestId: number };
    worker.emit({
      type: "tile-plan",
      requestId: planRequest.requestId,
      tiles: [
        {
          key,
          keyString: "0/0/0/0",
          targetSystems: 2,
          populationWeight: 1,
        },
      ],
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const tileRequest = worker.messages[2] as { requestId: number };
    worker.emit({
      type: "tile-batch",
      requestId: tileRequest.requestId,
      tileKey: key,
      tileKeyString: "0/0/0/0",
      selectionOffset: 0,
      batch: { records: packedRecord(), names: [] },
    });
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.messages).toContainEqual({
      type: "cancel",
      requestId: tileRequest.requestId,
    });
    source.destroy();
  });

  it("ignores late progress from a cancelled spatial request", async () => {
    const worker = new FakePegeWorker();
    const onProgress = vi.fn();
    const source = new PegeGalaxySource({
      runtimeUrl: "/pege-runtime.bin?v=1.5.0",
      worker: worker as unknown as Worker,
      onProgress,
    });
    const key = { level: 0, x: 0, y: 0, z: 0 } as const;
    const controller = new AbortController();
    const loading = source.loadSpatialTiles!(
      {
        keys: [key],
        totalTargetSystems: 2,
        detailProgressRange: { start: 0.35, end: 0.55 },
      },
      controller.signal,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const planRequest = worker.messages[1] as { requestId: number };
    worker.emit({
      type: "tile-plan",
      requestId: planRequest.requestId,
      tiles: [{
        key,
        keyString: "0/0/0/0",
        targetSystems: 2,
        populationWeight: 1,
      }],
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const tileRequest = worker.messages[2] as { requestId: number };
    worker.emit({
      type: "progress",
      requestId: tileRequest.requestId,
      phase: "detail",
      completed: 0,
      total: 2,
    });
    expect(onProgress).toHaveBeenLastCalledWith({
      phase: "detail",
      completed: 0.35,
      total: 1,
    });

    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    const progressCalls = onProgress.mock.calls.length;
    worker.emit({
      type: "progress",
      requestId: tileRequest.requestId,
      phase: "detail",
      completed: 2,
      total: 2,
    });
    expect(onProgress).toHaveBeenCalledTimes(progressCalls);
    source.destroy();
  });

  it("clips whole-boxel PEGE records to the requested spatial bounds before transfer", () => {
    const batch = thinPackedBatch(
      packedRecord(),
      [{ systemIndex: 0, name: "outside" }],
      1,
      [0, 0, 0],
      [320, 320, 320],
    );
    expect(batch.records.byteLength).toBe(0);
    expect(batch.names).toEqual([]);
  });

  it("keeps PEGE primary-render buffers aligned while clipping spatial records", () => {
    const first = packedRecord();
    const second = packedRecord();
    new DataView(first).setInt32(8, 1_000, true);
    new DataView(second).setUint32(0, 2, true);
    const combined = combinePackedBatches([
      { records: first, names: [{ systemIndex: 0, name: "outside" }] },
      { records: second, names: [{ systemIndex: 0, name: "inside" }] },
    ]);
    const stellarRecords = new ArrayBuffer(2 * 32);
    const stellar = new DataView(stellarRecords);
    stellar.setUint32(0, 1, true);
    stellar.setUint32(32, 2, true);
    const stellarRadii = new Float32Array([100, 200]).buffer;

    const batch = thinPackedBatch(
      combined.records,
      combined.names,
      1,
      [0, -100, 0],
      [320, 100, 320],
      stellarRecords,
      stellarRadii,
    );

    expect(batch.records.byteLength).toBe(24);
    expect(batch.names).toEqual([{ systemIndex: 0, name: "inside" }]);
    expect(new DataView(batch.stellarRecords!).getUint32(0, true)).toBe(2);
    expect(new Float32Array(batch.stellarRadii!)[0]).toBe(200);
  });

  it("coalesces streamed records while preserving authored-name indexes", () => {
    const combined = combinePackedBatches([
      { records: packedRecord(), names: [{ systemIndex: 0, name: "First" }] },
      { records: packedRecord(), names: [{ systemIndex: 0, name: "Second" }] },
    ]);
    expect(combined.records.byteLength).toBe(48);
    expect(combined.names).toEqual([
      { systemIndex: 0, name: "First" },
      { systemIndex: 1, name: "Second" },
    ]);
  });

  it("produces stable unsigned LOD scores in the unit interval", () => {
    const scores = Array.from({ length: 10_000 }, (_, low) => lodScore(low, 2));
    expect(Math.min(...scores)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...scores)).toBeLessThan(1);
    const kept = scores.filter((score) => score < 0.1).length;
    expect(kept).toBeGreaterThan(900);
    expect(kept).toBeLessThan(1_100);
    expect(lodScore(123, 456)).toBe(lodScore(123, 456));
  });

  it("softens local-detail boundaries with an independent stable hash", () => {
    expect(localEdgeWeight(0.5)).toBe(1);
    expect(localEdgeWeight(0.8)).toBeCloseTo(0.5);
    expect(localEdgeWeight(1)).toBe(0);
    expect(localEdgeScore(123, 456)).toBe(localEdgeScore(123, 456));
    expect(localEdgeScore(123, 456)).not.toBe(lodScore(123, 456));
  });

  it("bounds PEGE boxel generation without lowering the requested System sample", () => {
    expect(maximumBoxelsForView(100)).toBeUndefined();
    expect(maximumBoxelsForView(180)).toBeUndefined();
    expect(maximumBoxelsForView(301)).toBe(2_048);
    expect(maximumBoxelsForView(6_000)).toBe(2_048);
    expect(boundedLocalSamplePlan(2_000, 4_096, 0.03)).toEqual({
      boxelThreshold: 1,
      systemThreshold: 0.03,
    });
    const plan = boundedLocalSamplePlan(100_000, 4_096, 0.003);
    expect(plan.boxelThreshold).toBeCloseTo(0.04096);
    expect(plan.systemThreshold).toBeCloseTo(0.003 / 0.04096);
    expect(plan.boxelThreshold * plan.systemThreshold).toBeCloseTo(0.003);
  });

  it("uses zoom for population composition and LOD only for stable thinning", () => {
    expect(massCodesForView(40_000, 0)).toEqual([7]);
    expect(massCodesForView(40_000, 50)).toEqual([7]);
    expect(massCodesForView(40_000, 100)).toEqual([7]);
    expect(massCodesForView(100, 0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(massCodesForView(285, "all")).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(massCodesForView(40_000, "all")).toEqual([7]);
    expect(thresholdForView(40_000, 0)).toBeCloseTo(0.0000001);
    expect(thresholdForView(40_000, 20)).toBeCloseTo(0.000000136);
    expect(thresholdForView(100, 0)).toBe(1);
    expect(thresholdForView(100, "all")).toBe(1);
    expect(thresholdForView(285, "all")).toBe(1);
    expect(maximumBoxelsForView(285)).toBeUndefined();
    expect(thresholdForView(500, "all")).toBeCloseTo(0.03);
    expect(thresholdForView(1_000, "all")).toBeCloseTo(0.003);
    expect(thresholdForView(3_000, "all")).toBeCloseTo(0.0003);
    expect(thresholdForView(6_000, "all")).toBeCloseTo(0.00003);
  });

  it("decodes PEGE fixed-point records without JSON catalogue rows", () => {
    const [system] = unpackPegeBatch({
        records: packedRecord(),
        names: [{ systemIndex: 0, name: "Sol" }],
        stellarRecords: packedStellarRecord(),
        stellarRadii: new Float32Array([695_700_000]).buffer,
      });
    expect(system).toEqual(
      expect.objectContaining({
        name: "Sol",
        id64: "10477373803",
        coords: { x: 1, y: -2, z: 3 },
        generation: "authored",
        exactPosition: true,
        massCode: 3,
        stellarColor: "#ffc080",
        stellarType: "G",
        stellarMassSolar: 1,
        stellarTemperatureKelvin: 5778,
        stellarProfileSource: "compiled-catalogue",
        stellarProfileValidation: "exact",
        stellarValidation: {
          starType: "exact",
          mass: "exact",
          temperature: "exact",
          radius: "exact",
          displayColor: "exact",
        },
        stellarProfileComposition: "partial",
      }),
    );
    expect(Math.abs(system!.stellarRadiusMeters! - 695_700_000)).toBeLessThan(64);
    const boxel = containingBoxel(system!.coords, "a");
    expect(boxel).toEqual({ ox: -5, oy: -5, oz: -5, size: 10 });
    expect(distanceFromSol(system!.coords)).toBeCloseTo(Math.sqrt(14));
  });

  it("decodes independent procedural stellar-field provenance", () => {
    const records = packedRecord();
    new DataView(records).setUint32(
      20,
      GalaxySystemFlags.Ordinary | GalaxySystemFlags.ExactPosition,
      true,
    );
    const stellarRecords = packedStellarRecord();
    new DataView(stellarRecords).setUint32(
      12,
      StellarSystemAttributeFlags.HasProfile |
        StellarSystemAttributeFlags.HasPrimaryMass |
        StellarSystemAttributeFlags.HasDisplayColor |
        StellarSystemAttributeFlags.EstimatedPrimaryClass |
        StellarSystemAttributeFlags.ExactPrimaryMass |
        StellarSystemAttributeFlags.EstimatedDisplayColor,
      true,
    );

    const [system] = unpackPegeBatch({
      records,
      names: [],
      stellarRecords,
      stellarRadii: new Float32Array([Number.NaN]).buffer,
    });

    expect(system).toEqual(
      expect.objectContaining({
        generation: "ordinary",
        stellarProfileSource: "procedural-primary-model",
        stellarProfileValidation: "estimated",
        stellarValidation: {
          starType: "estimated",
          mass: "exact",
          displayColor: "estimated",
        },
      }),
    );
    expect(system!.stellarTemperatureKelvin).toBeUndefined();
    expect(system!.stellarRadiusMeters).toBeUndefined();
  });

  it("keeps the whole-galaxy overview resident while camera-local detail changes", async () => {
    const overview: System[] = [
      {
        name: "Far overview System",
        id64: "0",
        coords: { x: -40_000, y: 500, z: 60_000 },
        generation: "ordinary",
      },
    ];
    const local: System[] = [
      {
        name: "Sol",
        id64: "10477373803",
        coords: { x: 0, y: 0, z: 0 },
        generation: "authored",
      },
    ];
    const loadOverview = vi.fn(async (_request: GalaxyOverviewRequest) => ({
      systems: overview,
    }));
    const source: GalaxySource = {
      loadOverview,
      loadRegion: vi.fn(async () => local),
      resolve: vi.fn(async () => local[0]),
      suggest: vi.fn(async () => []),
      resolveDisplayName: vi.fn(async () => "Sol"),
      destroy: vi.fn(),
    };

    const map = await ED3DM.create({ container: document.body, source, lod: 10 });
    expect(map.visibleSystems().map((system) => system.name)).toEqual([
      "Far overview System",
    ]);
    await map.flyTo("Sol");
    expect(map.visibleSystems().map((system) => system.name).sort()).toEqual([
      "Far overview System",
      "Sol",
    ]);
    expect(loadOverview).toHaveBeenCalledOnce();
    map.destroy();
  });

  it("keeps the complete PEGE overview as the floor at every LOD", async () => {
    const view = Array.from({ length: 5 }, (_, index): System => ({
      name: `View ${index + 1}`,
      id64: String(index + 1),
      coords: { x: index, y: 0, z: 0 },
      generation: index === 1 ? "authored" : "ordinary",
    }));
    view[1]!.name = "Authored name";
    const source: GalaxySource = {
      loadOverview: vi.fn(async () => ({ systems: view })),
      loadRegion: vi.fn(async () => []),
      resolve: vi.fn(async () => undefined),
      suggest: vi.fn(async () => []),
      resolveDisplayName: vi.fn(async () => undefined),
      destroy: vi.fn(),
    };

    const map = await ED3DM.create({ container: document.body, source, lod: 20 });
    expect(map.visibleSystems().map(({ name }) => name)).toEqual([
      "View 1",
      "Authored name",
      "View 3",
      "View 4",
      "View 5",
    ]);

    await map.setLod(60);
    expect(map.visibleSystems().map(({ name }) => name)).toEqual([
      "View 1",
      "Authored name",
      "View 3",
      "View 4",
      "View 5",
    ]);

    await map.setLod("all");
    expect(map.visibleSystems().map(({ name }) => name)).toEqual([
      "View 1",
      "Authored name",
      "View 3",
      "View 4",
      "View 5",
    ]);
    map.destroy();
  });

  it("keeps the current local patch visible until replacement detail is ready", async () => {
    const overview: System = {
      name: "Overview",
      id64: "1",
      coords: { x: 10_000, y: 0, z: 10_000 },
      generation: "ordinary",
    };
    const oldLocal: System = {
      name: "Old local patch",
      id64: "2",
      coords: { x: 0, y: 0, z: 0 },
      generation: "ordinary",
    };
    const newLocal: System = {
      name: "New local patch",
      id64: "3",
      coords: { x: 1_000, y: 0, z: 1_000 },
      generation: "ordinary",
    };
    let resolveReplacement!: (systems: System[]) => void;
    let regionCall = 0;
    const source: GalaxySource = {
      loadOverview: vi.fn(async () => ({ systems: [overview] })),
      loadRegion: vi.fn((request: GalaxyRegionRequest) => {
        if (request.cameraDistanceLy === 50 && request.lod === "all") {
          return Promise.resolve([oldLocal]);
        }
        regionCall += 1;
        if (regionCall === 1) return Promise.resolve([oldLocal]);
        return new Promise<System[]>((resolve) => {
          resolveReplacement = resolve;
        });
      }),
      resolve: vi.fn(async () => oldLocal),
      suggest: vi.fn(async () => []),
      resolveDisplayName: vi.fn(async () => undefined),
      destroy: vi.fn(),
    };

    const map = await ED3DM.create({ container: document.body, source, lod: "all" });
    await map.flyTo("Old local patch");
    expect(map.visibleSystems().map(({ name }) => name).sort()).toEqual([
      "Old local patch",
      "Overview",
    ]);

    map.clearSelection();
    const replacement = map.focus(newLocal.coords);
    await Promise.resolve();
    expect(map.visibleSystems().map(({ name }) => name).sort()).toEqual([
      "Old local patch",
      "Overview",
    ]);

    resolveReplacement([newLocal]);
    await replacement;
    expect(map.visibleSystems().map(({ name }) => name).sort()).toEqual([
      "New local patch",
      "Overview",
    ]);
    map.destroy();
  });

  it("keeps exact local Systems and complete radial h/g/f/e detail resident together", async () => {
    const overview: System = {
      name: "Overview",
      id64: "1",
      coords: { x: 20_000, y: 0, z: 20_000 },
      generation: "ordinary",
    };
    const target: System = {
      name: "Target",
      id64: "2",
      coords: { x: 100, y: 0, z: 0 },
      generation: "ordinary",
    };
    const exactNeighbor: System = {
      name: "Exact neighbor",
      id64: "3",
      coords: { x: 104, y: 2, z: 3 },
      generation: "ordinary",
    };
    const hNeighbor: System = {
      name: "H neighbor",
      id64: "4",
      coords: { x: 400, y: 200, z: 0 },
      generation: "ordinary",
    };
    const gNeighbor: System = {
      name: "G neighbor",
      id64: "5",
      coords: { x: 0, y: 800, z: 0 },
      generation: "ordinary",
    };
    const fNeighbor: System = {
      name: "F neighbor",
      id64: "6",
      coords: { x: 0, y: 0, z: 1_400 },
      generation: "ordinary",
    };
    const eNeighbor: System = {
      name: "E neighbor",
      id64: "7",
      coords: { x: 1_780, y: 0, z: 0 },
      generation: "ordinary",
    };
    const replacementNeighbors: System[] = [
      {
        ...hNeighbor,
        name: "Replacement H neighbor",
        id64: "14",
        coords: { x: 500, y: 200, z: 0 },
      },
      {
        ...gNeighbor,
        name: "Replacement G neighbor",
        id64: "15",
        coords: { x: 110, y: 800, z: 0 },
      },
      {
        ...fNeighbor,
        name: "Replacement F neighbor",
        id64: "16",
        coords: { x: 110, y: 0, z: 1_400 },
      },
      {
        ...eNeighbor,
        name: "Replacement E neighbor",
        id64: "17",
        coords: { x: 1_790, y: 0, z: 0 },
      },
    ];
    const spatialBatches = [
      [hNeighbor, gNeighbor, fNeighbor, eNeighbor],
      replacementNeighbors,
    ];
    let spatialCall = 0;
    let blockedSignal: AbortSignal | undefined;
    let releaseBlocked: ((tiles: GalaxySpatialTile[]) => void) | undefined;
    const loadSpatialTiles = vi.fn(async (
      request: GalaxySpatialTileRequest,
      signal?: AbortSignal,
    ) => {
      if (spatialCall >= 8) {
        spatialCall += 1;
        blockedSignal = signal;
        return await new Promise<GalaxySpatialTile[]>((resolve) => {
          releaseBlocked = resolve;
        });
      }
      const batch = Math.floor(spatialCall / 4);
      const system = spatialBatches[batch]![spatialCall++ % 4]!;
      return [{
        key: `${request.keys[0]!.level}/${request.keys[0]!.x}/${request.keys[0]!.y}/${request.keys[0]!.z}`,
        tileKey: request.keys[0]!,
        targetSystems: request.totalTargetSystems,
        populationWeight: 1,
        systems: [system],
      }];
    });
    let blockNextRegion = false;
    let blockedRegionSignal: AbortSignal | undefined;
    let releaseBlockedRegion: (() => void) | undefined;
    const loadRegion = vi.fn(async (
      _request: GalaxyRegionRequest,
      signal?: AbortSignal,
    ) => {
      if (blockNextRegion) {
        blockNextRegion = false;
        blockedRegionSignal = signal;
        await new Promise<void>((resolve) => {
          releaseBlockedRegion = resolve;
        });
      }
      return [target, exactNeighbor];
    });
    const source: GalaxySource = {
      loadOverview: vi.fn(async () => ({ systems: [overview] })),
      loadRegion,
      loadSpatialTiles,
      resolve: vi.fn(async () => target),
      suggest: vi.fn(async () => []),
      resolveDisplayName: vi.fn(async () => target.name),
      destroy: vi.fn(),
    };

    const onDetailRendered = vi.fn();
    const map = await ED3DM.create({
      container: document.body,
      source,
      lod: "all",
      onDetailRendered,
    });
    await map.flyTo(target.name);
    await vi.waitFor(() => expect(loadSpatialTiles).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(onDetailRendered).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(map.visibleSystems().map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          "Overview",
          "Target",
          "Exact neighbor",
          "H neighbor",
          "G neighbor",
          "F neighbor",
          "E neighbor",
        ]),
      ),
    );
    const shells = radialMassCodeShellPlan(target.coords);
    expect(loadSpatialTiles.mock.calls.map(([request]) => request.keys.length))
      .toEqual(shells.map(({ keys }) => keys.length));
    expect(loadSpatialTiles.mock.calls.every(([request]) =>
      request.keyWeights === undefined,
    )).toBe(true);
    expect(loadSpatialTiles.mock.calls.map(([request]) => request.totalTargetSystems))
      .toEqual([...loadSpatialTiles.mock.calls]
        .map(([request]) => request.totalTargetSystems)
        .sort((a, b) => b - a));
    expect(loadSpatialTiles.mock.calls.map(([request]) => request.keys))
      .toEqual(shells.map(({ keys }) => keys));
    const progressRanges = loadSpatialTiles.mock.calls.map(
      ([tileRequest]) => tileRequest.detailProgressRange!,
    );
    expect(progressRanges[0]?.start).toBeCloseTo(0.35);
    expect(progressRanges.at(-1)?.end).toBe(1);
    expect(
      progressRanges.every(
        (range, index) =>
          index === 0 || range.start >= progressRanges[index - 1]!.end,
      ),
    ).toBe(true);

    await map.setLod("all");
    expect(loadSpatialTiles).toHaveBeenCalledTimes(4);
    map.clearSelection();
    await map.focus({ x: 110, y: 0, z: 0 });
    expect(loadSpatialTiles).toHaveBeenCalledTimes(8);
    await vi.waitFor(() => expect(onDetailRendered).toHaveBeenCalledTimes(2));
    expect(map.visibleSystems().map(({ name }) => name)).toEqual(
      expect.arrayContaining(replacementNeighbors.map(({ name }) => name)),
    );
    expect(map.visibleSystems().map(({ name }) => name)).not.toContain("H neighbor");

    const leavingCommittedArea = map.focus({ x: 120, y: 0, z: 0 });
    await vi.waitFor(() => expect(loadSpatialTiles).toHaveBeenCalledTimes(9));
    await map.focus({ x: 110, y: 0, z: 0 });
    expect(blockedSignal?.aborted).toBe(true);
    releaseBlocked?.([]);
    await leavingCommittedArea;
    await vi.waitFor(() => expect(onDetailRendered).toHaveBeenCalledTimes(3));

    blockNextRegion = true;
    const priorRegionCalls = loadRegion.mock.calls.length;
    const leavingDuringExactDetail = map.focus({ x: 5_000, y: 0, z: 0 });
    await vi.waitFor(() =>
      expect(loadRegion).toHaveBeenCalledTimes(priorRegionCalls + 1),
    );
    await map.focus({ x: 110, y: 0, z: 0 });
    expect(blockedRegionSignal?.aborted).toBe(true);
    releaseBlockedRegion?.();
    await leavingDuringExactDetail;
    await vi.waitFor(() => expect(onDetailRendered).toHaveBeenCalledTimes(4));
    map.destroy();
  });

  it("applies an LOD replacement without clearing the current foreground", async () => {
    const target: System = {
      name: "Target",
      id64: "10",
      coords: { x: 0, y: 0, z: 0 },
      generation: "ordinary",
    };
    const firstNeighbor: System = {
      name: "First neighbor",
      id64: "11",
      coords: { x: 1, y: 0, z: 0 },
      generation: "ordinary",
    };
    const nextNeighbor: System = {
      name: "Next neighbor",
      id64: "12",
      coords: { x: 2, y: 0, z: 0 },
      generation: "ordinary",
    };
    let finishLod!: (systems: System[]) => void;
    let calls = 0;
    const source: GalaxySource = {
      loadOverview: vi.fn(async () => ({ systems: [] })),
      loadRegion: vi.fn((request: GalaxyRegionRequest) => {
        if (request.cameraDistanceLy === 50 && request.lod === "all") {
          return Promise.resolve([target, firstNeighbor]);
        }
        calls += 1;
        if (calls === 1) return Promise.resolve([target, firstNeighbor]);
        return new Promise<System[]>((resolve) => { finishLod = resolve; });
      }),
      resolve: vi.fn(async () => target),
      suggest: vi.fn(async () => []),
      resolveDisplayName: vi.fn(async () => target.name),
      destroy: vi.fn(),
    };

    const map = await ED3DM.create({ container: document.body, source, lod: 10 });
    await map.flyTo(target.name);
    await vi.waitFor(() => expect(map.visibleSystems()).toContain(firstNeighbor));
    map.clearSelection();

    const changing = map.setLod(50);
    await Promise.resolve();
    expect(map.visibleSystems()).toContain(firstNeighbor);
    finishLod([target, nextNeighbor]);
    await changing;
    expect(map.visibleSystems()).not.toContain(firstNeighbor);
    expect(map.visibleSystems()).toContain(nextNeighbor);
    expect(map.visibleSystems()).toContain(target);
    map.destroy();
  });

  it("drives ED3DM through the source seam and filters generation kinds", async () => {
    const systems: System[] = [
      {
        name: "Sol",
        id64: "10477373803",
        coords: { x: 0, y: 0, z: 0 },
        generation: "authored",
      },
      {
        name: "ID64 1",
        id64: "1",
        coords: { x: 1, y: 0, z: 0 },
        generation: "ordinary",
      },
    ];
    const loadRegion = vi.fn(async (_request: GalaxyRegionRequest) => systems);
    const source: GalaxySource = {
      loadRegion,
      resolve: vi.fn(async () => systems[0]),
      suggest: vi.fn(async (): Promise<SystemSuggestion[]> => [
        { name: "Sol", id64: "10477373803", coords: systems[0]!.coords },
      ]),
      resolveDisplayName: vi.fn(async () => "Sol"),
      destroy: vi.fn(),
    };
    const map = await ED3DM.create({ container: document.body, source, lod: 20 });
    await map.flyTo("Sol");
    expect(map.visibleSystems()).toHaveLength(2);
    map.setFilter({ generations: ["authored"] });
    expect(map.visibleSystems().map((system) => system.name)).toEqual(["Sol"]);
    expect(await map.suggest("So")).toEqual([
      { name: "Sol", id64: "10477373803", coords: { x: 0, y: 0, z: 0 } },
    ]);
    await map.flyTo("Sol");
    const distance = Math.hypot(22, 14, 52);
    const residency = focusedResidencyRegion({ x: 0, y: 0, z: 0 }, distance);
    expect(loadRegion).toHaveBeenCalledWith(
      expect.objectContaining({
        center: residency.center,
        radiusLy: residency.radiusLy,
        cameraDistanceLy: distance,
      }),
      expect.any(AbortSignal),
    );
    map.destroy();
    expect(source.destroy).toHaveBeenCalledOnce();
  });

  it("keeps one complete local cache zone stable throughout the closest zoom range", () => {
    const near = focusedResidencyRegion({ x: 0, y: 0, z: 0 }, 58);
    const threshold = focusedResidencyRegion({ x: 0, y: 0, z: 0 }, 285);
    expect(near.maximum.x - near.minimum.x).toBe(640);
    expect(threshold.key).toBe(near.key);
  });
});
