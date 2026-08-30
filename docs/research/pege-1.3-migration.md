# PEGE 1.3 migration research

Research date: 2026-08-26  
Newest release: `v1.3.0`  
PEGE package commit: `e6dd23de476d45c9fba8c63aa733b0e6b1328dee`  
PEGE-Source commit: `be3af831256ac8e1f2bec9d25a225c0f66e145df`

## Executive finding

PEGE 1.3.0 is the correct next dependency for ED3DM. It directly fixes the two confirmed engine-level memory amplifiers in 1.2: monotonically retained procedural boxels/primary attributes and one `StellarSystemProfile` allocation plus per-ID lookup for every rendered System. The release adds a byte-budgeted LRU, cache lifecycle telemetry, aligned bulk stellar packing, and byte-capped async chunks. [Release](https://github.com/Fenris159/PEGE/releases/tag/v1.3.0) [Merged implementation summary](https://github.com/Fenris159/PEGE-Source/pull/7)

This is an additive API/code upgrade, not a galaxy-data change. The official `pege-runtime.bin` in the 1.2 and 1.3 tags is byte-identical locally: 42,256,765 bytes and SHA-256 `2573e43614d63166a5cd33aaf8cc25647dfa635d612c479a92181aa08379f412`. Existing ID64, position, name, and profile results therefore remain on the same runtime dataset.

PEGE 1.3 does **not** solve the distant color-distribution problem by itself. It still has no engine-owned representative whole-galaxy sampler and still materializes a complete `GalaxyBoxelResolution` before splitting its packed output. The release PR identifies both as follow-up scope. [Explicit follow-up limits](https://github.com/Fenris159/PEGE-Source/pull/7)

## New public contract

### Bounded procedural cache

`new Pege(dataset, options?)` now accepts:

```ts
{
  cache: {
    maxBytes: 128 * 1024 * 1024,
    trimToBytes: 96 * 1024 * 1024,
  },
}
```

If omitted, the procedural cache defaults to 128 MiB and trims to 70% after crossing the hard threshold. A zero-byte budget disables strong procedural caching. `cacheStats()`, `trimCaches()`, and `clearCaches()` expose lifecycle control. The budget covers engine-owned generated boxels and derived primary attributes; it excludes immutable runtime indexes and results retained by application code. [API reference](https://github.com/Fenris159/PEGE/blob/v1.3.0/docs/api-reference.md#pege) [Initialization and ownership](https://github.com/Fenris159/PEGE/blob/v1.3.0/docs/getting-started.md#initialize)

Internally, boxel resolution, address index, and primary attributes are now one atomically evicted LRU entry. The old growing population cache is replaced by finite compiled-population summaries, and per-ID resolution uses a boxel-owned address index instead of a linear scan. [Engine implementation](https://github.com/Fenris159/PEGE-Source/blob/v1.3.0/src/galaxy-system-engine.ts#L93-L306)

### Bulk primary-render attributes

`streamPackedGalaxyRegionAsync()` adds these options:

```ts
{
  attributes: "spatial-primary-render",
  maxChunkBytes: 4 * 1024 * 1024,
}
```

Each returned chunk then contains aligned buffers:

- `records`: 24 bytes per System;
- `stellarRecords`: 32 bytes per System;
- `stellarRadii`: one `float32`, 4 bytes per System;
- `stellarStrideBytes`, plus the existing names and counts;
- optional `firstSystemIndex` when one dense boxel is split across chunks.

`maxChunkBytes` counts all three buffers. It must be at least 60 bytes for primary-render output. A 4-MiB value permits at most 69,905 Systems per emitted chunk. `systemCount` and `names[].systemIndex` are chunk-local; `firstSystemIndex` matters only when reconstructing whole-boxel indices. [Worker integration](https://github.com/Fenris159/PEGE/blob/v1.3.0/docs/webgpu-integration.md#worker-pattern) [Stream declarations and implementation](https://github.com/Fenris159/PEGE-Source/blob/v1.3.0/src/webgpu-galaxy-stream.ts#L20-L215)

`packGalaxyBoxelWithStellarAttributes(engine, boxel, start?, end?)` provides the same aligned packing for a directly generated boxel. The bulk path writes stellar attributes from generation inputs and does not call `resolveStellarProfile()` for every record. `resolveStellarProfile()` remains appropriate for one selected System. [Stellar guidance](https://github.com/Fenris159/PEGE/blob/v1.3.0/docs/stellar-profiles.md#gpu-packing) [Bulk packer regression test](https://github.com/Fenris159/PEGE-Source/blob/v1.3.0/test/bulk-stellar-packing.test.mjs)

Important limit: `generateBoxel()` still finishes before chunk packing starts. `maxChunkBytes` bounds transfer-buffer size and creates cancellation points between chunks, but it does not cap the transient JavaScript object graph of one exceptionally dense boxel. [Stream implementation](https://github.com/Fenris159/PEGE-Source/blob/v1.3.0/src/webgpu-galaxy-stream.ts#L175-L215)

## ED3DM pre-migration comparison

Before this migration, ED3DM was pinned to PEGE 1.2.0. Its Worker compensated for the old engine in three ways:

1. `withStellarProfiles()` expands every packed ID64 back through `resolveStellarProfile()`, holds an array of profile objects, then repacks it. [Current profile path](../../src/pege-worker.ts#L145-L175)
2. Local generation constructs short-lived `Pege` instances and replaces one after 512 selected boxels to bound the old permanent memoization. The overview replaces one after 64 probes. [Current local rotation](../../src/pege-worker.ts#L369-L471) [Current overview rotation](../../src/pege-worker.ts#L578-L647)
3. `thinPackedBatch()` thins only spatial records and names. It has no aligned stellar/radius input because PEGE 1.2 supplied none. [Current thinning](../../src/pege-worker.ts#L178-L232)

The migration removes the per-System procedural profile path and engine-rotation workarounds rather than retaining them on top of 1.3:

- Construct the long-lived Worker engine with an explicit cache budget. Reuse it for local requests and inspect `cacheStats()` in diagnostics. Call `clearCaches()` after a fundamentally different workload only when useful; eviction changes performance, not deterministic output.
- Request `attributes: "spatial-primary-render"` and `maxChunkBytes: 4 * 1024 * 1024` from `streamPackedGalaxyRegionAsync()`.
- Replace `thinPackedBatch(records, names, ...)` with an aligned variant that copies the same selected indices from `records`, `stellarRecords`, and `stellarRadii`. Passing the new PEGE tile to the old thinning helper would silently discard the new attributes; calling `withStellarProfiles()` afterward would surrender the main 1.3 performance benefit.
- For individually selected boxel addresses, call `packGalaxyBoxelWithStellarAttributes()` before aligned thinning.
- Keep `withResolvedProfile()` for search/selection details. Keep a bounded authored-overview pack path because the bulk boxel API is intended for generated tiles, while ED3DM currently writes its authored overview records directly.
- Preserve ED3DM's stable ID64 percentage thinning and boxel preselection. PEGE 1.3 bounds memory and packing, but it does not add a percentage threshold, point budget, or representative whole-galaxy sampler.

`combinePackedBatches()` can remain if it continues to flush around 4,096 retained Systems, though it makes one additional bounded copy before transfer. `firstSystemIndex` need not survive this merge because ED3DM treats output as a System reservoir rather than reconstructing complete source boxels.

## Color and LOD consequence

The realistic theme will receive the same profile values as before; the new bulk records are tested bit-for-bit against the existing profile packer. This removes allocation overhead but does not change the palette or population being sampled. [Bulk equivalence test](https://github.com/Fenris159/PEGE-Source/blob/v1.3.0/test/bulk-stellar-packing.test.mjs)

ED3DM's overview still deliberately probes mass codes 4 through 7, which selects high-primary-mass populations and therefore remains blue-biased. [Current overview selection](../../src/pege-worker.ts#L489-L577) Matching Frontier's warmer far view still requires the proposed engine-owned, density-weighted sampler across all mass codes or an offline PEGE-generated representative reservoir. PEGE 1.3 makes that future work safer; it does not implement it.

## Recommended migration sequence

1. Pin `github:Fenris159/PEGE#v1.3.0`, reinstall, and copy the packaged runtime asset. Its content hash is unchanged, so no data-format or overview-cache invalidation is required solely for this release.
2. Update Worker imports and add aligned spatial/stellar/radius thinning tests before changing generation.
3. Switch procedural streaming and direct boxel packing to the new bulk attributes with a 4-MiB chunk cap.
4. Replace per-request and 64/512-boxel engine rotation with one explicitly budgeted engine.
5. Add a Worker diagnostic response or development log for `cacheStats()`; do not present its conservative `retainedBytes` as total browser heap.
6. Stress repeated Sol searches, rapid zoom cancellation, dense-core movement, and at least 10,000 unique boxels. Assert bounded cache statistics, no stale chunks, stable System/profile output, and a responsive browser.

The migration should not claim that 4-MiB chunks prevent every one-boxel peak or that PEGE 1.3 fixes representative color distribution. Those are the two remaining upstream concerns.

## Verification

- Official PEGE 1.3.0 distribution tests: 7 passed.
- Clean PEGE-Source `npm run check`: typecheck, build, and all 15 tests passed, including the 10,000-boxel cache plateau and chunked bulk-packing tests.
- The release PR reports a forced-GC plateau near 145.3 MiB from 2,000 through 10,000 tested boxels and explicitly scopes out whole-galaxy representative sampling and compact immutable indexes. [Release validation](https://github.com/Fenris159/PEGE-Source/pull/7)
- ED3DM now pins PEGE 1.3.0, requests aligned primary-render chunks capped at 4 MiB, preserves buffer alignment through thinning, and uses one explicitly budgeted Worker engine. Its typecheck, 59 tests, production build, library build, and a live 155-System aligned stream check passed after migration.
