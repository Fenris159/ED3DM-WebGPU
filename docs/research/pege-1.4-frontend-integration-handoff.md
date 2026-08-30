# PEGE 1.4 front-end integration handoff

Date: 2026-08-26  
Audience: agent implementing the PEGE upgrade in `ED3DM-WebGPU`  
Upstream release: [PEGE v1.4.0](https://github.com/Fenris159/PEGE/releases/tag/v1.4.0)  
Primary guide: [Class-aware galaxy views](https://github.com/Fenris159/PEGE/blob/v1.4.0/docs/galaxy-view-stream.md)

## Outcome

Upgrade ED3DM from PEGE 1.3 to 1.4 and replace its handcrafted whole-galaxy overview sampler with `streamPackedGalaxyViewAsync()`. The resulting overview must contain only real PEGE Systems at exact PEGE positions, retain warm stellar classes more successfully at restrictive LODs, remain deterministic and memory-bounded, and continue using ED3DM's existing **Realistic** theme for final presentation.

Keep the ownership seam explicit:

- PEGE chooses which real Systems form a representative point-budgeted view and supplies packed stellar facts plus provenance.
- ED3DM owns GPU lifetime, filters, UI, color-space conversion, tone mapping, opacity, point size, bloom, and camera-dependent presentation.

The integration is complete when every acceptance criterion at the end of this document passes.

## Verified current ED3DM baseline

The current checkout still has these PEGE 1.3 assumptions:

- `package.json` and `package-lock.json` pin `github:Fenris159/PEGE#v1.3.0`.
- `demo/main.ts` appends a `v=1.3.0` runtime cache token.
- `src/pege-source.ts` uses `pege-1.3-overview-v17` as its IndexedDB overview key.
- `src/pege-worker.ts::overview()` manually constructs coarse mass-code 4–7 probes, generates complete boxels, and samples them locally.
- `src/index.ts::allSystems()` applies a second ID64 hash threshold to the persistent overview.
- `unpackPegeBatch()` infers the entire profile's provenance from `ExactDisplayColor`, which is no longer sufficiently precise now that PEGE exposes per-field validation.

The existing PEGE 1.3 improvements are sound and should be retained: one long-lived Worker engine, a 128 MiB/96 MiB cache policy, 4 MiB transferable chunks, aligned spatial/stellar/radius buffers, cancellation, and `clearCaches()` after the persistent overview transfers to the main thread.

## What PEGE 1.4 adds

### Representative galaxy-view stream

`streamPackedGalaxyViewAsync()` accepts fixed spatial bounds, a target System count, a stable seed, and a stellar LOD policy. It traverses all eight mass codes internally, skips predicted-empty boxels before positional replay, returns only real Systems with exact generated positions, and emits aligned primary-render buffers.

Three policies are available:

- `natural`: no extra class-retention bias inside the sampler.
- `presentation-balanced`: the recommended ED3DM overview policy. Hot visually dominant classes disappear sooner so warmer classes remain visible.
- `class-weighted`: caller-supplied relative retention by exported `StellarType`, with optional `unknownRetention` and `strength`.

The built-in presentation policy uses these versioned relative retentions:

| Primary class | Retention |
| --- | ---: |
| O | 0.15 |
| B | 0.25 |
| A | 0.60 |
| F | 0.90 |
| A blue-white supergiant | 0.35 |
| F white supergiant | 0.75 |
| W, WN, WNC, WC, WO | 0.40 |
| Other and unknown | 1.00 |

`strength` ranges from 0 through 1. Zero is neutral; one applies the complete policy. Keep the first ED3DM integration on `{ mode: "presentation-balanced", strength: 1 }`. Add a private configuration seam if useful, but no new user-facing theme or control is required.

### Stable nested LOD

For identical bounds, seed, policy, and runtime data:

- selection and order are deterministic;
- chunk size, scheduler frequency, and cache state do not change identity;
- target `N` is an exact prefix of target `M` when `N < M`;
- every ID64 occurs at most once in the PEGE selection;
- every returned coordinate remains inside the requested half-open AABB.

Use that prefix property in ED3DM. A resident maximum-budget overview can serve lower LODs by taking a prefix. Applying ED3DM's current `overviewLodScore()` hash to the PEGE selection throws away this contract and should be removed from the PEGE overview path.

### Per-field stellar provenance

PEGE still emits a 32-byte stellar record and one aligned `float32` radius per System. The low 24 bits of the flags word now independently describe exact or estimated values:

- `ExactPrimaryClass` / `EstimatedPrimaryClass`
- `ExactPrimaryMass` / `EstimatedPrimaryMass`
- `ExactPrimaryTemperature` / `EstimatedPrimaryTemperature`
- `ExactPrimaryRadius` / `EstimatedPrimaryRadius`
- `ExactDisplayColor` / `EstimatedDisplayColor`

Presence is still controlled by `HasProfile`, `HasPrimaryMass`, `HasPrimaryTemperature`, `HasTotalMass`, and `HasDisplayColor`. The star count occupies the high byte.

Compiled catalogue fields set exact flags where present. Ordinary procedural primaries currently have exact recovered mass, estimated class, and estimated palette color; temperature and radius remain absent. A present field with neither exact nor estimated set is observed/application-owned. `ExactDisplayColor` does not imply that the primary class is exact.

PEGE does not yet claim complete multiple-star hierarchy for generated Systems. Profiles remain partial until companion generation is resolved. Preserve missing values instead of inventing temperature, radius, luminosity, companion count, or magnitude.

### Population preflight and metadata

`Pege.estimateBoxelPopulation()` exposes authored, bootstrap, ordinary, constrained, and total counts without positional replay. The view stream uses this internally and reuses the result for non-empty generation through a bounded handoff, reducing duplicate work without creating an unbounded population cache.

Each view chunk includes cumulative `sample` metadata:

- `selectionOffset` is the chunk's first index in the complete selection;
- `boxelsVisited` and `boxelsVisitedByMassCode` are cumulative;
- `emptyBoxelsSkipped`, `unresolvedBoxelsSkipped`, and `candidateSystemsConsidered` are cumulative;
- `selectedByMassCode`, `selectedByStellarClass`, and `selectedUnknownClassCount` are cumulative.

Do not sum these counters across chunks. The final emitted chunk contains the final cumulative snapshot. A heavily filtered or sparse request may finish below `targetSystems`; completion of the async iterator is authoritative.

### Calibration evidence

PEGE's fixed 512-System seed-42 fixture changes O/B/A primaries from 238 under `natural` to 180 under `presentation-balanced`, while G/K/M rises from 188 to 231. This proves the intended direction for the selection policy; it is not a claim of an exact whole-galaxy inclusion probability or a Frontier renderer calibration.

## Implementation sequence

### 1. Upgrade and invalidate versioned assets

Update the dependency and lockfile to:

```json
"pege": "github:Fenris159/PEGE#v1.4.0"
```

Run the package manager rather than editing the resolved lock entry manually. Update the demo runtime query token from `v=1.3.0` to `v=1.4.0`.

Replace `pege-1.3-overview-v17` with a new v1.4 cache namespace. Include every selection input in the cache identity: runtime URL/version, fixed bounds, maximum target, seed, policy mode, strength, and any authored-landmark overlay version. A safe shape is:

```text
pege-1.4-view-v1:<runtime>:<target>:<seed>:<policy>:<strength>:<landmarks>
```

Completion criterion: the installed declarations export `streamPackedGalaxyViewAsync`, the browser fetches the v1.4 runtime, and no v1.3 overview can be read from IndexedDB.

### 2. Extend the Worker protocol narrowly

Add the view request inputs needed by the overview Worker. Keep them internal to `PegeGalaxySource` unless a real UI requirement exists.

Suggested request shape:

```ts
type PegeOverviewRequest = {
  type: "overview";
  requestId: number;
  targetSystems: number;
  selectionSeed: string;
  stellarLod: {
    mode: "presentation-balanced";
    strength: number;
  };
};
```

A decimal string avoids transport assumptions; convert it to `BigInt` in the Worker. Structured cloning also supports `bigint` in the supported browsers, so using the PEGE type directly is acceptable if the project prefers it.

Add optional sample telemetry to the batch or progress response only if ED3DM will inspect it. Keep cumulative semantics explicit in the type name or field comments.

Completion criterion: Worker requests encode the complete cache identity and cancellation continues to target the correct request ID.

### 3. Replace the handcrafted whole-galaxy sampler

Import `streamPackedGalaxyViewAsync` from `pege`. In `src/pege-worker.ts::overview()`, replace the custom `sampleStep`, `gAddresses`, mass-code target, vertical probe, `densitySampleCount()`, and per-boxel packing loop with the PEGE view stream.

Use the existing broad overview bounds unless a separate product decision changes them:

```ts
const minimumFixedXyz = [-40_000 * 32, -5_000 * 32, -14_100 * 32] as const;
const maximumExclusiveFixedXyz = [40_100 * 32, 5_000 * 32, 66_000 * 32] as const;

for await (const chunk of streamPackedGalaxyViewAsync(
  pege,
  {
    minimumFixedXyz,
    maximumExclusiveFixedXyz,
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
  const batch: PackedSystemBatch = {
    records: chunk.records,
    names: chunk.names,
    stellarRecords: chunk.stellarRecords,
    stellarRadii: chunk.stellarRadii,
  };
  respond(
    { type: "batch", requestId: request.requestId, batch },
    [batch.records, batch.stellarRecords!, batch.stellarRadii!],
  );
  respond({
    type: "progress",
    requestId: request.requestId,
    phase: "overview",
    completed: chunk.sample.selectionOffset + chunk.systemCount,
    total: request.targetSystems,
  });
}
```

Do not call `withStellarProfiles()` on view chunks. They already contain aligned primary records and radii without per-System profile-object allocation. Preserve `pege.clearCaches()` after the persistent result has transferred and cancellation has settled.

Choose `targetSystems` from an explicit memory/visual budget. Begin near the current persistent overview's measured System count rather than guessing from the 400-billion-System galaxy. At 60 packed bytes per selected System, 500,000 Systems represent about 28.6 MiB of raw PEGE buffers before ED3DM object expansion and GPU copies. Measure the expanded `System[]`, IndexedDB, and GPU ownership separately.

Completion criterion: the overview Worker no longer chooses mass codes or boxel addresses and emits aligned 24/32/4-byte buffers directly from the PEGE view stream.

### 4. Preserve authored landmarks without corrupting the sample

Authored-name search and autocomplete continue to use PEGE's full authored table and require no view-stream change.

For rendered landmarks, decide explicitly whether to retain the existing spatially capped `sampleAuthoredSystems()` overlay:

- Recommended first migration: keep it as a separate always-visible landmark overlay, then deduplicate by ID64 against PEGE view output.
- Simpler alternative: remove the separate overlay and accept only authored Systems naturally selected by the PEGE view.

Do not count an appended landmark overlay as part of PEGE's `targetSystems`, selection histograms, or prefix. Avoid storing duplicate authored Systems in the persistent `System[]` merely because the final render merge later deduplicates them.

Completion criterion: every rendered authored landmark has one ID64 instance, while full authored autocomplete remains unchanged.

### 5. Use PEGE prefix order for the overview LOD

Keep the maximum PEGE overview in emitted order. Replace `overviewScore()` filtering for `sourceOverviewSystems` with a prefix count derived from the current LOD control. Preserve any authored-landmark overlay separately.

Conceptually:

```ts
const selectedCount = overviewCountForLod(pegeOverviewSystems.length, lod);
for (const system of pegeOverviewSystems.slice(0, selectedCount)) {
  merged.set(systemKey(system), system);
}
for (const landmark of authoredLandmarks) {
  merged.set(systemKey(landmark), landmark);
}
```

Keep `overviewCountForLod()` monotonic. Raising the point budget must only append Systems; lowering it must remove a suffix. This is the mechanism that makes LOD changes stable and preserves PEGE's class-aware disappearance order.

Changing `stellarLod.strength`, policy, seed, bounds, or runtime data creates a different deterministic view and requires overview regeneration plus cache invalidation.

Treat the whole-galaxy resident reservoir and **All Visible** as different operations. **All Visible** can enumerate mass codes 0 through 7 only for a deliberately small active region; it cannot mean loading every System in the galaxy into browser memory.

Completion criterion: repeated LOD changes produce nested identity sets without flicker from re-hashing, and increasing LOD restores the same ID64s in the same order.

### 6. Decode field-level provenance correctly

Continue reading spatial and stellar buffers by aligned index. Update `System` or an internal stellar descriptor so class, mass, temperature, radius, and display color can carry independent validation.

At minimum, stop using `ExactDisplayColor` as the proxy for the entire profile source. Decode with the exported enum:

```ts
function validationFor(
  flags: number,
  exact: StellarSystemAttributeFlags,
  estimated: StellarSystemAttributeFlags,
): "exact" | "observed" | "estimated" {
  if (flags & exact) return "exact";
  if (flags & estimated) return "estimated";
  return "observed";
}
```

Only call it for a present field. Preserve `NaN`/missing values as `undefined`. Keep the base packed color as the System's stellar color; never change the reported stellar class to alter visual balance.

If the current public `System` type should remain compact, add one structured optional field rather than five unrelated strings, for example:

```ts
stellarValidation?: {
  starType?: "exact" | "observed" | "estimated";
  mass?: "exact" | "observed" | "estimated";
  temperature?: "exact" | "observed" | "estimated";
  radius?: "exact" | "observed" | "estimated";
  displayColor?: "exact" | "observed" | "estimated";
};
```

Completion criterion: tests demonstrate the valid combination `EstimatedPrimaryClass + ExactPrimaryMass + EstimatedDisplayColor`, and compiled exact fields remain exact.

### 7. Keep visual presentation in ED3DM

The PEGE packed color is base sRGB. The renderer should convert it consistently with the renderer's color-management pipeline before exposure or tone mapping.

Within the existing **Realistic** theme, ED3DM may:

- desaturate hot highlights toward white;
- apply restrained far-view white balance;
- compress apparent size and brightness for extremely hot primaries;
- preserve enough contribution from warm primaries;
- reduce the far-view correction as the camera enters local detail;
- derive size/bloom only from present physical fields with documented clamps.

Filtering and selected-System details must use the unmodified PEGE class and physical values. PEGE's class retention changes visibility, not identity, class, color, mass, or position.

Completion criterion: changing the Realistic appearance curve changes pixels only; System data and filter results remain unchanged.

### 8. Retain bounded ownership and responsive cancellation

Maintain these boundaries:

- one long-lived decoded dataset and `Pege` instance in the Worker;
- 128 MiB engine cache with the existing trim target unless measurement supports a change;
- 4 MiB PEGE output chunks;
- transfer all three buffers instead of copying them through `postMessage`;
- release engine procedural caches after overview ownership moves to the main thread/IndexedDB;
- abort superseded requests and discard partial overview results;
- count expanded `System[]`, IndexedDB payloads, and GPU buffers as ED3DM-owned memory.

`maxChunkBytes` bounds emitted 24-byte spatial, 32-byte stellar, and 4-byte radius buffers. PEGE must still generate and temporarily pack one complete source boxel while inspecting its class. Do not describe the chunk limit as a total Worker heap cap.

Completion criterion: repeated overview generation and local navigation plateau under the chosen engine cache budget, and cancellation completes between boxels/chunks without retaining a partial persistent cache entry.

## Required tests

Add or update focused tests before changing visual tuning:

1. Dependency and runtime cache identity report v1.4.0.
2. Worker overview uses `streamPackedGalaxyViewAsync()` with all-mass selection hidden inside PEGE.
3. Every batch has equal System counts across `records`, `stellarRecords`, and `stellarRadii`.
4. `selectionOffset` plus chunk-local count preserves stream order across arbitrary chunk sizes.
5. Two equal requests return identical ordered ID64s.
6. A smaller point budget equals the prefix of a larger budget.
7. LOD changes use prefixes rather than `overviewLodScore()` on PEGE view Systems.
8. Rendered overview IDs are unique after the optional authored-landmark overlay.
9. Coordinates lie inside the request and retain `ExactPosition`.
10. Presentation-balanced fixture data contains fewer O/B/A and more G/K/M primaries than a same-seed natural fixture.
11. Procedural packed provenance decodes estimated class, exact mass, estimated color, and missing temperature/radius.
12. Compiled packed provenance decodes exact present fields.
13. Cancellation stops Worker emission and prevents partial IndexedDB publication.
14. Existing local-region generation, search, autocomplete, display-name lookup, filters, and selection tests remain green.
15. A browser smoke test confirms no detached/transferred buffer is read after `postMessage`.

Run:

```bash
npm run typecheck
npm test
npm run build
```

Then perform a visual comparison at the same camera pose and point budget. Record selected counts by class and visible GPU count before comparing color, bloom, or exposure. This separates population-selection improvements from renderer-presentation changes.

## Expected cleanup after migration

Once tests prove the new overview path, remove overview-only code that has no remaining caller:

- coarse `gAddresses` construction;
- overview mass-code interpolation;
- overview vertical probe generation;
- overview `densitySampleCount()` calls;
- old overview engine-rotation/probe comments;
- PEGE-overview use of `overviewLodScore()`;
- stale PEGE 1.1–1.3 research claims from user-facing pointers.

Retain helpers still used by bounded local-region generation. Let TypeScript and search results prove that a helper is dead before removing it.

## Non-goals

- Synthetic density particles or impostor stars
- Exact per-System statistical inclusion probabilities
- Planet or non-stellar body generation
- Complete procedural companion hierarchy
- Renderer exposure, bloom, or tone mapping inside PEGE
- A second user-facing visual theme
- Loading every galactic System into browser memory

## Final acceptance criteria

The migration is finished only when:

- ED3DM installs and deploys PEGE v1.4.0 with a new overview cache identity.
- The whole-galaxy overview uses `streamPackedGalaxyViewAsync()` and no front-end mass-code recipe.
- The default overview policy is presentation-balanced and configurable in code.
- LOD point budgets form stable prefixes and preserve real PEGE ID64s and exact positions.
- Warm primary classes are measurably less suppressed than in the PEGE 1.3 overview at a comparable budget.
- Spatial, stellar, and radius records remain aligned through Worker transfer, unpacking, caching, filtering, and rendering.
- Exact, estimated, observed, and missing stellar fields remain distinguishable.
- Authored landmarks are deduplicated and authored autocomplete remains complete.
- Local **All Visible** behavior stays an explicitly bounded regional operation.
- Cache, chunking, cancellation, and Worker ownership tests pass.
- Typecheck, unit tests, production build, and a fixed-camera visual smoke test pass.

