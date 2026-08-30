# PEGE 1.5 spatial-streaming frontend handoff

Date: 2026-08-26

Audience: agent integrating PEGE 1.5 into ED3DM-WebGPU

Engine PR: [PEGE-Source #9](https://github.com/Fenris159/PEGE-Source/pull/9)
Current ED3DM dependency: PEGE v1.4.0

## Outcome

PEGE 1.5 replaces the visibly boxel-batched broad-view sample with a deterministic coverage-first selection. It also adds stable world-space tiles, relative population guidance, bounded-memory traversal, and a versioned spatial cache contract.

The change does **not** alter the generated galaxy. Every emitted point remains a genuine PEGE System at the exact coordinate produced by normal full generation. The sampler changes only which real Systems are retained under a restrictive point budget and the deterministic order in which they are returned.

ED3DM should integrate this in two stages:

1. Upgrade the existing whole-galaxy overview to PEGE 1.5 and invalidate PEGE 1.4 cached selections. This immediately removes the recurring 32-System cube pattern.
2. Add stable PEGE tile residency for camera-local detail. Keep PEGE camera-agnostic: ED3DM computes visible tile keys and owns GPU/IndexedDB residency.

Do not replace `loadRegion()` or the exact local-region stream merely to adopt the new overview sampler. Exact region enumeration and representative view/tile sampling serve different purposes.

## Release status

The implementation is on PR #9 at commit `f303eba926bea74bffd0ab83553cff3d66a926cf`. The PR is open, mergeable, and has green Node 22/24/26 and Sonar checks. Sonar reports 95.1% new-code coverage, no duplication, and zero open issues.

PEGE 1.5 has not yet been merged, tagged, or deployed to the distribution repository. Do not change ED3DM's production dependency to `v1.5.0` until that tag exists in `Fenris159/PEGE`. The expected production pin is:

```json
"pege": "github:Fenris159/PEGE#v1.5.0"
```

Keep the module and `pege-runtime.bin` from the same release. Do not install the unrelated public npm package named `pege`.

## Fidelity contract the frontend can rely on

- PEGE does not move, jitter, scale, snap, or synthesize selected points.
- Packed 24-byte position records and 32-byte stellar records were compared byte-for-byte with normal full boxel generation.
- Every emitted spatial record retains `GalaxySystemFlags.ExactPosition`.
- Compact traversal follows the same placement RNG draws and collision decisions as diagnostic/full generation. It omits attempt-history allocations only.
- Increasing `targetSystems` returns an exact ordered prefix extension for otherwise identical inputs.
- Chunk size, worker yield cadence, cache state, neighboring tile requests, and tile request order do not change a retained selection.
- Presentation LOD changes inclusion only. It does not modify ID64, position, stellar class, mass, radius, temperature, or display color.
- Adjacent same-level tiles use half-open bounds and cannot contain the same System.

ED3DM must preserve that contract. Do not add a second spatial jitter, random thinning pass, source-boxel offset, coordinate normalization, or class/color substitution after decoding PEGE output.

## What changed from PEGE 1.4

The whole-galaxy 5,000-System prefix changed from 473 represented source boxels to 1,790. The maximum contribution from one source boxel dropped from 32 to 4, and the number of Systems in 24-through-32 occupancy groups dropped from 3,465 to zero.

The final 50,000-System regression produced:

| Metric | Result |
| --- | ---: |
| Selected Systems | 50,000 |
| Distinct source boxels | 17,806 |
| Maximum selected per source boxel | 4 |
| Systems in old 24-32 occupancy groups | 0 |
| Occupied 1,280 ly strata | 6,312 |
| Peak V8 heap under a 512 MiB ceiling | 469.0 MiB |
| Engine cache high-water mark | 14,357,902 bytes |

The new selection uses live procedural probing. It does not load a precomputed star catalogue or synthetic LOD cloud.

## New public spatial contract

Import these from `pege` after the v1.5 release:

```ts
import {
  GALAXY_SPATIAL_SELECTION_VERSION,
  GALAXY_VIEW_TILE_EDGE_FIXED,
  galaxyViewTileBounds,
  galaxyViewTileKeyString,
  estimateGalaxyViewTilePopulation,
  recommendGalaxyViewTileTargets,
  streamPackedGalaxyTilesAsync,
  streamPackedGalaxyViewAsync,
  type GalaxyViewTileKey,
} from "pege";
```

Important values:

- `GALAXY_SPATIAL_SELECTION_VERSION === 2`
- `GALAXY_VIEW_TILE_EDGE_FIXED === 40_960`, equal to 1,280 light years at PEGE's 32 fixed units per light year
- tile levels are integers from 0 through 20
- each level doubles the tile edge
- tile origins are anchored to fixed coordinate zero, not the current camera or request minimum
- `galaxyViewTileKeyString({ level, x, y, z })` returns `level/x/y/z`

`GalaxyViewSampleMetadata` now includes `spatialSelectionVersion`. Treat the final emitted chunk's sample as the cumulative final diagnostic snapshot; do not sum cumulative counters across chunks.

## Stage 1: upgrade the existing overview

The existing ED3DM worker already calls `streamPackedGalaxyViewAsync()` correctly in `src/pege-worker.ts::overview()`. That call remains source-compatible. Preserve:

```ts
for await (const chunk of streamPackedGalaxyViewAsync(
  pege,
  {
    minimumFixedXyz: request.minimumFixedXyz,
    maximumExclusiveFixedXyz: request.maximumExclusiveFixedXyz,
    targetSystems: request.targetSystems,
    selectionSeed: BigInt(request.selectionSeed),
    attributes: "spatial-primary-render",
    stellarLod: request.stellarLod,
  },
  {
    signal: controller.signal,
    maxChunkBytes: 4 * 1024 * 1024,
    yieldEveryBoxels: 8,
  },
)) {
  // Transfer chunk.records, chunk.stellarRecords, and chunk.stellarRadii.
}
```

Optional `GalaxyViewStreamOptions.cacheTrimTargetBytes` controls how far PEGE trims its generated-boxel cache between fixed selection windows and when a stream closes. The default is the smaller of 16 MiB and the engine cache budget. Keep the default initially unless measurement proves a different browser-specific tradeoff is needed.

Continue transferring the three aligned buffers directly. Do not call `resolveAddress()`, `resolveStellarProfile()`, or `withStellarProfiles()` for the streamed overview: `spatial-primary-render` already contains the aligned class/color/mass attribute record and radius sidecar.

The existing prefix-based LOD slider can continue slicing the completed ordered overview. A smaller slice is a stable PEGE prefix and will no longer expose the old 32-System batching.

At a 50,000-System target, the raw primary-render buffers total about 3 MB, so a 4 MiB chunk cap normally produces one final chunk. If ED3DM needs visible incremental arrival during the initial overview, use a smaller cap such as 256 KiB or 1 MiB. Chunk size does not alter the ordered selection. `yieldEveryBoxels` provides cancellation/cooperative scheduling but is not itself a progress callback.

### Required cache migration

`src/pege-overview.ts` currently uses `pege-1.4-view-v1`. Replace it with a PEGE 1.5 namespace that includes spatial selection version 2, for example:

```ts
const PEGE_OVERVIEW_CACHE_VERSION =
  `pege-1.5-spatial-v${GALAXY_SPATIAL_SELECTION_VERSION}`;
```

The complete IndexedDB identity must include:

- deployed runtime URL/version;
- `GALAXY_SPATIAL_SELECTION_VERSION`;
- fixed minimum and maximum bounds;
- maximum target count;
- selection seed;
- Stellar LOD mode and strength;
- final PEGE stream-composition version.

Never read a `pege-1.4-view-v1` entry after upgrading. PEGE 1.4 positions are not corrupt, but its selected identities and order use the obsolete clustering policy.

In `demo/main.ts`, rename `pegeRuntimeV14Url` to the v1.5 equivalent and change the query-string version to `v=1.5.0` so browsers and CDNs cannot reuse the old runtime asset response.

## Stage 2: stable spatial tiles

Use tiles to add or remove camera-local detail without regenerating or reshuffling unchanged areas. ED3DM owns tile visibility, target budgets, residency, and GPU lifetime. PEGE owns exact selection inside each requested tile.

The engine request shape is:

```ts
const request = {
  tiles: [
    { key: { level: 2, x: 0, y: 0, z: 4 }, targetSystems: 8_000 },
    { key: { level: 0, x: 0, y: 0, z: 0 }, targetSystems: 20_000 },
  ],
  selectionSeed: 42n,
  attributes: "spatial-primary-render" as const,
  stellarLod: { mode: "presentation-balanced" as const, strength: 1 },
};

for await (const chunk of streamPackedGalaxyTilesAsync(pege, request, {
  signal: controller.signal,
  maxChunkBytes: 4 * 1024 * 1024,
  yieldEveryBoxels: 8,
})) {
  postMessage({
    type: "tile-batch",
    tileKey: chunk.tileKeyString,
    selectionOffset: chunk.sample.selectionOffset,
    batch: {
      records: chunk.records,
      names: chunk.names,
      stellarRecords: chunk.stellarRecords,
      stellarRadii: chunk.stellarRadii,
    },
  }, [chunk.records, chunk.stellarRecords, chunk.stellarRadii]);
}
```

`selectionOffset` is tile-local. Chunks are grouped in caller tile order, but the contents of each tile are independent of that order.

### Recommended ED3DM ownership model

Add a tile request/response path to `src/pege-protocol.ts` rather than overloading the one-shot overview response. A practical frontend state model is:

```ts
type ResidentPegeTile = {
  key: string;
  level: number;
  targetSystems: number;
  systems: System[];
  complete: boolean;
  lastUsedFrame: number;
};
```

Keep a `Map<string, ResidentPegeTile>` in the source/map ownership layer. The camera/frustum controller computes the desired canonical keys. Reconcile desired and resident sets by:

1. retaining unchanged keys without requesting them again;
2. requesting missing keys in the Worker;
3. replacing a tile only after its complete replacement has arrived;
4. cancelling obsolete in-flight requests;
5. evicting least-recently-used tiles when the ED3DM-owned CPU/GPU budget is reached;
6. disposing replaced GPU buffers explicitly.

ED3DM already uses the word "tile" for imported static catalogue cells and files. Name the new frontend types `PegeSpatialTileKey`, `ResidentPegeTile`, or similarly explicit names so catalogue tiles and procedural PEGE tiles cannot be confused in cache or disposal logic.

Do not publish partial tile data to IndexedDB as a completed entry. Buffer chunks under a request generation and commit only after the Worker reports completion. A cancelled request must not overwrite a prior complete tile.

### Tile cache identity

A persistent tile key should include at least:

```text
pege-tile:<runtime-version>:spatial-2:<level/x/y/z>:<target>:<seed>:<lod-mode>:<strength>
```

Use `galaxyViewTileKeyString()` rather than reproducing its formatting. If a tile target increases, PEGE returns an exact prefix extension, but storing a replacement complete tile is simpler and safer than appending unless ED3DM explicitly validates the stored prefix length and selection inputs.

### Overlapping hierarchy levels

Different tile levels may overlap and can legitimately select the same ID64. Choose one of these composition rules:

- replace a covered coarse tile with its finer descendants; or
- de-duplicate the combined render set by ID64.

Do not render both copies, because duplicate points will appear brighter and distort picking counts. Same-level adjacent tiles do not require this de-duplication because their bounds are half-open and disjoint.

## Population-guided point budgets

Do not give every visible tile the same target. That would overstate sparse space and understate the core.

For a set of same-level visible keys:

```ts
const estimates = visibleKeys.map((key) =>
  estimateGalaxyViewTilePopulation(pege, key),
);

const requests = recommendGalaxyViewTileTargets(estimates, totalPointBudget)
  .map(({ key, targetSystems }) => ({ key, targetSystems }));
```

`populationWeight` is a deterministic relative weight based on a fixed 2 by 2 by 2 probe lattice across all eight mass codes. It is suitable for distributing a budget among same-sized tiles. It is not an exact System count, rendered count, discovery probability, or complete density measurement.

When the total budget is at least the number of tiles, the recommendation gives every tile at least one representative before density-weighting the remainder.

Cache population estimates by tile key and runtime version. They are cheap compared with complete generation but still perform procedural population probes.

## Stellar presentation

PEGE 1.5's `presentation-balanced` policy reduces early retention of hot O/B/A primaries and retains warmer classes more strongly. This allows warm stars to remain visible at restrictive LOD without recoloring or changing any retained star's profile.

ED3DM should continue reading `displayColor` from the packed stellar record and radius from the aligned radius buffer. Keep the existing Realistic shader/theme responsible for exposure, opacity, bloom, minimum screen size, and tone mapping. Do not infer that PEGE's inclusion weights are color multipliers.

If the UI exposes custom class filtering, use PEGE's `class-weighted` retention input when generating a new selection. A post-generation visibility filter is also valid for instant UI interaction, but it cannot recover a class that the current cached selection excluded. Changing the PEGE Stellar LOD policy or strength requires a different cache key and regeneration.

## Authored-name composition

PEGE owns the authored catalogue and emits the final System stream after grafting authored names onto their generated identities. ED3DM must not decode that catalogue into a second spatial population or render authored entries outside the representative prefix.

Catalogue position knowledge may remain internal to PEGE when reconstruction depends on it. At the consumer boundary, authored-name Systems count against the requested representative target and obey exactly the same LOD, de-duplication, brightness, and selection rules as other Systems.

## Memory and cancellation

- One primary-render System occupies 60 raw bytes: 24 spatial, 32 stellar, and 4 radius bytes, excluding names and JavaScript object expansion.
- PEGE bounds its candidate reservoir at 1,024 Systems per selection window.
- The view stream trims engine cache state between windows and again in `finally`, including cancellation.
- Keep generation inside `src/pege-worker.ts`.
- Transfer, rather than clone, packed buffers to the main thread.
- Retain `pege.clearCaches()` after persistent ownership has moved out of the Worker.
- Count expanded `System[]`, IndexedDB payloads, and GPU buffers as ED3DM-owned memory; PEGE's `cacheStats()` does not include them.
- Cancel superseded overview/tile generations with `AbortController` and use a request generation/revision so late messages cannot mutate current state.

The validated 50,000-System diagnostic regression took about 15.4 minutes under a forced 512 MiB V8 heap ceiling. That figure also includes calibration-only population recomputation and nearest-neighbor analysis, so it is not a browser stream-throughput benchmark. The underlying traversal still visited 176,384 boxels, including 152,159 predicted empty boxels. Browser work must therefore remain asynchronous, cancellable, cached, and progressively committed in suitably sized chunks or tiles. Do not block initial UI interaction waiting for every detail tile.

## Files expected to change in ED3DM

Minimum PEGE 1.5 overview upgrade:

- `package.json` and lockfile: pin the released v1.5 tag;
- `demo/main.ts`: v1.5 runtime cache-buster;
- `src/pege-overview.ts`: spatial-selection-v2 IndexedDB namespace;
- tests covering cache invalidation and the retained overview prefix contract.

Tile integration:

- `src/pege-protocol.ts`: tile request, batch, progress, completion, and cancellation messages;
- `src/pege-worker.ts`: call tile population helpers and `streamPackedGalaxyTilesAsync()`;
- `src/pege-source.ts`: tile cache/residency and generation ownership;
- `src/types.ts`: camera-agnostic source tile request/result types if the public source interface needs them;
- `src/index.ts`: reconcile visible/resident PEGE tiles and compose them with the coarse overview;
- scene/orb ownership: incremental GPU buffer replacement/disposal rather than rebuilding unrelated retained tiles.

Do not put PEGE tile math into `scene.ts`, and do not pass Three.js camera objects into the Worker or engine. Convert camera/frustum state into canonical PEGE tile keys at the ED3DM boundary.

## Required frontend tests

1. PEGE 1.4 IndexedDB entries are ignored after the upgrade.
2. Runtime URL and package version both identify v1.5.
3. A smaller overview LOD is the exact prefix of a larger one.
4. Chunk-size changes do not change the ordered ID64 sequence.
5. Decoded coordinates and stellar attributes remain aligned by index.
6. No frontend transformation changes PEGE fixed coordinates before rendering conversion.
7. One tile is identical alone, with a neighbor, and in reversed request order.
8. Adjacent same-level tiles contain no duplicate ID64.
9. Coarse/fine overlap follows the chosen replace-or-deduplicate rule.
10. Dense and sparse same-level tiles receive different recommended budgets while both remain represented.
11. Cancellation cannot publish a partial tile or overwrite a complete prior generation.
12. Eviction disposes CPU/GPU ownership without clearing unrelated resident tiles.
13. Authored names arrive in PEGE's final stream, obey the same prefix LOD, and do not render twice.
14. Realistic color comes from packed stellar attributes; LOD inclusion is not applied as a color multiplier.
15. Existing exact local-region generation, search, picking, and journal overlays remain green.

## Acceptance checklist

The ED3DM integration is complete when:

- production is pinned to the released PEGE v1.5 tag and matching runtime;
- every PEGE 1.4 selection cache is invalidated;
- the whole-galaxy view no longer displays isolated 32-star boxel cubes;
- changing the LOD slider reveals a stable prefix rather than reshuffling retained stars;
- no coordinate jitter or synthetic filler exists anywhere in the frontend path;
- stable tiles can be retained, independently regenerated, cancelled, and evicted;
- overlapping hierarchy levels do not double-render an ID64;
- dense tiles receive a larger point budget without eliminating sparse tiles;
- star class/color/radius remain aligned with the selected ID64;
- initial interaction stays responsive while broad or tile generation continues in the Worker;
- automated tests cover cache migration, identity stability, tile composition, cancellation, and buffer disposal.

## Engine references

- [PEGE 1.5 spatial tile documentation](https://github.com/Fenris159/PEGE-Source/blob/feat/coverage-first-spatial-sampling/product/docs/spatial-tiles.md)
- [PEGE 1.5 calibration results](https://github.com/Fenris159/PEGE-Source/blob/feat/coverage-first-spatial-sampling/docs/spatial-calibration-v1.5.md)
- [PEGE 1.5 source PR](https://github.com/Fenris159/PEGE-Source/pull/9)
