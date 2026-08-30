import {
  GALAXY_SPATIAL_SELECTION_VERSION,
  GALAXY_SYSTEM_STRIDE_BYTES,
  STELLAR_SYSTEM_ATTRIBUTE_STRIDE_BYTES,
  STELLAR_TYPES,
  GalaxySystemFlags,
  StellarSystemAttributeFlags,
  galaxyViewTileKeyString,
} from "pege";
import type {
  GalaxyLoadProgress,
  GalaxyDetailProgressRange,
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
  PegeWorkerRequest,
  PegeWorkerResponse,
} from "./pege-protocol";
import { localEdgeScore, localEdgeWeight } from "./lod";
import { PEGE_OVERVIEW_CONFIG, pegeOverviewCacheId } from "./pege-overview";

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
): Promise<GalaxyOverview | undefined> {
  const database = await openOverviewCache();
  if (!database) return undefined;
  return new Promise<GalaxyOverview | undefined>((resolve) => {
    const request = database
      .transaction("galaxy", "readonly")
      .objectStore("galaxy")
      .get(pegeOverviewCacheId(runtimeUrl));
    request.onsuccess = () => resolve(request.result as GalaxyOverview | undefined);
    request.onerror = () => resolve(undefined);
  }).finally(() => database.close());
}

async function writeOverviewCache(
  runtimeUrl: string,
  overview: GalaxyOverview,
): Promise<void> {
  const database = await openOverviewCache();
  if (!database) return;
  await new Promise<void>((resolve) => {
    const transaction = database.transaction("galaxy", "readwrite");
    transaction
      .objectStore("galaxy")
      .put(overview, pegeOverviewCacheId(runtimeUrl));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
  database.close();
}

type GeneratePending = {
  kind: "generate";
  systems: System[];
  resolve: (overview: GalaxyOverview) => void;
  reject: (error: Error) => void;
  detachAbort?: () => void;
  detailProgressRange?: GalaxyDetailProgressRange;
};

type ValuePending = {
  kind: "value";
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  detachAbort?: () => void;
};

type TilePlan = Extract<PegeWorkerResponse, { type: "tile-plan" }>["tiles"];

type TilesPending = {
  kind: "tiles";
  plan: TilePlan;
  systemsByKey: Map<string, System[]>;
  resolve: (tiles: GalaxySpatialTile[]) => void;
  reject: (error: Error) => void;
  detachAbort?: () => void;
  detailProgressRange?: GalaxyDetailProgressRange;
};

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
  cameraDistanceLy: number,
  _lod: LodSetting,
): number[] {
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
                : distance >= 180
                  ? 1
                  : 0;
  return Array.from(
    { length: 8 - baseMinimum },
    (_, index) => baseMinimum + index,
  );
}

export function thresholdForView(
  cameraDistanceLy: number,
  lod: LodSetting,
): number {
  const [minimum = 7] = massCodesForView(cameraDistanceLy, 0);
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
  return cameraDistanceLy < 180 ? undefined : 2_048;
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

export class PegeGalaxySource implements GalaxySource {
  readonly #worker: Worker;
  readonly #queryWorker: Worker;
  readonly #runtimeUrl: string;
  readonly #onProgress?: (progress: GalaxyLoadProgress) => void;
  readonly #pending = new Map<number, Pending>();
  readonly #spatialTileCache = new Map<
    string,
    GalaxySpatialTile & { lastUsed: number }
  >();
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
      if (response.requestId === 0) return;
      this.#onProgress?.(
        response.phase === "detail"
          ? mapDetailProgress(
              response.completed,
              response.total,
              pending?.kind === "generate" || pending?.kind === "tiles"
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
        for (const system of unpackPegeBatch(response.batch)) {
          pending.systems.push(system);
        }
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
      });
      worker.postMessage({ ...message, requestId });
    });
  }

  #generateTiles(
    plan: TilePlan,
    signal?: AbortSignal,
    detailProgressRange?: GalaxyDetailProgressRange,
  ): Promise<GalaxySpatialTile[]> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (plan.length === 0) return Promise.resolve([]);
    const requestId = this.#nextRequestId++;
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
        resolve,
        reject,
        detachAbort: () => signal?.removeEventListener("abort", abort),
        detailProgressRange,
      });
      this.#worker.postMessage({
        type: "tiles",
        requestId,
        tiles: plan.map((tile) => ({
          key: tile.key,
          targetSystems: tile.targetSystems,
        })),
        selectionSeed: PEGE_OVERVIEW_CONFIG.selectionSeed,
        stellarLod: PEGE_OVERVIEW_CONFIG.stellarLod,
      } satisfies PegeWorkerRequest);
    });
  }

  #spatialTileCacheKey(tile: TilePlan[number]): string {
    return [
      "pege-tile",
      this.#runtimeUrl,
      `spatial-${GALAXY_SPATIAL_SELECTION_VERSION}`,
      tile.keyString,
      tile.targetSystems,
      PEGE_OVERVIEW_CONFIG.selectionSeed,
      PEGE_OVERVIEW_CONFIG.stellarLod.mode,
      PEGE_OVERVIEW_CONFIG.stellarLod.strength,
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
          selectionSeed: string;
          stellarLod: {
            mode: "presentation-balanced";
            strength: number;
          };
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
    },
    signal?: AbortSignal,
    detailProgressRange?: GalaxyDetailProgressRange,
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
      });
      this.#worker.postMessage({
        requestId,
        ...request,
      } satisfies PegeWorkerRequest);
    });
  }

  async loadOverview(
    _request: GalaxyOverviewRequest,
    signal?: AbortSignal,
  ): Promise<GalaxyOverview> {
    const cached = await readOverviewCache(this.#runtimeUrl);
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
        selectionSeed: PEGE_OVERVIEW_CONFIG.selectionSeed,
        stellarLod: PEGE_OVERVIEW_CONFIG.stellarLod,
      },
      signal,
    );
    if (!signal?.aborted) {
      this.#onProgress?.({ phase: "prepare", completed: 0, total: 1 });
      await writeOverviewCache(this.#runtimeUrl, overview);
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
    const generated = this.#generate(
      {
        type: "generate",
        minimumFixedXyz,
        maximumExclusiveFixedXyz,
        massCodes: massCodesForView(request.cameraDistanceLy, request.lod),
        threshold: thresholdForView(request.cameraDistanceLy, request.lod),
        // At broader zooms, sample a stable set of real boxels first so a
        // camera move cannot enqueue hundreds of thousands of full boxels.
        maximumBoxels: maximumBoxelsForView(request.cameraDistanceLy),
      },
      signal,
      request.detailProgressRange,
    );
    const radiusSquared = radius * radius;
    if (request.bounds) return generated.then(({ systems }) => systems);
    return generated.then(({ systems }) =>
      systems.filter((system) => {
        const dx = system.coords.x - request.center.x;
        const dy = system.coords.y - request.center.y;
        const dz = system.coords.z - request.center.z;
        const distanceSquared = dx * dx + dy * dy + dz * dz;
        if (distanceSquared > radiusSquared) return false;
        if (request.cameraDistanceLy < 180) return true;
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
    const plan = await this.#post<TilePlan>(
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
    );
    const resultByKey = new Map<string, GalaxySpatialTile>();
    const missing: TilePlan[number][] = [];
    const usedCacheKeys = new Set<string>();
    for (const tile of plan) {
      const cacheKey = this.#spatialTileCacheKey(tile);
      usedCacheKeys.add(cacheKey);
      const cached = this.#spatialTileCache.get(cacheKey);
      if (cached) {
        cached.lastUsed = ++this.#tileUseRevision;
        resultByKey.set(tile.keyString, cached);
      } else if (tile.targetSystems > 0) {
        missing.push(tile);
      } else {
        resultByKey.set(tile.keyString, {
          key: tile.keyString,
          tileKey: tile.key,
          targetSystems: 0,
          populationWeight: tile.populationWeight,
          systems: [],
        });
      }
    }
    this.#onProgress?.(
      mapDetailProgress(0, 1, request.detailProgressRange),
    );
    for (const tile of await this.#generateTiles(
      missing,
      signal,
      request.detailProgressRange,
    )) {
      const planned = plan.find((entry) => entry.keyString === tile.key)!;
      const cacheKey = this.#spatialTileCacheKey(planned);
      const cached = { ...tile, lastUsed: ++this.#tileUseRevision };
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
      .map((tile) => ({
        key: tile.key,
        tileKey: tile.tileKey,
        targetSystems: tile.targetSystems,
        populationWeight: tile.populationWeight,
        systems: tile.systems,
      }));
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
  }
}
