import {
  GALAXY_SYSTEM_STRIDE_BYTES,
  STELLAR_SYSTEM_ATTRIBUTE_STRIDE_BYTES,
  Pege,
  decodeGalaxyRuntimeData,
  enumerateGalaxyBoxels,
  estimateGalaxyViewTilePopulation,
  galaxyViewTileKeyString,
  packGalaxyBoxel,
  packGalaxyBoxelSelection,
  recommendGalaxyViewTileTargets,
  streamPackedGalaxyDensityTilesAsync,
  streamPackedGalaxyTilesAsync,
  streamPackedGalaxyViewAsync,
  type GalaxyEngineDataset,
  type PackedGalaxyDensityTile,
  type StellarComponent,
} from "pege";
import type {
  PackedSystemBatch,
  PackedDensityBatch,
  PegeWorkerRequest,
  PegeWorkerResponse,
  ResolvedPegeSystem,
} from "./pege-protocol";
import type { SystemLocationPreview, SystemSuggestion } from "./types";
import {
  boundedLocalSamplePlan,
  localBoxelScore,
  lodScore,
} from "./lod";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<PegeWorkerRequest>) => void) | null;
  postMessage(message: PegeWorkerResponse, transfer?: Transferable[]): void;
};

let enginePromise: Promise<Pege> | undefined;
let runtimeUrl: string | undefined;
let workerRole: "galaxy" | "query" = "galaxy";
const active = new Map<number, AbortController>();

const PEGE_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const PEGE_CACHE_TRIM_BYTES = 96 * 1024 * 1024;
const PEGE_QUERY_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const PEGE_QUERY_CACHE_TRIM_BYTES = 8 * 1024 * 1024;
const PEGE_STREAM_CHUNK_BYTES = 4 * 1024 * 1024;
const PEGE_OVERVIEW_CHUNK_BYTES = 256 * 1024;
function createEngine(dataset: GalaxyEngineDataset): Pege {
  const queryWorker = workerRole === "query";
  return new Pege(dataset, {
    cache: {
      maxBytes: queryWorker ? PEGE_QUERY_CACHE_MAX_BYTES : PEGE_CACHE_MAX_BYTES,
      trimToBytes: queryWorker
        ? PEGE_QUERY_CACHE_TRIM_BYTES
        : PEGE_CACHE_TRIM_BYTES,
    },
  });
}

async function fetchRuntime(requestId: number): Promise<ArrayBuffer> {
  if (!runtimeUrl) throw new Error("PEGE runtime URL was not initialized");
  const response = await fetch(runtimeUrl, { cache: "force-cache" });
  if (!response.ok) {
    throw new Error(`PEGE runtime request failed (${response.status})`);
  }
  const total = Number(response.headers.get("content-length")) || undefined;
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    respond({
      type: "progress",
      requestId,
      phase: "download",
      completed: buffer.byteLength,
      total: total ?? buffer.byteLength,
    });
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let completed = 0;
  let lastReported = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
    completed += result.value.byteLength;
    if (completed - lastReported >= 512 * 1024 || completed === total) {
      respond({ type: "progress", requestId, phase: "download", completed, total });
      lastReported = completed;
    }
  }
  const bytes = new Uint8Array(completed);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

function engine(requestId: number): Promise<Pege> {
  if (!enginePromise) {
    enginePromise = fetchRuntime(requestId).then((buffer) => {
      respond({ type: "progress", requestId, phase: "decode", completed: 0, total: 1 });
      const dataset = decodeGalaxyRuntimeData(buffer);
      const pege = createEngine(dataset);
      respond({ type: "progress", requestId, phase: "decode", completed: 1, total: 1 });
      return pege;
    });
  }
  return enginePromise;
}

function respond(message: PegeWorkerResponse, transfer?: Transferable[]) {
  scope.postMessage(message, transfer);
}

function packedBatchTransfers(batch: PackedSystemBatch): Transferable[] {
  const transfers: Transferable[] = [batch.records];
  if (batch.stellarRecords) transfers.push(batch.stellarRecords);
  if (batch.stellarRadii) transfers.push(batch.stellarRadii);
  return transfers;
}

function packedDensityTransfers(batch: PackedDensityBatch): Transferable[] {
  return [batch.centroidFixedXyz, batch.voxelSystemCounts];
}

type PackedDisplayNameResolver = {
  displayNameForResolvedSystem(
    systemAddress: bigint,
    starPosXyz: readonly [number, number, number],
  ): { status: "resolved"; name: string } | { status: "unknown" };
};

/** Attach final authored or procedural names without resolving each boxel again. */
export function populatePackedDisplayNames(
  pege: PackedDisplayNameResolver,
  batch: PackedSystemBatch,
): PackedSystemBatch {
  const count = batch.records.byteLength / GALAXY_SYSTEM_STRIDE_BYTES;
  if (batch.names.length === count) return batch;
  const names = [...batch.names];
  const named = new Set(names.map(({ systemIndex }) => systemIndex));
  const view = new DataView(batch.records);
  for (let systemIndex = 0; systemIndex < count; systemIndex += 1) {
    if (named.has(systemIndex)) continue;
    const offset = systemIndex * GALAXY_SYSTEM_STRIDE_BYTES;
    const address =
      (BigInt(view.getUint32(offset + 4, true)) << 32n) |
      BigInt(view.getUint32(offset, true));
    const display = pege.displayNameForResolvedSystem(address, [
      view.getInt32(offset + 8, true) / 32,
      view.getInt32(offset + 12, true) / 32,
      view.getInt32(offset + 16, true) / 32,
    ]);
    if (display.status === "resolved") {
      names.push({ systemIndex, name: display.name });
    }
  }
  names.sort((left, right) => left.systemIndex - right.systemIndex);
  return { ...batch, names };
}

export function combinePackedBatches(batches: readonly PackedSystemBatch[]): PackedSystemBatch {
  const byteLength = batches.reduce((sum, batch) => sum + batch.records.byteLength, 0);
  const records = new ArrayBuffer(byteLength);
  const bytes = new Uint8Array(records);
  const names: { systemIndex: number; name: string }[] = [];
  let byteOffset = 0;
  let systemOffset = 0;
  const stellarRecords = batches.some((batch) => batch.stellarRecords)
    ? new ArrayBuffer(
        batches.reduce(
          (sum, batch) => sum + (batch.stellarRecords?.byteLength ?? 0),
          0,
        ),
      )
    : undefined;
  const stellarBytes = stellarRecords ? new Uint8Array(stellarRecords) : undefined;
  const stellarRadii = batches.some((batch) => batch.stellarRadii)
    ? new ArrayBuffer(
        batches.reduce(
          (sum, batch) => sum + (batch.stellarRadii?.byteLength ?? 0),
          0,
        ),
      )
    : undefined;
  const radiusBytes = stellarRadii ? new Uint8Array(stellarRadii) : undefined;
  let stellarOffset = 0;
  let radiusOffset = 0;
  for (const batch of batches) {
    bytes.set(new Uint8Array(batch.records), byteOffset);
    for (const entry of batch.names) {
      names.push({ systemIndex: systemOffset + entry.systemIndex, name: entry.name });
    }
    byteOffset += batch.records.byteLength;
    systemOffset += batch.records.byteLength / GALAXY_SYSTEM_STRIDE_BYTES;
    if (stellarBytes && batch.stellarRecords) {
      stellarBytes.set(new Uint8Array(batch.stellarRecords), stellarOffset);
      stellarOffset += batch.stellarRecords.byteLength;
    }
    if (radiusBytes && batch.stellarRadii) {
      radiusBytes.set(new Uint8Array(batch.stellarRadii), radiusOffset);
      radiusOffset += batch.stellarRadii.byteLength;
    }
  }
  return { records, names, stellarRecords, stellarRadii };
}

function selectPackedRecords(
  records: ArrayBuffer,
  names: readonly { systemIndex: number; name: string }[],
  kept: readonly number[],
  stellarRecords?: ArrayBuffer,
  stellarRadii?: ArrayBuffer,
): PackedSystemBatch {
  const sourceCount = records.byteLength / GALAXY_SYSTEM_STRIDE_BYTES;
  if (
    stellarRecords !== undefined &&
    stellarRecords.byteLength !== sourceCount * STELLAR_SYSTEM_ATTRIBUTE_STRIDE_BYTES
  ) {
    throw new RangeError("stellar records must align with spatial records");
  }
  if (
    stellarRadii !== undefined &&
    stellarRadii.byteLength !== sourceCount * Float32Array.BYTES_PER_ELEMENT
  ) {
    throw new RangeError("stellar radii must align with spatial records");
  }
  if (
    kept.length === sourceCount &&
    kept.every((sourceIndex, outputIndex) => sourceIndex === outputIndex)
  ) {
    return { records, names, stellarRecords, stellarRadii };
  }

  const copyAligned = (
    source: ArrayBuffer | undefined,
    strideBytes: number,
  ): ArrayBuffer | undefined => {
    if (!source) return undefined;
    const output = new ArrayBuffer(kept.length * strideBytes);
    const sourceBytes = new Uint8Array(source);
    const outputBytes = new Uint8Array(output);
    kept.forEach((sourceIndex, outputIndex) => {
      const sourceOffset = sourceIndex * strideBytes;
      outputBytes.set(
        sourceBytes.subarray(sourceOffset, sourceOffset + strideBytes),
        outputIndex * strideBytes,
      );
    });
    return output;
  };

  const remap = new Map<number, number>();
  if (names.length > 0) {
    kept.forEach((sourceIndex, outputIndex) => remap.set(sourceIndex, outputIndex));
  }
  return {
    records: copyAligned(records, GALAXY_SYSTEM_STRIDE_BYTES)!,
    names: names.flatMap((entry) => {
      const systemIndex = remap.get(entry.systemIndex);
      return systemIndex === undefined ? [] : [{ systemIndex, name: entry.name }];
    }),
    stellarRecords: copyAligned(
      stellarRecords,
      STELLAR_SYSTEM_ATTRIBUTE_STRIDE_BYTES,
    ),
    stellarRadii: copyAligned(
      stellarRadii,
      Float32Array.BYTES_PER_ELEMENT,
    ),
  };
}

export function thinPackedBatch(
  records: ArrayBuffer,
  names: readonly { systemIndex: number; name: string }[],
  threshold: number,
  minimumFixedXyz?: readonly [number, number, number],
  maximumExclusiveFixedXyz?: readonly [number, number, number],
  stellarRecords?: ArrayBuffer,
  stellarRadii?: ArrayBuffer,
): PackedSystemBatch {
  // PEGE yields complete intersecting boxels. Clip their records to the exact
  // request before transferring or expanding them into main-thread objects.
  const kept = retainedPackedRecordIndices(
    records,
    threshold,
    minimumFixedXyz,
    maximumExclusiveFixedXyz,
  );
  return selectPackedRecords(
    records,
    names,
    kept,
    stellarRecords,
    stellarRadii,
  );
}

function retainedPackedRecordIndices(
  records: ArrayBuffer,
  threshold: number,
  minimumFixedXyz?: readonly [number, number, number],
  maximumExclusiveFixedXyz?: readonly [number, number, number],
): number[] {
  const source = new DataView(records);
  const sourceCount = records.byteLength / GALAXY_SYSTEM_STRIDE_BYTES;
  const kept: number[] = [];
  for (let index = 0; index < sourceCount; index += 1) {
    const offset = index * GALAXY_SYSTEM_STRIDE_BYTES;
    if (minimumFixedXyz && maximumExclusiveFixedXyz) {
      const x = source.getInt32(offset + 8, true);
      const y = source.getInt32(offset + 12, true);
      const z = source.getInt32(offset + 16, true);
      if (
        x < minimumFixedXyz[0] ||
        x >= maximumExclusiveFixedXyz[0] ||
        y < minimumFixedXyz[1] ||
        y >= maximumExclusiveFixedXyz[1] ||
        z < minimumFixedXyz[2] ||
        z >= maximumExclusiveFixedXyz[2]
      ) {
        continue;
      }
    }
    const low = source.getUint32(offset, true);
    const high = source.getUint32(offset + 4, true);
    if (threshold >= 1 || lodScore(low, high) < threshold) kept.push(index);
  }
  return kept;
}

export function packFilteredGalaxyBoxel(
  pege: Pege,
  boxel: ReturnType<Pege["generateBoxel"]>,
  threshold: number,
  minimumFixedXyz: readonly [number, number, number],
  maximumExclusiveFixedXyz: readonly [number, number, number],
): PackedSystemBatch {
  // Local requests usually intersect only a small portion of a populous
  // source boxel. Resolve expensive stellar profiles only for records that
  // survive exact clipping and LOD selection.
  const unpackedSpatial = packGalaxyBoxel(boxel);
  const kept = retainedPackedRecordIndices(
    unpackedSpatial.records,
    threshold,
    minimumFixedXyz,
    maximumExclusiveFixedXyz,
  );
  const spatial = packGalaxyBoxelSelection(boxel, kept);
  const stellar = pege.packBoxelStellarAttributesSelection(boxel, kept);
  return {
    records: spatial.records,
    names: spatial.names,
    stellarRecords: stellar.records,
    stellarRadii: stellar.radii,
  };
}

export function prioritizeLocalBoxelAddresses(
  addresses: readonly bigint[],
): bigint[] {
  // Higher mass-code boxels cover the center with far fewer generation calls
  // and usually contain the first visible residents. This changes only stream
  // order; every enumerated boxel is still processed exactly once.
  return [...addresses].sort((left, right) => {
    const massDifference = Number(right & 7n) - Number(left & 7n);
    if (massDifference !== 0) return massDifference;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function toResolvedSystem(
  pege: Pege,
  queryResult: ReturnType<Pege["resolveAddress"]>,
): ResolvedPegeSystem | undefined {
  if (queryResult.status === "unknown") return undefined;
  if (queryResult.status === "authored") {
    const address = queryResult.system.systemAddress;
    const [x, y, z] = queryResult.system.starPosXyz;
    return withResolvedProfile(pege, address, {
      name: queryResult.system.name,
      id64: address.toString(),
      coords: { x, y, z },
      generation: "authored",
      massCode: Number(address & 7n),
      exactPosition: true,
    });
  }
  const [x, y, z] = queryResult.position.starPosXyz;
  const displayName = pege.resolveDisplayName(queryResult.systemAddress);
  return withResolvedProfile(pege, queryResult.systemAddress, {
    name: displayName.status === "resolved" ? displayName.name : undefined,
    id64: queryResult.systemAddress.toString(),
    coords: { x, y, z },
    generation: queryResult.branch,
    massCode: Number(queryResult.systemAddress & 7n),
    exactPosition: true,
  });
}

export function resolvePegeQuery(
  pege: Pege,
  query: string,
): ResolvedPegeSystem | undefined {
  const text = query.trim();
  if (/^\d+$/.test(text)) {
    return toResolvedSystem(pege, pege.resolveAddress(BigInt(text)));
  }
  const nameResolver = (
    pege as Pege & {
      resolveSystemName?: (
        name: string,
      ) => ReturnType<Pege["resolveAddress"]> | undefined;
    }
  ).resolveSystemName;
  if (nameResolver) {
    const result = nameResolver.call(pege, text);
    return result ? toResolvedSystem(pege, result) : undefined;
  }
  const authored = pege.resolveAuthoredName(text);
  return authored.status === "matched"
    ? toResolvedSystem(pege, pege.resolveAddress(authored.system.systemAddress))
    : undefined;
}

export function suggestPegeQueries(
  pege: Pege,
  query: string,
  limit: number,
): SystemSuggestion[] {
  const maximum = Math.min(100, Math.max(1, limit));
  const suggestions: SystemSuggestion[] = pege
    .suggestAuthoredNames(query, maximum)
    .map((entry) => {
      const [x, y, z] = entry.system.starPosXyz;
      return {
        name: entry.name,
        id64: entry.system.systemAddress.toString(),
        coords: { x, y, z },
        exactPosition: true,
      };
    });
  for (const preview of previewPegeQuery(pege, query)) {
    if (suggestions.some(({ id64 }) => id64 === preview.id64)) continue;
    suggestions.unshift(preview);
  }
  return suggestions.slice(0, maximum);
}

export function previewPegeQuery(
  pege: Pege,
  query: string,
): SystemLocationPreview[] {
  return pege.previewSystemNameLocations(query).map((entry) => {
    const [x, y, z] = entry.starPosXyz;
    return {
      name: entry.name,
      id64: entry.systemAddress.toString(),
      coords: { x, y, z },
      exactPosition: entry.exactPosition,
    };
  });
}

function srgbHex(srgb: readonly [number, number, number]): string {
  return `#${srgb
    .map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function resolvedComponent(
  component: StellarComponent,
) {
  const validation = component.validation;
  return {
    bodyId: component.bodyId,
    ...(component.name === undefined ? {} : { name: component.name }),
    ...(component.parents === undefined ? {} : {
      parents: component.parents.map((parent) => ({ ...parent })),
    }),
    starType: component.starType,
    ...(component.subclass === undefined ? {} : { subclass: component.subclass }),
    ...(component.luminosityClass === undefined ? {} : {
      luminosityClass: component.luminosityClass,
    }),
    ...(component.stellarMassSolar === undefined ? {} : {
      stellarMassSolar: component.stellarMassSolar,
    }),
    ...(component.radiusMeters === undefined ? {} : { radiusMeters: component.radiusMeters }),
    ...(component.absoluteMagnitude === undefined ? {} : {
      absoluteMagnitude: component.absoluteMagnitude,
    }),
    ...(component.luminositySolar === undefined ? {} : {
      luminositySolar: component.luminositySolar,
    }),
    ...(component.rotationPeriodSeconds === undefined ? {} : {
      rotationPeriodSeconds: component.rotationPeriodSeconds,
    }),
    ...(component.surfaceTemperatureKelvin === undefined ? {} : {
      surfaceTemperatureKelvin: component.surfaceTemperatureKelvin,
    }),
    ...(component.ageMyr === undefined ? {} : { ageMyr: component.ageMyr }),
    ...(component.axialTiltRadians === undefined ? {} : {
      axialTiltRadians: component.axialTiltRadians,
    }),
    ...(component.distanceFromArrivalLightSeconds === undefined ? {} : {
      distanceFromArrivalLightSeconds: component.distanceFromArrivalLightSeconds,
    }),
    ...(component.orbitalElements === undefined ? {} : {
      orbitalElements: { ...component.orbitalElements },
    }),
    ...(component.rings === undefined ? {} : {
      rings: component.rings.map((ring) => ({ ...ring })),
    }),
    ...(component.displayColor === undefined ? {} : {
      displayColor: {
        srgb: [...component.displayColor.srgb] as [number, number, number],
        source: component.displayColor.source,
      },
      stellarColor: srgbHex(component.displayColor.srgb),
    }),
    provenance: component.provenance,
    validation,
    ...(component.attributeValidation === undefined ? {} : {
      attributeValidation: { ...component.attributeValidation },
    }),
    stellarValidation: {
      starType: component.attributeValidation?.starType ?? validation,
      ...(component.stellarMassSolar === undefined ? {} : {
        mass: component.attributeValidation?.stellarMassSolar ?? validation,
      }),
      ...(component.surfaceTemperatureKelvin === undefined ? {} : {
        temperature:
          component.attributeValidation?.surfaceTemperatureKelvin ?? validation,
      }),
      ...(component.radiusMeters === undefined ? {} : {
        radius: component.attributeValidation?.radiusMeters ?? validation,
      }),
      ...(component.luminositySolar === undefined ? {} : {
        luminosity: component.attributeValidation?.luminositySolar ?? validation,
      }),
      ...(component.displayColor === undefined ? {} : {
        displayColor: component.attributeValidation?.displayColor ?? validation,
      }),
    },
  };
}

function withResolvedProfile(
  pege: Pege,
  address: bigint,
  system: ResolvedPegeSystem,
): ResolvedPegeSystem {
  const resolution = pege.resolveStellarProfile(address);
  if (resolution.status !== "resolved") return system;
  const profile = resolution.profile;
  const primary =
    profile.components.find((component) => component.bodyId === profile.primaryBodyId) ??
    profile.components[0];
  if (!primary) return system;
  const components = profile.components.map(resolvedComponent);
  return {
    ...system,
    stellarColor: primary.displayColor ? srgbHex(primary.displayColor.srgb) : undefined,
    stellarRadiusMeters: primary.radiusMeters,
    stellarType: primary.starType,
    stellarSubclass: primary.subclass,
    stellarLuminosityClass: primary.luminosityClass,
    stellarMassSolar: primary.stellarMassSolar,
    stellarTemperatureKelvin: primary.surfaceTemperatureKelvin,
    stellarLuminositySolar: primary.luminositySolar,
    stellarProfileSource: resolution.source,
    stellarProfileValidation: primary.validation,
    stellarValidation: {
      starType: primary.attributeValidation?.starType ?? primary.validation,
      mass:
        primary.stellarMassSolar === undefined
          ? undefined
          : (primary.attributeValidation?.stellarMassSolar ?? primary.validation),
      temperature:
        primary.surfaceTemperatureKelvin === undefined
          ? undefined
          : (primary.attributeValidation?.surfaceTemperatureKelvin ?? primary.validation),
      radius:
        primary.radiusMeters === undefined
          ? undefined
          : (primary.attributeValidation?.radiusMeters ?? primary.validation),
      luminosity:
        primary.luminositySolar === undefined
          ? undefined
          : (primary.attributeValidation?.luminositySolar ?? primary.validation),
      displayColor:
        primary.displayColor === undefined
          ? undefined
          : (primary.attributeValidation?.displayColor ?? primary.validation),
    },
    stellarProfileComposition: profile.composition,
    stellarPrimaryBodyId: profile.primaryBodyId,
    stellarComponents: components,
  };
}

async function generate(request: Extract<PegeWorkerRequest, { type: "generate" }>) {
  const controller = new AbortController();
  active.set(request.requestId, controller);
  try {
    const pege = await engine(request.requestId);
    let queued: PackedSystemBatch[] = [];
    let queuedBytes = 0;
    const flush = () => {
      if (queuedBytes === 0) return;
      const combined = combinePackedBatches(queued);
      const batch = request.includeNames
        ? populatePackedDisplayNames(
            pege as unknown as PackedDisplayNameResolver,
            combined,
          )
        : combined;
      respond(
        { type: "batch", requestId: request.requestId, batch },
        [
          batch.records,
          ...(batch.stellarRecords ? [batch.stellarRecords] : []),
          ...(batch.stellarRadii ? [batch.stellarRadii] : []),
        ],
      );
      queued = [];
      queuedBytes = 0;
    };
    const region = {
      minimumFixedXyz: request.minimumFixedXyz,
      maximumExclusiveFixedXyz: request.maximumExclusiveFixedXyz,
      massCodes: request.massCodes,
    };
    const append = (tile: PackedSystemBatch, threshold: number) => {
      if (!tile.stellarRecords || !tile.stellarRadii) {
        throw new Error("PEGE primary-render stream omitted aligned stellar data");
      }
      const thinned = thinPackedBatch(
        tile.records,
        tile.names,
        threshold,
        request.minimumFixedXyz,
        request.maximumExclusiveFixedXyz,
        tile.stellarRecords,
        tile.stellarRadii,
      );
      if (thinned.records.byteLength === 0) return;
      const batchBytes =
        thinned.records.byteLength +
        (thinned.stellarRecords?.byteLength ?? 0) +
        (thinned.stellarRadii?.byteLength ?? 0);
      if (queuedBytes > 0 && queuedBytes + batchBytes > PEGE_STREAM_CHUNK_BYTES) {
        flush();
      }
      queued.push(thinned);
      queuedBytes += batchBytes;
      if (queuedBytes >= PEGE_STREAM_CHUNK_BYTES) flush();
    };
    let boxelAddresses: bigint[];
    let systemThreshold = request.threshold;
    if (request.maximumBoxels !== undefined) {
      let boxelCount = 0;
      for (const _address of enumerateGalaxyBoxels(region)) boxelCount += 1;
      const plan = boundedLocalSamplePlan(
        boxelCount,
        request.maximumBoxels,
        request.threshold,
      );
      const selected: { address: bigint; score: number }[] = [];
      for (const address of enumerateGalaxyBoxels(region)) {
        const score = localBoxelScore(
          Number(address & 0xffff_ffffn),
          Number((address >> 32n) & 0xffff_ffffn),
        );
        if (score < plan.boxelThreshold) selected.push({ address, score });
      }
      selected.sort((a, b) => a.score - b.score);
      selected.length = Math.min(selected.length, request.maximumBoxels);
      const actualPlan = boundedLocalSamplePlan(
        boxelCount,
        Math.max(1, selected.length),
        request.threshold,
      );
      boxelAddresses = selected.map(({ address }) => address);
      systemThreshold = actualPlan.systemThreshold;
    } else {
      boxelAddresses = prioritizeLocalBoxelAddresses([
        ...enumerateGalaxyBoxels(region),
      ]);
    }
    respond({
      type: "progress",
      requestId: request.requestId,
      phase: "detail",
      completed: 0,
      total: boxelAddresses.length,
    });
    const yieldEvery = request.yieldEveryBoxels ?? 8;
    for (const [index, address] of boxelAddresses.entries()) {
      if (controller.signal.aborted) throw controller.signal.reason;
      const boxel = pege.generateBoxel(address);
      append(
        packFilteredGalaxyBoxel(
          pege,
          boxel,
          systemThreshold,
          request.minimumFixedXyz,
          request.maximumExclusiveFixedXyz,
        ),
        1,
      );
      respond({
        type: "progress",
        requestId: request.requestId,
        phase: "detail",
        completed: index + 1,
        total: boxelAddresses.length,
      });
      if ((index + 1) % yieldEvery === 0) {
        flush();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    flush();
    respond({
      type: "progress",
      requestId: request.requestId,
      phase: "detail",
      completed: 1,
      total: 1,
    });
    respond({ type: "complete", requestId: request.requestId });
  } catch (error) {
    if (controller.signal.aborted) {
      respond({ type: "cancelled", requestId: request.requestId });
    } else {
      respond({
        type: "error",
        requestId: request.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    active.delete(request.requestId);
  }
}

async function overview(request: Extract<PegeWorkerRequest, { type: "overview" }>) {
  const controller = new AbortController();
  active.set(request.requestId, controller);
  try {
    const pege = await engine(request.requestId);
    const progressTotal = request.maximumBoxelsVisited ?? request.targetSystems;
    respond({
      type: "progress",
      requestId: request.requestId,
      phase: "overview",
      completed: 0,
      total: progressTotal,
    });
    if (!controller.signal.aborted) {
      for await (const chunk of streamPackedGalaxyViewAsync(
        pege,
        {
          minimumFixedXyz: request.minimumFixedXyz,
          maximumExclusiveFixedXyz: request.maximumExclusiveFixedXyz,
          targetSystems: request.targetSystems,
          ...(request.massCodes === undefined ? {} : { massCodes: request.massCodes }),
          maximumBoxelsVisited: request.maximumBoxelsVisited,
          selectionSeed: BigInt(request.selectionSeed),
          attributes: "spatial-primary-render",
          stellarLod: request.stellarLod,
        },
        {
          signal: controller.signal,
          maxChunkBytes: PEGE_OVERVIEW_CHUNK_BYTES,
          yieldEveryBoxels: 8,
          onProgress(sample) {
            respond({
              type: "progress",
              requestId: request.requestId,
              phase: "overview",
              completed: request.maximumBoxelsVisited === undefined
                ? sample.selectedByMassCode.reduce((sum, count) => sum + count, 0)
                : sample.boxelsVisited,
              total: progressTotal,
            });
          },
        },
      )) {
        const unnamedBatch = {
            records: chunk.records,
            names: chunk.names,
            stellarRecords: chunk.stellarRecords,
            stellarRadii: chunk.stellarRadii,
          };
        const batch = request.includeNames
          ? populatePackedDisplayNames(
              pege as unknown as PackedDisplayNameResolver,
              unnamedBatch,
            )
          : unnamedBatch;
        respond(
          {
            type: "batch",
            requestId: request.requestId,
            batch,
          },
          packedBatchTransfers(batch),
        );
      }
    }

    pege.clearCaches();
    if (controller.signal.aborted) {
      respond({ type: "cancelled", requestId: request.requestId });
    } else {
      respond({
        type: "progress",
        requestId: request.requestId,
        phase: "prepare",
        completed: 1,
        total: 1,
      });
      respond({ type: "complete", requestId: request.requestId });
    }
  } catch (error) {
    respond({
      type: "error",
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    active.delete(request.requestId);
  }
}

async function planTiles(
  request: Extract<PegeWorkerRequest, { type: "plan-tiles" }>,
) {
  const controller = new AbortController();
  active.set(request.requestId, controller);
  try {
    const pege = await engine(request.requestId);
    const estimates = [];
    respond({
      type: "progress",
      requestId: request.requestId,
      phase: "detail",
      completed: 0,
      total: Math.max(1, request.keys.length),
    });
    for (let index = 0; index < request.keys.length; index += 1) {
      if (controller.signal.aborted) break;
      const estimate = estimateGalaxyViewTilePopulation(pege, request.keys[index]!);
      const weight = request.keyWeights?.[index] ?? 1;
      estimates.push({
        ...estimate,
        populationWeight: estimate.populationWeight * Math.max(0, weight),
      });
      respond({
        type: "progress",
        requestId: request.requestId,
        phase: "detail",
        completed: index + 1,
        total: request.keys.length,
      });
      if ((index + 1) % 8 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    if (controller.signal.aborted) {
      respond({ type: "cancelled", requestId: request.requestId });
      return;
    }
    const recommendations = recommendGalaxyViewTileTargets(
      estimates,
      request.totalTargetSystems,
    );
    respond({
      type: "tile-plan",
      requestId: request.requestId,
      tiles: recommendations.map((tile) => ({
        key: tile.key,
        keyString: galaxyViewTileKeyString(tile.key),
        targetSystems: tile.targetSystems,
        populationWeight: tile.populationWeight,
      })),
    });
  } catch (error) {
    respond({
      type: "error",
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    active.delete(request.requestId);
  }
}

async function generateTiles(
  request: Extract<PegeWorkerRequest, { type: "tiles" }>,
) {
  const controller = new AbortController();
  active.set(request.requestId, controller);
  try {
    const pege = await engine(request.requestId);
    const reportsBoxelWork = request.tiles.length > 0 && request.tiles.every(
      (tile) => tile.maximumBoxelsVisited !== undefined,
    );
    const total = request.tiles.reduce(
      (sum, tile) => sum + Math.max(
        0,
        reportsBoxelWork
          ? tile.maximumBoxelsVisited!
          : tile.targetSystems,
      ),
      0,
    );
    const completedByTile = new Map<string, number>();
    respond({
      type: "progress",
      requestId: request.requestId,
      phase: "detail",
      completed: 0,
      total,
    });
    const aggregateShells = request.tiles.some(
      (tile) => tile.sampleTargetSystems !== undefined,
    );
    if (aggregateShells) {
      let completed = 0;
      const densityRequests = request.tiles.map((entry) => ({
            key: entry.key,
            sourceTargetSystems: entry.targetSystems,
            sampleTargetSystems: Math.min(
              entry.targetSystems,
              entry.sampleTargetSystems ?? entry.targetSystems,
            ),
            voxelResolution: entry.voxelResolution ?? 4,
            ...(entry.maximumBoxelsVisited === undefined
              ? {}
              : { maximumBoxelsVisited: entry.maximumBoxelsVisited }),
      }));
      const publishDensityTile = (tile: PackedGalaxyDensityTile) => {
        const batch = request.includeNames
          ? populatePackedDisplayNames(
              pege as unknown as PackedDisplayNameResolver,
              tile.genuineSample,
            )
          : tile.genuineSample;
        respond(
          {
            type: "tile-batch",
            requestId: request.requestId,
            tileKey: tile.tileKey,
            tileKeyString: tile.tileKeyString,
            selectionOffset: 0,
            batch,
          },
          packedBatchTransfers(batch),
        );
        const density: PackedDensityBatch = {
          densityVersion: tile.densityVersion,
          voxelResolution: tile.voxelResolution,
          sourceSystemCount: tile.sourceSystemCount,
          centroidFixedXyz: tile.centroidFixedXyz,
          voxelSystemCounts: tile.voxelSystemCounts,
        };
        respond(
          {
            type: "tile-density",
            requestId: request.requestId,
            tileKey: tile.tileKey,
            tileKeyString: tile.tileKeyString,
            density,
          },
          packedDensityTransfers(density),
        );
      };
      if (reportsBoxelWork) {
        for (const densityRequest of densityRequests) {
          const maximumBoxelsVisited = densityRequest.maximumBoxelsVisited!;
          for await (const tile of streamPackedGalaxyDensityTilesAsync(
            pege,
            {
              tiles: [densityRequest],
              ...(request.massCodes === undefined ? {} : { massCodes: request.massCodes }),
              selectionSeed: BigInt(request.selectionSeed),
              attributes: request.attributes,
              stellarLod: request.stellarLod,
            },
            {
              signal: controller.signal,
              maxChunkBytes: PEGE_STREAM_CHUNK_BYTES,
              yieldEveryBoxels: 8,
              onProgress(sample) {
                respond({
                  type: "progress",
                  requestId: request.requestId,
                  phase: "detail",
                  completed: Math.min(
                    total,
                    completed + Math.min(maximumBoxelsVisited, sample.boxelsVisited),
                  ),
                  total,
                });
              },
            },
          )) publishDensityTile(tile);
          completed += maximumBoxelsVisited;
          respond({
            type: "progress",
            requestId: request.requestId,
            phase: "detail",
            completed: Math.min(total, completed),
            total,
          });
        }
      } else {
        for await (const tile of streamPackedGalaxyDensityTilesAsync(
          pege,
          {
            tiles: densityRequests,
            ...(request.massCodes === undefined ? {} : { massCodes: request.massCodes }),
            selectionSeed: BigInt(request.selectionSeed),
            attributes: request.attributes,
            stellarLod: request.stellarLod,
          },
          {
            signal: controller.signal,
            maxChunkBytes: PEGE_STREAM_CHUNK_BYTES,
            yieldEveryBoxels: 8,
          },
        )) {
          publishDensityTile(tile);
          completed += tile.sourceSystemCount;
          respond({
            type: "progress",
            requestId: request.requestId,
            phase: "detail",
            completed: Math.min(total, completed),
            total,
          });
        }
      }
      if (controller.signal.aborted) {
        respond({ type: "cancelled", requestId: request.requestId });
      } else {
        respond({
          type: "progress",
          requestId: request.requestId,
          phase: "detail",
          completed: 1,
          total: 1,
        });
        respond({ type: "complete", requestId: request.requestId });
      }
      return;
    }
    for await (const chunk of streamPackedGalaxyTilesAsync(
      pege,
      {
        tiles: request.tiles,
        ...(request.massCodes === undefined ? {} : { massCodes: request.massCodes }),
        selectionSeed: BigInt(request.selectionSeed),
        attributes: request.attributes,
        stellarLod: request.stellarLod,
      },
      {
        signal: controller.signal,
        maxChunkBytes: PEGE_STREAM_CHUNK_BYTES,
        yieldEveryBoxels: 8,
      },
    )) {
      const unnamedBatch = {
          records: chunk.records,
          names: chunk.names,
          stellarRecords: chunk.stellarRecords,
          stellarRadii: chunk.stellarRadii,
        };
      const batch = request.includeNames
        ? populatePackedDisplayNames(
            pege as unknown as PackedDisplayNameResolver,
            unnamedBatch,
          )
        : unnamedBatch;
      const target = request.tiles.find(
        (tile) => galaxyViewTileKeyString(tile.key) === chunk.tileKeyString,
      )?.targetSystems ?? 0;
      completedByTile.set(
        chunk.tileKeyString,
        Math.min(
          target,
          chunk.sample.selectionOffset +
            batch.records.byteLength / GALAXY_SYSTEM_STRIDE_BYTES,
        ),
      );
      respond(
        {
          type: "tile-batch",
          requestId: request.requestId,
          tileKey: chunk.tileKey,
          tileKeyString: chunk.tileKeyString,
          selectionOffset: chunk.sample.selectionOffset,
          batch,
        },
        packedBatchTransfers(batch),
      );
      respond({
        type: "progress",
        requestId: request.requestId,
        phase: "detail",
        completed: [...completedByTile.values()].reduce((sum, value) => sum + value, 0),
        total,
      });
    }
    if (controller.signal.aborted) {
      respond({ type: "cancelled", requestId: request.requestId });
    } else {
      respond({
        type: "progress",
        requestId: request.requestId,
        phase: "detail",
        completed: 1,
        total: 1,
      });
      respond({ type: "complete", requestId: request.requestId });
    }
  } catch (error) {
    if (controller.signal.aborted) {
      respond({ type: "cancelled", requestId: request.requestId });
    } else {
      respond({
        type: "error",
        requestId: request.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    active.delete(request.requestId);
  }
}

async function handle(request: PegeWorkerRequest) {
  if (request.type === "initialize") {
    runtimeUrl = request.runtimeUrl;
    workerRole = request.role ?? "galaxy";
    if (request.prewarm) void engine(0).catch(() => undefined);
    return;
  }
  if (request.type === "cancel") {
    active.get(request.requestId)?.abort();
    return;
  }
  if (request.type === "generate") {
    await generate(request);
    return;
  }
  if (request.type === "overview") {
    await overview(request);
    return;
  }
  if (request.type === "plan-tiles") {
    await planTiles(request);
    return;
  }
  if (request.type === "tiles") {
    await generateTiles(request);
    return;
  }
  if (request.type === "warm") {
    try {
      await engine(request.requestId);
      respond({
        type: "progress",
        requestId: request.requestId,
        phase: "prepare",
        completed: 1,
        total: 1,
      });
      respond({ type: "complete", requestId: request.requestId });
    } catch (error) {
      respond({
        type: "error",
        requestId: request.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  try {
    const pege = await engine(request.requestId);
    if (request.type === "resolve") {
      const resolved = resolvePegeQuery(pege, request.query);
      respond({ type: "resolved", requestId: request.requestId, system: resolved });
      return;
    }
    if (request.type === "preview") {
      respond({
        type: "previews",
        requestId: request.requestId,
        previews: previewPegeQuery(pege, request.query),
      });
      return;
    }
    if (request.type === "suggest") {
      const suggestions = suggestPegeQueries(
        pege,
        request.query,
        request.limit,
      );
      respond({ type: "suggestions", requestId: request.requestId, suggestions });
      return;
    }
    const result = pege.resolveDisplayName(BigInt(request.id64));
    respond({
      type: "display-name",
      requestId: request.requestId,
      name: result.status === "resolved" ? result.name : undefined,
    });
  } catch (error) {
    respond({
      type: "error",
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

scope.onmessage = (event) => {
  void handle(event.data);
};
