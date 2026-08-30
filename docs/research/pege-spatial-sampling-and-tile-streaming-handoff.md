# PEGE spatial sampling and tile-streaming handoff

Date: 2026-08-26  
Audience: agent implementing the next PEGE release  
Consumer: ED3DM-WebGPU  
Baseline: PEGE v1.4.0

## Outcome

Replace PEGE 1.4's visibly boxel-batched galaxy-view selection with a deterministic, coverage-first spatial sampler. The result must still contain only genuine PEGE Systems at their exact generated positions, but restrictive point budgets must cover the requested volume progressively instead of returning dense groups from a small number of source boxels.

The same engine capability must be composable through stable world-space tiles so ED3DM can later request the parts of the galaxy intersecting its camera frustum without reshuffling unchanged tiles.

This work is complete only when the automated distribution, prefix, tile-composition, memory, cancellation, and visual acceptance criteria in this document pass.

## Ownership boundary

PEGE owns:

- System existence, ID64, exact generated position, mass code, generated name, and Stellar profile facts;
- representative selection of real Systems within caller-supplied spatial bounds and point budgets;
- stable selection order, spatial stratification, density weighting, packed attributes, and sampling metadata;
- deterministic tile-local output, cancellation, chunking, and bounded engine memory.

ED3DM owns:

- camera position, orientation, FOV, aspect ratio, and frustum calculations;
- converting the frustum into stable PEGE tile requests and assigning a screen-space point budget;
- resident tile lifetime, GPU culling, LOD controls, themes, grids, regions, picking, and rendering.

PEGE should remain camera-agnostic. It should accept stable world-space bounds or tile descriptors rather than Three.js camera objects. ED3DM will return for the frontend half after this engine release exists.

## Confirmed PEGE 1.4 failure

The failure is selection clustering, not coordinate corruption.

`dist/galaxy-view-stream.js` currently contains this sequence:

1. `SYSTEMS_PER_BOXEL_PROBE` is `32`.
2. `candidateBoxelSample()` generates one source boxel, sorts its accepted Systems, and keeps up to 32.
3. `sampleNextRound()` visits one source boxel per mass code.
4. `selectRoundCandidates()` sorts only that round's candidates and appends them until the target is reached.

This causes the stream to emit many correct positions from one selected boxel while neighboring boxels contribute nothing. At galaxy scale, those Systems appear as isolated cubes or rectangular clouds whose edges follow the source-boxel boundaries.

An ED3DM IndexedDB capture of the PEGE 1.4 whole-galaxy request used these inputs:

```ts
{
  minimumFixedXyz: [-40_000 * 32, -5_000 * 32, -14_100 * 32],
  maximumExclusiveFixedXyz: [40_100 * 32, 5_000 * 32, 66_000 * 32],
  targetSystems: 50_000,
  selectionSeed: 42n,
  attributes: "spatial-primary-render",
  stellarLod: { mode: "presentation-balanced", strength: 1 },
}
```

The captured stream had this source-boxel concentration:

| Prefix | Systems in source boxels with selected occupancy 24-32 | Source boxels with exactly 32 selected Systems |
| ---: | ---: | ---: |
| 5,000 | 69.3% | 96 |
| 10,000 | 68.1% | 193 |
| 25,000 | 68.9% | 494 |
| 50,000 | 68.7% | 957 |

Within the exactly-32 groups, the average normalized coordinate span was approximately `0.937` on X, `0.935` on Y, and `0.935` on Z. The Systems occupy almost the entire containing cube. Their positions are therefore not snapped to a point or scaled incorrectly; PEGE is selecting isolated cubes densely enough to reveal the grid.

The defect remains at every ED3DM LOD because PEGE correctly provides nested prefixes, but every prefix inherits nearly the same source-boxel concentration.

## Required engine changes

### 1. Replace boxel-batch selection with coverage-first selection

`streamPackedGalaxyViewAsync()` must produce one deterministic global order in which spatial coverage develops progressively. Increasing `targetSystems` may add density to already represented areas, but early and medium prefixes must not exhaust a 32-System probe from one source boxel before comparable spatial opportunities have been considered.

Use canonical, camera-independent spatial strata. A hierarchical grid, Morton-ordered octree, or an equivalent deterministic spatial hierarchy is appropriate. The hierarchy must be anchored to PEGE fixed coordinates rather than to the request's moving minimum corner.

The selection sequence should conceptually separate three decisions:

1. **Coverage:** choose the spatial stratum that should receive the next representative.
2. **Population:** use PEGE population or density information to give genuinely dense strata a larger long-term share.
3. **Identity:** choose the real System within that stratum by a deterministic ID64-and-seed priority.

Use weighted-fair scheduling or an equivalent deficit rule so population weighting changes the rate at which a stratum receives additional Systems without allowing one source boxel to contribute a visible block consecutively.

The current per-boxel list of up to 32 candidates may remain an internal probe, but its candidates must be interleaved through the spatial scheduler. `SYSTEMS_PER_BOXEL_PROBE` must not be observable as a recurring occupancy of exactly 32 in the output.

If producing broad coverage by procedural probing is too slow, a versioned PEGE-generated spatial index or LOD pyramid is acceptable. Every stored representative must still identify a genuine PEGE System, retain its exact generated position, and be reproducible from documented build inputs. A precomputed engine index is not permission to introduce synthetic points.

Completion criterion: every tested prefix meets the spatial-concentration bounds below, while the full order remains deterministic and population-aware.

### 2. Preserve stable nested LOD

For identical bounds, seed, Stellar LOD policy, spatial-selection version, and runtime data:

- target `N` must remain the exact ordered prefix of target `M` when `N < M`;
- chunk size, scheduler cadence, cache state, and cancellation history must not alter identity or order;
- each ID64 may appear at most once;
- every coordinate must remain inside the requested half-open AABB;
- class-aware retention may change selection probability but must not change identity, class, color, mass, or position.

The spatial scheduler must build one target-independent order. Do not calculate a different ranking from `targetSystems`, because that would make ED3DM's LOD slider reshuffle the galaxy.

Completion criterion: the existing prefix tests pass for several targets and the new spatial metrics pass independently on each prefix.

### 3. Make view sampling tile-composable

ED3DM needs to retain a coarse whole-galaxy overview and add detail for stable world-space tiles intersecting the camera frustum. PEGE must support this without knowing what a camera is.

At minimum, document and test a canonical tile recipe using the existing `GalaxyViewRequest`:

- tile bounds are expressed in PEGE fixed coordinates;
- tile origins are aligned to a documented global lattice;
- the tile key includes lattice level and integer X/Y/Z indices;
- a tile's selection seed is derived deterministically from the application seed and tile key;
- the output for a tile is unchanged when neighboring tiles are added, removed, or requested in another order;
- increasing one tile's target returns a prefix extension for that tile;
- non-overlapping half-open tile bounds cannot return the same System.

If keeping this contract in consumer code would duplicate nontrivial engine logic, add a small PEGE tile API. A suitable shape is:

```ts
interface GalaxyViewTile {
  readonly key: bigint | string;
  readonly minimumFixedXyz: readonly [number, number, number];
  readonly maximumExclusiveFixedXyz: readonly [number, number, number];
  readonly targetSystems: number;
}

interface GalaxyTileViewRequest {
  readonly tiles: readonly GalaxyViewTile[];
  readonly selectionSeed?: bigint;
  readonly attributes: "spatial-primary-render";
  readonly stellarLod?: StellarLodPolicy;
}
```

The exact names are not prescribed. Preserve the deep interface: the caller supplies stable spatial tiles and budgets; PEGE owns representative selection inside them. Returned chunks must identify their tile and tile-local `selectionOffset` if several tiles share one stream.

Do not accept camera matrices, FOV, screen dimensions, or renderer objects in PEGE. ED3DM will calculate which canonical tiles intersect its frustum.

Completion criterion: a test can rotate or translate a synthetic consumer view, change only the tile set, and prove that every retained tile has bit-for-bit identical ordered output.

### 4. Provide population guidance for tile budgets

Equal point counts per tile would understate the galactic core and overstate sparse space. Give consumers a cheap way to allocate a larger share to dense tiles without generating every System first.

Either:

- expose a bounded arbitrary-AABB population estimate suitable for canonical tiles; or
- include a deterministic population weight in the tile descriptor/metadata produced by a PEGE tile planner.

The estimate may be approximate, but its semantics and inputs must be documented. It must distinguish estimated population from the count actually selected and emitted. Do not present an acceptance weight or sampled count as an exact galactic inclusion probability.

Completion criterion: a fixture demonstrates that a dense-core tile receives a larger recommended share than a same-size sparse outer tile, while both remain spatially represented under a restrictive total budget.

### 5. Extend diagnostic metadata

Keep the current cumulative mass-code, Stellar-class, and work counters. Add enough calibration output to detect spatial batching before release. This may live in a calibration report rather than every production chunk.

Record at least:

- selected Systems per source boxel, grouped by mass code;
- distinct source-boxel count and maximum selected occupancy;
- selected Systems per canonical spatial stratum and hierarchy level;
- occupied-stratum count for standard prefixes;
- population weight versus delivered count by stratum;
- nearest-neighbor or equivalent spatial-gap distribution;
- X/Y/Z coordinate envelope;
- elapsed generation time, cache high-water mark, and peak emitted chunk bytes.

Completion criterion: `npm run calibrate:view` or an equivalent command produces a deterministic spatial report alongside the existing Stellar-class calibration.

### 6. Retain packed alignment, memory bounds, and cancellation

The new sampler must retain PEGE 1.4's working transport contract:

- 24-byte spatial records, 32-byte primary-render records, and one aligned `float32` radius;
- `attributes: "spatial-primary-render"`;
- `maxChunkBytes: 4 * 1024 * 1024` as a supported and recommended setting;
- transferable buffers with no PEGE retention after transfer;
- bounded generated-boxel caches;
- cooperative cancellation between bounded units of work;
- no per-System `resolveAddress()` or `StellarSystemProfile` allocation in the bulk path.

If coverage-first traversal needs a priority queue or candidate reservoir, account for its retained bytes in cache statistics and bound it explicitly. Do not trade the visible clustering defect for an unbounded whole-request heap.

Completion criterion: the standard broad view and a repeated tile sweep plateau under the declared cache/reservoir budget, and cancellation leaves no partial cache publication.

## Required automated tests

Add these tests to PEGE's product test suite:

1. **Regression fixture:** reproduce the broad 50,000-System request shown above.
2. **Source-boxel concentration:** at prefixes 5,000, 10,000, 25,000, and 50,000, no source boxel contributes 24-32 selected Systems merely because of an internal probe cap.
3. **Distinct coverage:** for the broad fixture, at least 80% of the first 50,000 Systems are the first selected representative from their source boxel. If a different threshold is justified by exact population evidence, record the evidence and enforce an equally strong spatial metric.
4. **Occupancy cap:** no source boxel contributes more than four Systems to the first 50,000 unless a versioned calibration fixture identifies that boxel as an intentional density exception. Intentional exceptions must not recur as a constant cap across hundreds of boxels.
5. **Spatial prefixes:** occupied canonical-stratum counts grow monotonically at every standard prefix.
6. **Density preservation:** dense calibrated regions receive more Systems than equal-volume sparse regions, without leaving the sparse regions entirely unrepresented.
7. **Nested identity:** each smaller target is the exact ordered prefix of every larger target for the same inputs.
8. **Tile independence:** one tile's output is identical whether requested alone or with neighboring tiles and regardless of tile request order.
9. **Tile boundaries:** adjacent half-open tiles contain no duplicate ID64 and no System outside its tile bounds.
10. **Chunk independence:** 64 KiB, 1 MiB, and 4 MiB chunk caps produce the same ordered identities.
11. **Real positions:** every record carries `ExactPosition`; decoding its ID64/source boxel confirms that its coordinates lie inside the correct bounds.
12. **No jitter:** sampled coordinates equal the corresponding normal PEGE generation result bit-for-bit.
13. **Class retention:** the existing natural, presentation-balanced, and class-weighted distribution tests remain green.
14. **Packed alignment:** every primary-render record and radius matches the spatial ID64 at the same index.
15. **Memory plateau:** repeated broad and tile requests remain under the documented engine cache and selection-reservoir budgets.
16. **Cancellation:** aborting during traversal, candidate selection, and packing stops within a documented work bound and emits no later chunks.

The numeric coverage bounds apply to representative `GalaxyView` sampling, not exact `GalaxyRegion` enumeration of a deliberately small area.

## Required visual calibration

Generate reproducible images from the 50,000-System fixture before and after the change using identical positions, colors, camera poses, and point sizes:

- top-down X/Z whole-galaxy view;
- edge-on view showing Y thickness;
- 30-45 degree oblique whole-galaxy view;
- medium-distance view centered on Sol;
- medium-distance view in a dense core region;
- a view with all grid and region overlays disabled.

The new images must show continuous representative coverage instead of isolated cubic clouds. The edge-on image may show the galaxy's real thin disc, but it must not acquire repeated box-shaped groups or regular empty bands from the sampler.

Attach the spatial report to the images. A visual improvement without passing the identity, prefix, and coordinate tests is insufficient.

## Compatibility and versioning

Prefer keeping `streamPackedGalaxyViewAsync()` source-compatible unless a new tile interface materially deepens the module. Changing its spatial-selection order requires:

- a new PEGE release tag;
- a documented spatial-selection version;
- updated golden fixtures and calibration output;
- release notes stating that ordered view identities changed intentionally;
- an integration note telling ED3DM to invalidate its persisted overview and tile caches.

Do not change existing ordinary, constrained, or authored System generation results. The release changes representative view membership and order, not the underlying galaxy.

## Non-goals

- Moving, jittering, or visually scattering correct System coordinates
- Synthetic stars, density particles, impostors, or non-System filler
- Camera/frustum mathematics inside PEGE
- GPU visibility culling or behind-camera fading
- ED3DM grid and region-line rendering
- Frontier-specific tone mapping, color grading, bloom, or point size
- Loading every System in the galaxy into browser memory
- Changing ID64, mass code, generated naming, or Stellar profile facts

## Delivery checklist

- Ship a tagged PEGE release containing the coverage-first sampler.
- Document the spatial hierarchy, deterministic ordering, tile recipe/API, population-weight semantics, and cache ownership.
- Publish the before/after 50,000-System spatial report and calibration images.
- Include tests for every standard prefix rather than only the final target.
- Record generation time, retained memory, peak transient memory, maximum emitted chunk size, and cancellation latency.
- State whether the implementation uses live procedural probing or a versioned PEGE-generated LOD index.
- Provide one minimal Worker example using stable tile bounds, `spatial-primary-render`, and a 4 MiB chunk cap.
- Tell ED3DM which cache-selection version must be included in its IndexedDB key.

## Final acceptance criteria

The PEGE work is ready for ED3DM integration when:

- the 32-System probe cap is no longer visible in output occupancy;
- restrictive prefixes spread real Systems progressively across the requested volume;
- dense regions retain proportionally greater representation without becoming isolated source-boxel cubes;
- identical requests remain deterministic, nested, aligned, memory-bounded, and cancellable;
- stable tiles can be independently generated, cached, retained, and combined without reshuffling;
- PEGE exposes enough population guidance for ED3DM to distribute a frustum-wide point budget;
- every emitted point remains a real PEGE System at its exact unmodified generated coordinate;
- the tagged documentation tells ED3DM exactly how to invalidate caches and adopt the new selection contract.
