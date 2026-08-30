# PEGE engine LOD and memory recommendations

Research date: 2026-08-26  
PEGE release reviewed: `v1.2.0` / `52ef17cf3cdbb8571262823e5678d21a4d075912`  
PEGE-Source reviewed: `v1.2.0` / `13c3c709811e2ee3c6effbfc6acf5408dfa5b707`

## Executive recommendation

Do not try to make the browser hold more than 4 GB. Make PEGE's working set bounded.

The first engine change should replace PEGE 1.2's permanent procedural caches with an explicitly budgeted cache and add a packed, sampled streaming path which never retains a full `GalaxyBoxelResolution` merely to draw it. The second should move whole-galaxy overview selection into PEGE as a deterministic, spatially stratified sampler across **all** mass codes. That fixes both failure modes seen in ED3DM: monotonic memory growth and a distant population dominated by blue high-mass stars.

The observed 915,656-System result requires only about 52.4 MiB for ED3DM's final 24-byte spatial record, 32-byte stellar record, and 4-byte radius sidecar. Several gigabytes therefore cannot be explained by the final GPU payload. It is consistent with retained JavaScript object graphs, temporary profile objects, and cache duplication. PEGE 1.2 keeps `#boxelCache`, `#populationCache`, and `#primaryAttributeByAddress` as unbounded `Map`s; generation inserts complete boxel results and every generated primary attribute, with no eviction or clear API. [Engine caches and generation](https://github.com/Fenris159/PEGE-Source/blob/v1.2.0/src/galaxy-system-engine.ts#L96-L109) [Cache insertion and profile lookup](https://github.com/Fenris159/PEGE-Source/blob/v1.2.0/src/galaxy-system-engine.ts#L172-L271) [ED3DM profile/radius sidecars](../../src/pege-worker.ts#L154-L175)

The current stream API cannot solve that upstream. Its request contains only an AABB and mass-code list, and it calls `generateBoxel()` to completion before packing the entire result. Cancellation is checked only between boxels. [Region and stream implementation](https://github.com/Fenris159/PEGE-Source/blob/v1.2.0/src/webgpu-galaxy-stream.ts#L27-L31) [Packing and cooperative cancellation](https://github.com/Fenris159/PEGE-Source/blob/v1.2.0/src/webgpu-galaxy-stream.ts#L58-L151)

## What the apparent 4 GB limit means

The earlier standalone failure is compatible with V8's normal heap ceiling, but it does not prove that Brave imposed one exact 4 GB total-memory limit. On this machine, Node 24.14 reports a default V8 heap limit of 4,288 MiB; launching the same runtime with `--max-old-space-size=8192` reports 8,384 MiB. V8 documents Chrome heaps as normally limited to 2 or 4 GB depending on the device and explains the 4-GB pointer-compression cage. [V8 pointer compression](https://v8.dev/blog/pointer-compression#compressed-tagged-values-and-new-heap-layout)

There are two different answers to "can it go beyond 4 GB?":

- **Offline or backend Node job:** yes, `node --max-old-space-size=8192 ...` can raise old-space for a controlled build job. Node documents that this changes V8's old-space ceiling. This is useful for generating a versioned overview artifact, but it is a workaround, not a memory fix. [Node CLI](https://nodejs.org/api/cli.html#--max-old-space-sizesize-in-mib)
- **Normal browser application:** there is no dependable web API through which ED3DM can request a larger JavaScript heap. Splitting work across Workers may spread objects across isolates and postpone failure, but it duplicates PEGE's decoded data and still consumes finite renderer/process memory. It must not be the primary design.

Moving arrays to WebAssembly or GPU memory also does not make an unbounded design safe. Typed arrays can greatly reduce per-record overhead, and transferred `ArrayBuffer`s can leave the Worker, but device/process limits still exist. The correct rule is: retain a small fixed overview, a bounded local cache, and bounded GPU tiles; regenerate or restore evicted data on demand.

Instrument before tuning. In Chromium-family browsers, use DevTools heap snapshots for retained-object attribution and, where cross-origin isolation is available, sample `performance.measureUserAgentSpecificMemory()` for the page plus Workers. Chrome explicitly distinguishes total memory from the older JavaScript-heap-only view and cautions that measurements are implementation-dependent. [Chrome memory tooling](https://developer.chrome.com/docs/devtools/memory-problems) [Page memory measurement](https://web.dev/articles/monitor-total-page-memory-usage)

## Prioritized engine work

### P0: Add memory ownership, telemetry, and lifecycle

Give `Pege` a cache budget at construction and expose cache statistics, trimming, and clearing. Keep immutable density resources and compiled/authored indexes resident; make procedural boxel results, population summaries, and procedural primary attributes evictable.

Use one LRU entry per generated boxel. An entry should own every derived value for that boxel so eviction is atomic, including procedural primary attributes. Prefer compact typed storage over nested `systems`, `position`, and coordinate-array objects. Regeneration is deterministic, so eviction must change performance only, never output. PEGE's present documentation recommends retaining one instance because it caches population and parent-boxel results, but it exposes no budget or lifecycle control. [PEGE initialization guidance](https://github.com/Fenris159/PEGE/blob/v1.2.0/docs/getting-started.md#L14-L31)

Recommended defaults:

- browser cache budget: 128 MiB, configurable from 32 to 512 MiB;
- trim high-water mark: 90%, low-water target: 70%;
- never commit an aborted or failed boxel to cache;
- `cacheMode: "none"` for one-shot overview sampling;
- cache accounting returned by the engine, not inferred from `Map.size`.

### P1: Stream sampled packed records directly

Add a stream path that performs stable ID64 selection before retaining output objects, writes spatial and primary render attributes directly into bounded chunks, and transfers those chunks. It must not call `resolveStellarProfile()` once per packed System.

In 1.2, `resolveStellarProfile()` calls `resolveAddress()`, which searches the cached boxel's `systems` array, while the procedural primary value is stored separately in `#primaryAttributeByAddress`. Repeating this for every System creates needless objects and can become quadratic within a boxel. The engine already has the aligned primary attributes during generation, so it can pack them in the same pass as positions. [Address and profile resolution](https://github.com/Fenris159/PEGE-Source/blob/v1.2.0/src/galaxy-system-engine.ts#L273-L337) [Current 32-byte stellar packer](https://github.com/Fenris159/PEGE-Source/blob/v1.2.0/src/stellar-system-profile.ts#L318-L426)

Add abort checks inside population replay, placement replay, and packing, not only between boxels. Partial work must be discarded. Cap each emitted chunk by bytes or System count so peak memory is independent of one dense result.

### P1: Add an engine-owned representative overview sampler

Do not build a galaxy overview by requesting only coarse mass codes. PEGE's primary-attribute boundaries partition stellar mass by mass code: code `a` begins at `2/256` solar masses, while `e` begins at `460/256`, `g` at `3840/256`, and `h` at `7680/256`. Procedural color then bins that mass into Y through O and applies a discrete engine palette. Sampling mainly `e` through `h` therefore selects A/B/O-class primaries by construction and explains the blue far view. [Mass-code primary boundaries](https://github.com/Fenris159/PEGE-Source/blob/v1.2.0/src/population-control.ts#L24-L34) [Mass-to-class and palette mapping](https://github.com/Fenris159/PEGE-Source/blob/v1.2.0/src/stellar-system-profile.ts#L128-L155) [Procedural classification](https://github.com/Fenris159/PEGE-Source/blob/v1.2.0/src/stellar-system-profile.ts#L187-L224)

Implement a deterministic sampler that:

1. divides the galaxy into fixed, camera-independent spatial strata;
2. uses PEGE density resources to allocate a target point budget among strata;
3. samples all mass codes according to their predicted System populations;
4. uses a stable ID64 score so lower LODs are strict subsets of higher LODs;
5. returns each stratum's inclusion probability and generated/selected counts;
6. produces exact PEGE coordinates for selected Systems without retaining rejected System objects.

For the first implementation, density-weighted deterministic boxel probes are acceptable. A later version may build a versioned, engine-generated LOD pyramid into `pege-runtime.bin`. Neither approach should store synthetic points: every returned record remains a real PEGE System.

### P2: Supply compact render photometry, not a screenshot-specific palette

Fix population selection before changing `ENGINE_PALETTE`. PEGE 1.2 provides exact compiled classes/colors but marks procedural class and color as estimated, and all engine profiles as partial. [PEGE stellar-profile contract](https://github.com/Fenris159/PEGE/blob/v1.2.0/docs/stellar-profiles.md#L7-L22)

The render stream should optionally include a compact primary descriptor aligned to each spatial record: primary attribute or mass, class index, sRGB palette color, exact/estimated flags, and a brightness/size input when known. If PEGE later estimates temperature, luminosity, absolute magnitude, or radius for procedural primaries, preserve `estimated` provenance. Do not call those values exact Frontier data.

Frontier-like bloom, exposure, point-spread shape, and sRGB-to-linear conversion remain renderer responsibilities. The engine should make representative population and honest physical metadata possible; it should not embed one screenshot's post-processing.

### P3: Compact immutable runtime indexes

After cache growth is bounded, profile startup memory. `decodeGalaxyRuntimeData()` currently expands the binary into arrays of JavaScript records and the engine then builds multiple `Map` indexes over them. A binary-backed struct-of-arrays dataset with sorted ID64 indexes can reduce fixed overhead and improve locality. This is worthwhile, but it is secondary because the static catalogue is finite while procedural caches currently grow without bound. [Runtime decoder](https://github.com/Fenris159/PEGE-Source/blob/v1.2.0/src/galaxy-runtime-data.ts#L455-L486) [Catalogue and engine indexes](https://github.com/Fenris159/PEGE-Source/blob/v1.2.0/src/galaxy-runtime-model.ts#L37-L76)

## Proposed minimal deep interface

Keep camera policy in ED3DM. Let PEGE own generation, representative selection, packing, and memory:

```ts
type PegeOptions = {
  cache?: {
    maxBytes: number;
    trimToBytes?: number;
  };
};

type GalaxyViewRequest = {
  minimumFixedXyz: readonly [number, number, number];
  maximumExclusiveFixedXyz: readonly [number, number, number];
  targetSystems: number;
  selectionSeed?: number;
  detail: "overview" | "local" | "exact";
  attributes?: "spatial" | "spatial-primary-render";
};

type GalaxyViewChunk = {
  stratumKey: bigint;
  systemCount: number;
  spatialRecords: ArrayBuffer;
  primaryRecords?: ArrayBuffer;
  inclusionProbability: number;
};

type PegeCacheStats = {
  budgetBytes: number;
  retainedBytes: number;
  boxelEntries: number;
  hits: number;
  misses: number;
  evictions: number;
};

class Pege {
  streamView(
    request: GalaxyViewRequest,
    options?: { signal?: AbortSignal; maxChunkBytes?: number; cacheMode?: "bounded" | "none" },
  ): AsyncGenerator<GalaxyViewChunk>;
  cacheStats(): PegeCacheStats;
  trimCaches(targetBytes?: number): void;
  clearCaches(): void;
}
```

`exact` means complete Systems in a deliberately small local region. `overview` and `local` obey `targetSystems` and return stable nested samples. The caller never needs to know PEGE's cache layout or materialize `GalaxyBoxelResolution` objects for map rendering. Existing `generateBoxel()` and resolution methods can remain for research and single-System operations.

## Acceptance criteria for an agent handoff

1. **Bit-for-bit determinism:** a boxel generated before and after eviction has identical spatial records, primary records, names, and unresolved results.
2. **Memory plateau:** sweep at least 10,000 unique boxels with a 128-MiB cache. Engine-accounted retained bytes never exceed the budget, and forced-GC heap measurements plateau after warm-up instead of increasing with every boxel.
3. **Bounded peak:** no output chunk exceeds `maxChunkBytes`; transferred buffers are not retained by PEGE.
4. **Cancellation:** aborting a dense request stops within a defined inner-loop work bound, emits no later chunks, and leaves no partial cache entry.
5. **Nested LOD:** for the same seed and region, every 25% sample is a subset of 50%, which is a subset of 100%, independent of traversal order.
6. **Representative distribution:** against an exactly enumerable calibration region, sampled counts per spatial stratum, mass code, and primary class stay within a documented statistical tolerance. A golden whole-galaxy seed must include low-mass warm classes and retain the galaxy's X/Y/Z envelope.
7. **Profile alignment and complexity:** every emitted primary record matches its spatial ID64; the bulk path does not invoke per-ID `resolveAddress()` or allocate one `StellarSystemProfile` object per System.
8. **Compatibility:** existing public v1.2 fixture ID64s, names, coordinates, flags, and profile provenance remain unchanged.

## Suggested delivery order

1. Cache statistics, explicit clear/trim, and a failing memory-plateau test.
2. Coupled LRU eviction for boxels and their primary data.
3. Direct packed spatial-plus-primary streaming with chunk limits and inner-loop cancellation.
4. Deterministic representative `streamView()` overview/local sampling across all mass codes.
5. Optional compact runtime indexes and richer estimated photometry.

Raising Node's heap can unblock an offline experiment during steps 3-4. It should never be used as the acceptance criterion: the durable result is that the same sweep completes under the engine's declared memory budget in an ordinary browser Worker.

## Local verification

The installed package is PEGE 1.2.0 at release commit `52ef17c`; its declarations and distribution match the reviewed PEGE-Source tag. Node 24.14 on this machine reported a 4,288-MiB default heap limit and 8,384 MiB with `--max-old-space-size=8192`. Source inspection confirmed that v1.2 exposes no cache budget, cache statistics, eviction, destruction, sample threshold, point budget, or bulk aligned primary-attribute stream.
