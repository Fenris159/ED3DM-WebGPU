import {
  GALAXY_SPATIAL_SELECTION_VERSION,
  GALAXY_DENSITY_TILE_VERSION,
  GALAXY_SYSTEM_STRIDE_BYTES,
  STELLAR_SYSTEM_ATTRIBUTE_STRIDE_BYTES,
  STELLAR_TYPES,
  GalaxySystemFlags,
  StellarSystemAttributeFlags,
  galaxyViewTileKeyString,
  type StellarLodPolicy,
} from "pege";
import type {
  GalaxyLoadProgress,
  GalaxyDetailProgressRange,
  GalaxyDensityCell,
  GalaxyOverview,
  GalaxyOverviewRequest,
  GalaxyRegionRequest,
  GalaxySource,
  GalaxySpatialTile,
  GalaxySpatialTileRequest,
  LodSetting,
  System,
  SystemLocationPreview,
  SystemSuggestion,
} from "./types";
import type {
  PackedSystemBatch,
  PackedDensityBatch,
  PegeWorkerRequest,
  PegeWorkerResponse,
} from "./pege-protocol";
import {
  FULL_DETAIL_CAMERA_DISTANCE_LY,
  localEdgeScore,
  localEdgeWeight,
} from "./lod";
import {
  PEGE_FILTERED_OVERVIEW_MAXIMUM_BOXELS,
  PEGE_OVERVIEW_CONFIG,
  pegeOverviewCacheId,
  pegeFilterUsesOnlyIndexedSpecialClasses,
  pegeStellarFilterKey,
  pegeStellarLodForTypes,
} from "./pege-overview";

function openOverviewCache(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === "undefined") return Promise.resolve(undefined);
  return new Promise<IDBDatabase | undefined>((resolve) => {
    const request = indexedDB.open("ed3dm-pege", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("galaxy")) {
        request.result.createObjectStore("galaxy");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
  });
}

async function readOverviewCache(
  runtimeUrl: string,
  stellarTypes?: readonly string[],
): Promise<GalaxyOverview | undefined> {
  const database = await openOverviewCache();
  if (!database) return undefined;
  return new Promise<GalaxyOverview | undefined>((resolve) => {
    const request = database
      .transaction("galaxy", "readonly")
      .objectStore("galaxy")
      .get(pegeOverviewCacheId(runtimeUrl, location.href, stellarTypes));
    request.onsuccess = () => resolve(request.result as GalaxyOverview | undefined);
    request.onerror = () => resolve(undefined);
  }).finally(() => database.close());
}

async function writeOverviewCache(
  runtimeUrl: string,
  overview: GalaxyOverview,
  stellarTypes?: readonly string[],
): Promise<void> {
  const database = await openOverviewCache();
  if (!database) return;
  await new Promise<void>((resolve) => {
    const transaction = database.transaction("galaxy", "readwrite");
    transaction
      .objectStore("galaxy")
      .put(overview, pegeOverviewCacheId(runtimeUrl, location.href, stellarTypes));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
  database.close();
}

type GeneratePending = {
  kind: "generate";
  systems: System[];
  onBatch?: (systems: readonly System[]) => void;
  resolve: (overview: GalaxyOverview) => void;
  reject: (error: Error) => void;
  detachAbort?: () => void;
  detailProgressRange?: GalaxyDetailProgressRange;
  suppressProgress?: boolean;
};

type ValuePending = {
  kind: "value";
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  detachAbort?: () => void;
  detailProgressRange?: GalaxyDetailProgressRange;
};

type TilePlan = Extract<PegeWorkerResponse, { type: "tile-plan" }>["tiles"];

function uniformTilePlan(
  keys: readonly GalaxySpatialTileRequest["keys"][number][],
  totalTargetSystems: number,
): TilePlan {
  if (keys.length === 0) return [];
  const total = Math.max(0, Math.floor(totalTargetSystems));
  const baseline = Math.floor(total / keys.length);
  const remainder = total % keys.length;
  return keys.map((key, index) => ({
    key,
    keyString: galaxyViewTileKeyString(key),
    targetSystems: baseline + Number(index < remainder),
    populationWeight: 1,
  }));
}

type TilesPending = {
  kind: "tiles";
  plan: TilePlan;
  systemsByKey: Map<string, System[]>;
  densityByKey: Map<string, GalaxyDensityCell[]>;
  resolve: (tiles: GalaxySpatialTile[]) => void;
  reject: (error: Error) => void;
  detachAbort?: () => void;
  detailProgressRange?: GalaxyDetailProgressRange;
  onPartialTiles?: (tiles: readonly GalaxySpatialTile[]) => void;
};

const DENSITY_TILE_SAMPLE_FRACTION = 0.2;
const DENSITY_TILE_VOXEL_RESOLUTION = 4;
export const PEGE_FILTERED_SPATIAL_MAXIMUM_BOXELS = 4_096;

export function filteredSpatialBoxelBudgets(
  plan: readonly { targetSystems: number }[],
  totalMaximum?: number,
): number[] {
  if (plan.length === 0) return [];
  const totalTargets = plan.reduce(
    (sum, tile) => sum + Math.max(0, tile.targetSystems),
    0,
  );
  const requestedMaximum = totalMaximum ?? Math.min(
    PEGE_FILTERED_SPATIAL_MAXIMUM_BOXELS,
    Math.max(256, Math.ceil(Math.sqrt(totalTargets) * 8)),
  );
  const maximum = Math.max(plan.length, Math.floor(requestedMaximum));
  const shares = plan.map((tile) =>
    totalTargets === 0
      ? maximum / plan.length
      : maximum * Math.max(0, tile.targetSystems) / totalTargets
  );
  const budgets = shares.map((share) => Math.max(1, Math.floor(share)));
  let remaining = maximum - budgets.reduce((sum, budget) => sum + budget, 0);
  for (const { index } of shares
    .map((share, index) => ({ index, remainder: share - Math.floor(share) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index)) {
    if (remaining <= 0) break;
    budgets[index]! += 1;
    remaining -= 1;
  }
  return budgets;
}

type Pending = GeneratePending | ValuePending | TilesPending;

type WorkerRequestWithoutId = PegeWorkerRequest extends infer Request
  ? Request extends { requestId: number }
    ? Omit<Request, "requestId">
    : never
  : never;

function asError(message: string): Error {
  return new Error(`PEGE: ${message}`);
}

function abortError(): Error {
  return new DOMException("PEGE region request aborted", "AbortError");
}

export function mapDetailProgress(
  completed: number,
  total: number | undefined,
  range: GalaxyDetailProgressRange | undefined,
): GalaxyLoadProgress {
  if (!range) return { phase: "detail", completed, total };
  const safeTotal = total && total > 0 ? total : 1;
  const ratio = Math.min(1, Math.max(0, completed / safeTotal));
  const start = Math.min(1, Math.max(0, range.start));
  const end = Math.min(1, Math.max(start, range.end));
  return {
    phase: "detail",
    completed: start + (end - start) * ratio,
    total: 1,
  };
}

function fieldValidation(
  flags: number,
  exact: StellarSystemAttributeFlags,
  estimated: StellarSystemAttributeFlags,
): "exact" | "observed" | "estimated" {
  if (flags & exact) return "exact";
  if (flags & estimated) return "estimated";
  return "observed";
}

export function massCodesForView(
  _cameraDistanceLy: number,
  _lod: LodSetting,
  requested?: readonly number[],
): number[] {
  if (requested?.length) {
    return [...new Set(requested)]
      .filter((code) => Number.isInteger(code) && code >= 0 && code <= 7)
      .sort((left, right) => left - right);
  }
  return [0, 1, 2, 3, 4, 5, 6, 7];
}

function detailLevelForDistance(cameraDistanceLy: number): number {
  const distance = Math.max(0, cameraDistanceLy);
  const baseMinimum =
    distance >= 30_000
      ? 7
      : distance >= 16_000
        ? 6
        : distance >= 8_000
          ? 5
          : distance >= 4_000
            ? 4
            : distance >= 1_600
              ? 3
              : distance >= 600
                ? 2
                : distance > FULL_DETAIL_CAMERA_DISTANCE_LY
                  ? 1
                  : 0;
  return baseMinimum;
}

export function thresholdForView(
  cameraDistanceLy: number,
  lod: LodSetting,
): number {
  const minimum = detailLevelForDistance(cameraDistanceLy);
  const maximumThreshold =
    [1, 0.03, 0.003, 0.0003, 0.00003, 0.00001, 0.000003, 0.000001][
      minimum
    ] ?? 0.000001;
  if (lod === "all" || minimum === 0) return maximumThreshold;
  const slider = Math.min(100, Math.max(0, lod)) / 100;
  const minimumThreshold = maximumThreshold * 0.1;
  return (
    minimumThreshold +
    (maximumThreshold - minimumThreshold) * slider ** 2
  );
}

export function maximumBoxelsForView(
  cameraDistanceLy: number,
): number | undefined {
  if (cameraDistanceLy <= FULL_DETAIL_CAMERA_DISTANCE_LY) return undefined;
  if (cameraDistanceLy <= 600) return 8;
  if (cameraDistanceLy <= 1_600) return 6;
  if (cameraDistanceLy <= 4_000) return 4;
  return 2;
}

export function unpackPegeBatch(batch: PackedSystemBatch): System[] {
  const view = new DataView(batch.records);
  const stellar = batch.stellarRecords
    ? new DataView(batch.stellarRecords)
    : undefined;
  const radii = batch.stellarRadii
    ? new Float32Array(batch.stellarRadii)
    : undefined;
  const count = batch.records.byteLength / GALAXY_SYSTEM_STRIDE_BYTES;
  const names = new Map(batch.names.map((entry) => [entry.systemIndex, entry.name]));
  const systems: System[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = index * GALAXY_SYSTEM_STRIDE_BYTES;
    const low = view.getUint32(offset, true);
    const high = view.getUint32(offset + 4, true);
    const address = (BigInt(high) << 32n) | BigInt(low);
    const flags = view.getUint32(offset + 20, true);
    const generation =
      flags & GalaxySystemFlags.Authored
        ? "authored"
        : flags & GalaxySystemFlags.Constrained
          ? "constrained"
          : "ordinary";
    const system: System = {
      name: names.get(index) ?? `ID64 ${address}`,
      id64: address.toString(),
      coords: {
        x: view.getInt32(offset + 8, true) / 32,
        y: view.getInt32(offset + 12, true) / 32,
        z: view.getInt32(offset + 16, true) / 32,
      },
      generation,
      massCode: Number(address & 7n),
      exactPosition: Boolean(flags & GalaxySystemFlags.ExactPosition),
    };
    if (stellar) {
      const stellarOffset = index * STELLAR_SYSTEM_ATTRIBUTE_STRIDE_BYTES;
      const classIndex = stellar.getUint32(stellarOffset, true);
      const stellarFlags = stellar.getUint32(stellarOffset + 12, true) & 0x00ff_ffff;
      if (stellarFlags & StellarSystemAttributeFlags.HasProfile) {
        const validation: NonNullable<System["stellarValidation"]> = {};
        if (classIndex < STELLAR_TYPES.length) {
          system.stellarType = STELLAR_TYPES[classIndex];
          validation.starType = fieldValidation(
            stellarFlags,
            StellarSystemAttributeFlags.ExactPrimaryClass,
            StellarSystemAttributeFlags.EstimatedPrimaryClass,
          );
        }
        const mass = stellar.getFloat32(stellarOffset + 16, true);
        const temperature = stellar.getFloat32(stellarOffset + 20, true);
        if (
          stellarFlags & StellarSystemAttributeFlags.HasPrimaryMass &&
          Number.isFinite(mass)
        ) {
          system.stellarMassSolar = mass;
          validation.mass = fieldValidation(
            stellarFlags,
            StellarSystemAttributeFlags.ExactPrimaryMass,
            StellarSystemAttributeFlags.EstimatedPrimaryMass,
          );
        }
        if (
          stellarFlags & StellarSystemAttributeFlags.HasPrimaryTemperature &&
          Number.isFinite(temperature)
        ) {
          system.stellarTemperatureKelvin = temperature;
          validation.temperature = fieldValidation(
            stellarFlags,
            StellarSystemAttributeFlags.ExactPrimaryTemperature,
            StellarSystemAttributeFlags.EstimatedPrimaryTemperature,
          );
        }
        const packedColor = stellar.getUint32(stellarOffset + 28, true);
        if (stellarFlags & StellarSystemAttributeFlags.HasDisplayColor) {
          const channel = (shift: number) =>
            ((packedColor >>> shift) & 0xff).toString(16).padStart(2, "0");
          system.stellarColor = `#${channel(0)}${channel(8)}${channel(16)}`;
          validation.displayColor = fieldValidation(
            stellarFlags,
            StellarSystemAttributeFlags.ExactDisplayColor,
            StellarSystemAttributeFlags.EstimatedDisplayColor,
          );
        }
        system.stellarValidation = validation;
        system.stellarProfileSource =
          generation === "authored"
            ? "compiled-catalogue"
            : "procedural-primary-model";
        system.stellarProfileValidation =
          validation.starType ??
          validation.displayColor ??
          validation.mass ??
          validation.temperature;
        system.stellarProfileComposition =
          stellarFlags & StellarSystemAttributeFlags.CompleteComposition
            ? "complete"
            : "partial";
      }
    }
    const radius = radii?.[index];
    if (radius !== undefined && Number.isFinite(radius)) {
      system.stellarRadiusMeters = radius;
      system.stellarValidation ??= {};
      system.stellarValidation.radius = fieldValidation(
        stellar ? stellar.getUint32(index * STELLAR_SYSTEM_ATTRIBUTE_STRIDE_BYTES + 12, true) : 0,
        StellarSystemAttributeFlags.ExactPrimaryRadius,
        StellarSystemAttributeFlags.EstimatedPrimaryRadius,
      );
    }
    systems.push(system);
  }
  return systems;
}

export function unpackPegeDensity(batch: PackedDensityBatch): GalaxyDensityCell[] {
  const centroids = new Float32Array(batch.centroidFixedXyz);
  const counts = new Uint32Array(batch.voxelSystemCounts);
  if (centroids.length !== counts.length * 3) {
    throw asError("density centroid and count buffers disagree");
  }
  return Array.from(counts, (genuineSystemCount, index) => ({
    coords: {
      x: centroids[index * 3]! / 32,
      y: centroids[index * 3 + 1]! / 32,
      z: centroids[index * 3 + 2]! / 32,
    },
    genuineSystemCount,
  }));
}

export class PegeGalaxySource implements GalaxySource {
  readonly #worker: Worker;
  readonly #queryWorker: Worker;
  readonly #runtimeUrl: string;
  readonly #onProgress?: (progress: GalaxyLoadProgress) => void;
  readonly #pending = new Map<number, Pending>();
  readonly #spatialTileCache = new Map<
    string,
    GalaxySpatialTile & { filterKey: string; lastUsed: number }
  >();
  #spatialCacheScope: string | undefined;
  #localRegionCache:
    | { key: string; systems: System[] }
    | undefined;
  #nextRequestId = 1;
  #tileUseRevision = 0;

  constructor(options: {
    runtimeUrl: string;
    worker?: Worker;
    queryWorker?: Worker;
    onProgress?: (progress: GalaxyLoadProgress) => void;
  }) {
    this.#runtimeUrl = options.runtimeUrl;
    this.#onProgress = options.onProgress;
    this.#worker =
      options.worker ??
      new Worker(new URL("./pege-worker.ts", import.meta.url), {
        type: "module",
        name: "pege-galaxy",
      });
    this.#queryWorker =
      options.queryWorker ??
      (options.worker
        ? this.#worker
        : new Worker(new URL("./pege-worker.ts", import.meta.url), {
            type: "module",
            name: "pege-query",
          }));
    this.#worker.addEventListener("message", this.#onMessage);
    if (this.#queryWorker !== this.#worker) {
      this.#queryWorker.addEventListener("message", this.#onMessage);
    }
    this.#worker.postMessage({
      type: "initialize",
      requestId: 0,
      runtimeUrl: options.runtimeUrl,
    } satisfies PegeWorkerRequest);
    if (this.#queryWorker !== this.#worker) {
      this.#queryWorker.postMessage({
        type: "initialize",
        requestId: 0,
        runtimeUrl: options.runtimeUrl,
        role: "query",
        prewarm: true,
      } satisfies PegeWorkerRequest);
    }
  }

  #onMessage = (event: MessageEvent<PegeWorkerResponse>) => {
    const response = event.data;
    const pending = this.#pending.get(response.requestId);
    if (response.type === "progress") {
      // Cancelled and superseded requests can still have queued worker
      // progress. Never let those orphan messages complete the active UI.
      if (response.requestId === 0 || !pending) return;
      if (pending.kind === "generate" && pending.suppressProgress) return;
      this.#onProgress?.(
        response.phase === "detail"
          ? mapDetailProgress(
              response.completed,
              response.total,
              pending.kind === "generate" || pending.kind === "tiles" ||
                  pending.kind === "value"
                ? pending.detailProgressRange
                : undefined,
            )
          : {
              phase: response.phase,
              completed: response.completed,
              total: response.total,
            },
      );
      return;
    }
    if (!pending) return;
    if (response.type === "batch") {
      if (pending.kind === "generate") {
        const batch = unpackPegeBatch(response.batch);
        for (const system of batch) {
          pending.systems.push(system);
        }
        pending.onBatch?.(batch);
      }
      return;
    }
    if (response.type === "tile-batch") {
      if (pending.kind !== "tiles") return;
      const systems = pending.systemsByKey.get(response.tileKeyString) ?? [];
      if (response.selectionOffset !== systems.length) {
        this.#pending.delete(response.requestId);
        pending.detachAbort?.();
        pending.reject(
          asError(
            `tile ${response.tileKeyString} resumed at ${response.selectionOffset}, expected ${systems.length}`,
          ),
        );
        return;
      }
      systems.push(...unpackPegeBatch(response.batch));
      pending.systemsByKey.set(response.tileKeyString, systems);
      pending.onPartialTiles?.(
        pending.plan.map((tile) => ({
          key: tile.keyString,
          tileKey: tile.key,
          targetSystems: tile.targetSystems,
          populationWeight: tile.populationWeight,
          systems: pending.systemsByKey.get(tile.keyString) ?? [],
          densityCells: pending.densityByKey.get(tile.keyString) ?? [],
        })),
      );
      return;
    }
    if (response.type === "tile-density") {
      if (pending.kind !== "tiles") return;
      pending.densityByKey.set(
        response.tileKeyString,
        unpackPegeDensity(response.density),
      );
      pending.onPartialTiles?.(
        pending.plan.map((tile) => ({
          key: tile.keyString,
          tileKey: tile.key,
          targetSystems: tile.targetSystems,
          populationWeight: tile.populationWeight,
          systems: pending.systemsByKey.get(tile.keyString) ?? [],
          densityCells: pending.densityByKey.get(tile.keyString) ?? [],
        })),
      );
      return;
    }
    if (response.type === "complete") {
      if (pending.kind === "generate") {
        this.#pending.delete(response.requestId);
        pending.detachAbort?.();
        pending.resolve({
          systems: pending.systems,
        });
      } else if (pending.kind === "tiles") {
        this.#pending.delete(response.requestId);
        pending.detachAbort?.();
        pending.resolve(
          pending.plan.map((tile) => ({
            key: tile.keyString,
            tileKey: tile.key,
            targetSystems: tile.targetSystems,
            populationWeight: tile.populationWeight,
            systems: pending.systemsByKey.get(tile.keyString) ?? [],
            densityCells: pending.densityByKey.get(tile.keyString) ?? [],
          })),
        );
      }
      return;
    }
    if (response.type === "cancelled") {
      this.#pending.delete(response.requestId);
      pending.detachAbort?.();
      pending.reject(abortError());
      return;
    }
    if (response.type === "error") {
      this.#pending.delete(response.requestId);
      pending.detachAbort?.();
      pending.reject(asError(response.message));
      return;
    }
    this.#pending.delete(response.requestId);
    pending.detachAbort?.();
    if (pending.kind !== "value") return;
    if (response.type === "tile-plan") {
      pending.resolve(response.tiles);
    } else if (response.type === "resolved") {
      pending.resolve(
        response.system
          ? {
              ...response.system,
              name: response.system.name ?? `ID64 ${response.system.id64}`,
            }
          : undefined,
      );
    } else if (response.type === "suggestions") {
      pending.resolve(response.suggestions);
    } else if (response.type === "previews") {
      pending.resolve(response.previews);
    } else if (response.type === "display-name") {
      pending.resolve(response.name);
    }
  };

  #post<T>(
    message: WorkerRequestWithoutId,
    signal?: AbortSignal,
    worker = this.#worker,
    detailProgressRange?: GalaxyDetailProgressRange,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    const requestId = this.#nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        worker.postMessage({ type: "cancel", requestId });
        const pending = this.#pending.get(requestId);
        if (pending?.kind !== "value") return;
        this.#pending.delete(requestId);
        pending.detachAbort?.();
        pending.reject(abortError());
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(requestId, {
        kind: "value",
        resolve: (value) => resolve(value as T),
        reject,
        detachAbort: () => signal?.removeEventListener("abort", abort),
        detailProgressRange,
      });
      worker.postMessage({ ...message, requestId });
    });
  }

  #generateTiles(
    plan: TilePlan,
    stellarLod: StellarLodPolicy,
    attributes: "spatial-primary-render" | "spatial-overview-estimate",
    sourceMassCodes?: readonly number[],
    signal?: AbortSignal,
    detailProgressRange?: GalaxyDetailProgressRange,
    includeNames = false,
    onPartialTiles?: (tiles: readonly GalaxySpatialTile[]) => void,
  ): Promise<GalaxySpatialTile[]> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (plan.length === 0) return Promise.resolve([]);
    const requestId = this.#nextRequestId++;
    const filteredBoxelBudgets = stellarLod.mode === "class-weighted"
      ? filteredSpatialBoxelBudgets(plan)
      : undefined;
    return new Promise<GalaxySpatialTile[]>((resolve, reject) => {
      const abort = () => {
        this.#worker.postMessage({ type: "cancel", requestId });
        const pending = this.#pending.get(requestId);
        if (pending?.kind !== "tiles") return;
        this.#pending.delete(requestId);
        pending.detachAbort?.();
        pending.reject(abortError());
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(requestId, {
        kind: "tiles",
        plan,
        systemsByKey: new Map(),
        densityByKey: new Map(),
        resolve,
        reject,
        detachAbort: () => signal?.removeEventListener("abort", abort),
        detailProgressRange,
        onPartialTiles,
      });
      this.#worker.postMessage({
        type: "tiles",
        requestId,
        attributes,
        tiles: plan.map((tile, index) => ({
          key: tile.key,
          targetSystems: tile.targetSystems,
          sampleTargetSystems: Math.min(
            tile.targetSystems,
            Math.max(1, Math.ceil(tile.targetSystems * DENSITY_TILE_SAMPLE_FRACTION)),
          ),
          voxelResolution: DENSITY_TILE_VOXEL_RESOLUTION,
          ...(filteredBoxelBudgets === undefined
            ? {}
            : { maximumBoxelsVisited: filteredBoxelBudgets[index]! }),
        })),
        selectionSeed: PEGE_OVERVIEW_CONFIG.selectionSeed,
        stellarLod,
        ...(sourceMassCodes === undefined ? {} : { massCodes: sourceMassCodes }),
        includeNames,
      } satisfies PegeWorkerRequest);
    });
  }

  #spatialTileCacheKey(tile: TilePlan[number], filterKey: string): string {
    return [
      "pege-tile",
      this.#runtimeUrl,
      `spatial-${GALAXY_SPATIAL_SELECTION_VERSION}`,
      `density-${GALAXY_DENSITY_TILE_VERSION}`,
      tile.keyString,
      tile.targetSystems,
      PEGE_OVERVIEW_CONFIG.selectionSeed,
      filterKey,
    ].join(":");
  }

  #trimSpatialTileCache(keep: ReadonlySet<string>) {
    const maximumSystems = 100_000;
    let retainedSystems = [...this.#spatialTileCache.values()].reduce(
      (total, tile) => total + tile.systems.length,
      0,
    );
    if (retainedSystems <= maximumSystems) return;
    const candidates = [...this.#spatialTileCache.entries()]
      .filter(([cacheKey]) => !keep.has(cacheKey))
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    for (const [cacheKey, tile] of candidates) {
      this.#spatialTileCache.delete(cacheKey);
      retainedSystems -= tile.systems.length;
      if (retainedSystems <= maximumSystems) break;
    }
  }

  #generate(
    request:
      | {
          type: "overview";
          minimumFixedXyz: readonly [number, number, number];
          maximumExclusiveFixedXyz: readonly [number, number, number];
          targetSystems: number;
          massCodes?: readonly number[];
          selectionSeed: string;
          maximumBoxelsVisited?: number;
          stellarLod: StellarLodPolicy;
        }
      | { type: "warm" }
      | {
      type: "generate";
      minimumFixedXyz: readonly [number, number, number];
      maximumExclusiveFixedXyz: readonly [number, number, number];
      massCodes: readonly number[];
      threshold: number;
      maximumBoxels?: number;
      yieldEveryBoxels?: number;
      includeNames?: boolean;
    },
    signal?: AbortSignal,
    detailProgressRange?: GalaxyDetailProgressRange,
    onBatch?: (systems: readonly System[]) => void,
    suppressProgress?: boolean,
  ): Promise<GalaxyOverview> {
    if (signal?.aborted) return Promise.reject(abortError());
    const requestId = this.#nextRequestId++;
    return new Promise<GalaxyOverview>((resolve, reject) => {
      const abort = () => {
        this.#worker.postMessage({ type: "cancel", requestId });
        const pending = this.#pending.get(requestId);
        if (pending?.kind !== "generate") return;
        this.#pending.delete(requestId);
        pending.detachAbort?.();
        pending.reject(abortError());
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(requestId, {
        kind: "generate",
        systems: [],
        resolve,
        reject,
        detachAbort: () => signal?.removeEventListener("abort", abort),
        detailProgressRange,
        onBatch,
        suppressProgress,
      });
      this.#worker.postMessage({
        requestId,
        ...request,
      } satisfies PegeWorkerRequest);
    });
  }

  async loadOverview(
    request: GalaxyOverviewRequest,
    signal?: AbortSignal,
  ): Promise<GalaxyOverview> {
    const cached = await readOverviewCache(this.#runtimeUrl, request.stellarTypes);
    if (cached) {
      await this.#generate({ type: "warm" }, signal);
      return cached;
    }
    const overview = await this.#generate(
      {
        type: "overview",
        minimumFixedXyz: PEGE_OVERVIEW_CONFIG.minimumFixedXyz,
        maximumExclusiveFixedXyz: PEGE_OVERVIEW_CONFIG.maximumExclusiveFixedXyz,
        targetSystems: PEGE_OVERVIEW_CONFIG.targetSystems,
        ...(request.stellarTypes?.length
          ? { maximumBoxelsVisited: PEGE_FILTERED_OVERVIEW_MAXIMUM_BOXELS }
          : {}),
        selectionSeed: PEGE_OVERVIEW_CONFIG.selectionSeed,
        stellarLod: pegeStellarLodForTypes(request.stellarTypes),
      },
      signal,
    );
    if (!signal?.aborted) {
      this.#onProgress?.({ phase: "prepare", completed: 0, total: 1 });
      await writeOverviewCache(this.#runtimeUrl, overview, request.stellarTypes);
      this.#onProgress?.({ phase: "prepare", completed: 1, total: 1 });
    }
    return overview;
  }

  loadRegion(
    request: GalaxyRegionRequest,
    signal?: AbortSignal,
  ): Promise<System[]> {
    const radius = Math.max(10, request.radiusLy);
    const minimum = request.bounds?.minimum ?? {
      x: request.center.x - radius,
      y: request.center.y - radius,
      z: request.center.z - radius,
    };
    const maximum = request.bounds?.maximum ?? {
      x: request.center.x + radius,
      y: request.center.y + radius,
      z: request.center.z + radius,
    };
    const minimumFixedXyz = [
      Math.floor(minimum.x * 32),
      Math.floor(minimum.y * 32),
      Math.floor(minimum.z * 32),
    ] as const;
    const maximumExclusiveFixedXyz = [
      Math.ceil(maximum.x * 32),
      Math.ceil(maximum.y * 32),
      Math.ceil(maximum.z * 32),
    ] as const;
    const massCodes = massCodesForView(
      request.cameraDistanceLy,
      request.lod,
      request.massCodes,
    );
    const threshold = thresholdForView(request.cameraDistanceLy, request.lod);
    const maximumBoxels = maximumBoxelsForView(request.cameraDistanceLy);
    const cacheKey = [
      minimumFixedXyz.join(","),
      maximumExclusiveFixedXyz.join(","),
      massCodes.join(","),
      threshold,
      maximumBoxels ?? "all",
      request.includeNames ? "names" : "points",
    ].join(":");
    const cachedSystems = this.#localRegionCache?.key === cacheKey
      ? this.#localRegionCache.systems
      : undefined;
    const matchesRequestedClass = (system: System) =>
      !request.stellarTypes?.length ||
      (system.stellarType !== undefined && request.stellarTypes.includes(system.stellarType));
    const generated = cachedSystems
      ? Promise.resolve({ systems: cachedSystems })
      : this.#generate(
          {
            type: "generate",
            minimumFixedXyz,
            maximumExclusiveFixedXyz,
            massCodes,
            threshold,
            // At broader zooms, sample a stable set of real boxels first so a
            // camera move cannot enqueue hundreds of thousands of full boxels.
            maximumBoxels,
            includeNames: request.includeNames,
          },
          signal,
          request.detailProgressRange,
          request.onPartialSystems
            ? (systems) => {
                const matching = systems.filter(matchesRequestedClass);
                if (matching.length) request.onPartialSystems!(matching);
              }
            : undefined,
          request.suppressProgress,
        ).then((overview) => {
          this.#localRegionCache = { key: cacheKey, systems: overview.systems };
          return overview;
        });
    const radiusSquared = radius * radius;
    if (request.bounds) {
      return generated.then(({ systems }) => systems.filter(matchesRequestedClass));
    }
    return generated.then(({ systems }) =>
      systems.filter((system) => {
        if (!matchesRequestedClass(system)) return false;
        const dx = system.coords.x - request.center.x;
        const dy = system.coords.y - request.center.y;
        const dz = system.coords.z - request.center.z;
        const distanceSquared = dx * dx + dy * dy + dz * dz;
        if (distanceSquared > radiusSquared) return false;
        if (request.cameraDistanceLy <= FULL_DETAIL_CAMERA_DISTANCE_LY) return true;
        const edgeWeight = localEdgeWeight(
          Math.sqrt(distanceSquared) / radius,
        );
        if (edgeWeight >= 1 || system.id64 === undefined) return true;
        const address = BigInt(system.id64);
        return (
          localEdgeScore(
            Number(address & 0xffff_ffffn),
            Number((address >> 32n) & 0xffff_ffffn),
          ) < edgeWeight
        );
      }),
    );
  }

  async loadSpatialTiles(
    request: GalaxySpatialTileRequest,
    signal?: AbortSignal,
  ): Promise<GalaxySpatialTile[]> {
    if (request.keys.length === 0 || request.totalTargetSystems <= 0) return [];
    if (
      request.cacheScope !== undefined &&
      request.cacheScope !== this.#spatialCacheScope
    ) {
      this.#spatialTileCache.clear();
      this.#spatialCacheScope = request.cacheScope;
    }
    this.#onProgress?.(
      mapDetailProgress(0, 1, request.detailProgressRange),
    );
    const massCodes = massCodesForView(0, 0, request.massCodes);
    const hasMassCodeFilter = Boolean(request.massCodes?.length);
    // Stellar class and boxel mass code are independent filters. PEGE must
    // inspect every source mass code unless the caller explicitly selected a
    // mass-code subset; inferring one from a stellar type drops valid systems.
    const sourceMassCodes = hasMassCodeFilter ? massCodes : undefined;
    if (sourceMassCodes?.length === 0) {
      const empty = uniformTilePlan(request.keys, request.totalTargetSystems).map(
        (tile) => ({
          key: tile.keyString,
          tileKey: tile.key,
          targetSystems: tile.targetSystems,
          populationWeight: tile.populationWeight,
          systems: [],
          densityCells: [],
        }),
      );
      request.onPartialTiles?.(empty);
      this.#onProgress?.(mapDetailProgress(1, 1, request.detailProgressRange));
      return empty;
    }
    const indexedSpecialOnly = pegeFilterUsesOnlyIndexedSpecialClasses(
      request.stellarTypes,
    );
    // Filtered local detail must use the same canonical classification as
    // selected-System profiles. Presentation-only overview estimates would
    // create points that disappear when the user approaches them.
    const attributes = "spatial-primary-render" as const;
    const filterKey = [
      pegeStellarFilterKey(request.stellarTypes),
      `attributes:${attributes}`,
      `mass:${hasMassCodeFilter ? massCodes.join(",") : "all"}`,
      request.includeNames ? "names" : "points",
    ].join("|");
    const stellarLod = pegeStellarLodForTypes(request.stellarTypes);
    const planProgressRange = request.detailProgressRange
      ? {
          start: request.detailProgressRange.start,
          end: request.detailProgressRange.start +
            (request.detailProgressRange.end - request.detailProgressRange.start) * 0.1,
        }
      : undefined;
    const tileProgressRange = request.detailProgressRange
      ? {
          start: planProgressRange!.end,
          end: request.detailProgressRange.end,
        }
      : undefined;
    const plan = indexedSpecialOnly
      ? uniformTilePlan(request.keys, request.totalTargetSystems)
      : await this.#post<TilePlan>(
          {
            type: "plan-tiles",
            keys: request.keys,
            totalTargetSystems: request.totalTargetSystems,
            ...(request.keyWeights
              ? {
                  keyWeights: request.keys.map((key) =>
                    request.keyWeights!.find(
                      (entry) =>
                        galaxyViewTileKeyString(entry.key) ===
                        galaxyViewTileKeyString(key),
                    )?.weight ?? 1,
                  ),
                }
              : {}),
          },
          signal,
          this.#worker,
          planProgressRange,
        );
    if (indexedSpecialOnly && planProgressRange) {
      this.#onProgress?.(mapDetailProgress(1, 1, planProgressRange));
    }
    const resultByKey = new Map<string, GalaxySpatialTile>();
    const missing: TilePlan[number][] = [];
    const usedCacheKeys = new Set<string>();
    for (const tile of plan) {
      const cacheKey = this.#spatialTileCacheKey(tile, filterKey);
      let cachedKey = cacheKey;
      let cached = this.#spatialTileCache.get(cacheKey);
      for (const [candidateKey, candidate] of this.#spatialTileCache) {
        if (
          candidate.key === tile.keyString &&
          candidate.filterKey === filterKey &&
          candidate.targetSystems >= tile.targetSystems &&
          (!cached || candidate.targetSystems > cached.targetSystems)
        ) {
          cachedKey = candidateKey;
          cached = candidate;
        }
      }
      if (cached) {
        usedCacheKeys.add(cachedKey);
        cached.lastUsed = ++this.#tileUseRevision;
        resultByKey.set(tile.keyString, cached);
      } else if (tile.targetSystems > 0) {
        usedCacheKeys.add(cacheKey);
        missing.push(tile);
      } else {
        resultByKey.set(tile.keyString, {
          key: tile.keyString,
          tileKey: tile.key,
          targetSystems: 0,
          populationWeight: tile.populationWeight,
          systems: [],
          densityCells: [],
        });
      }
    }
    const presentTiles = (tiles: GalaxySpatialTile[]) => tiles.map((tile) => ({
      key: tile.key,
      tileKey: tile.tileKey,
      targetSystems: tile.targetSystems,
      populationWeight: tile.populationWeight,
      systems: hasMassCodeFilter
        ? tile.systems.filter(
            (system) =>
              system.massCode !== undefined && massCodes.includes(system.massCode),
          )
        : tile.systems,
      // Density voxels do not yet retain a mass-code histogram. Omitting them
      // is more accurate than showing all-population glow for a selected slice.
      densityCells: hasMassCodeFilter ? [] : tile.densityCells,
    }));
    request.onPartialTiles?.(
      presentTiles(
        plan
          .map((tile) => resultByKey.get(tile.keyString))
          .filter((tile): tile is GalaxySpatialTile => tile !== undefined),
      ),
    );
    for (const tile of await this.#generateTiles(
      missing,
      stellarLod,
      attributes,
      sourceMassCodes,
      signal,
      tileProgressRange,
      request.includeNames,
      request.onPartialTiles
        ? (tiles) => {
            for (const tile of tiles) resultByKey.set(tile.key, tile);
            request.onPartialTiles!(
              presentTiles(
                plan
                  .map((entry) => resultByKey.get(entry.keyString))
                  .filter(
                    (tile): tile is GalaxySpatialTile => tile !== undefined,
                  ),
              ),
            );
          }
        : undefined,
    )) {
      const planned = plan.find((entry) => entry.keyString === tile.key)!;
      const cacheKey = this.#spatialTileCacheKey(planned, filterKey);
      const cached = {
        ...tile,
        filterKey,
        lastUsed: ++this.#tileUseRevision,
      };
      this.#spatialTileCache.set(cacheKey, cached);
      resultByKey.set(tile.key, cached);
    }
    this.#trimSpatialTileCache(usedCacheKeys);
    this.#onProgress?.(
      mapDetailProgress(1, 1, request.detailProgressRange),
    );
    return plan
      .map((tile) => resultByKey.get(tile.keyString))
      .filter((tile): tile is GalaxySpatialTile => tile !== undefined)
      .map((tile) => presentTiles([tile])[0]!);
  }

  resolve(query: string): Promise<System | undefined> {
    return this.#post<System | undefined>(
      { type: "resolve", query },
      undefined,
      this.#queryWorker,
    );
  }

  preview(query: string): Promise<SystemLocationPreview[]> {
    return this.#post<SystemLocationPreview[]>(
      { type: "preview", query },
      undefined,
      this.#queryWorker,
    );
  }

  suggest(query: string, limit = 10): Promise<SystemSuggestion[]> {
    return this.#post<SystemSuggestion[]>(
      {
        type: "suggest",
        query,
        limit: Math.min(100, Math.max(1, limit)),
      },
      undefined,
      this.#queryWorker,
    );
  }

  resolveDisplayName(id64: string): Promise<string | undefined> {
    return this.#post<string | undefined>(
      { type: "display-name", id64 },
      undefined,
      this.#queryWorker,
    );
  }

  destroy() {
    this.#worker.removeEventListener("message", this.#onMessage);
    this.#worker.terminate();
    if (this.#queryWorker !== this.#worker) {
      this.#queryWorker.removeEventListener("message", this.#onMessage);
      this.#queryWorker.terminate();
    }
    for (const pending of this.#pending.values()) {
      pending.reject(asError("source destroyed"));
    }
    this.#pending.clear();
    this.#spatialTileCache.clear();
    this.#localRegionCache = undefined;
    this.#spatialCacheScope = undefined;
  }
}
