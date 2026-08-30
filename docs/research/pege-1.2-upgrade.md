# PEGE 1.2 upgrade research

Research date: 2026-08-26  
PEGE release reviewed: `v1.2.0` / `52ef17cf3cdbb8571262823e5678d21a4d075912`

## Executive finding

PEGE 1.2 supplies the previously missing engine-owned primary Stellar profile resolver. It can now drive the realistic theme's primary-star color and the supported primary-star filters. The release does **not** add a whole-galaxy materialization call, an LOD sampler, or progress events. Regional streaming and its 24-byte position record are unchanged. [Release](https://github.com/Fenris159/PEGE/releases/tag/v1.2.0) [API reference](https://github.com/Fenris159/PEGE/blob/v1.2.0/docs/api-reference.md#L13-L72)

The compact “ball” is not an ID64 coordinate-scale requirement. PEGE positions are already Sol-relative light years, while packed positions are the same XYZ values multiplied by 32. If ED3DM uses one scene unit per light year, a mass-code-A boxel is exactly 10 scene units wide. The renderer must divide packed coordinates by 32 exactly once and must not normalize them to a galaxy radius, fit them into a bounding sphere, or apply an origin offset. [Packed position layout](https://github.com/Fenris159/PEGE/blob/v1.2.0/docs/webgpu-integration.md#L34-L49) [Coordinate convention](https://github.com/Fenris159/PEGE/blob/v1.2.0/docs/api-reference.md#L70-L72)

The likely overview-shape problem is population selection: a far overview generated with only `massCodes: [7]` contains only H-mass boxels. That is a different stellar population, not a representative percentage sample of every System. PEGE's request accepts an AABB and mass-code set but no percentage LOD input. Changing the AABB or mass-code set therefore trims the population; it does not merely thin it. [Region request type](https://github.com/Fenris159/PEGE/blob/v1.2.0/dist/webgpu-galaxy-stream.d.ts#L26-L39)

## Upgrade mechanics and compatibility

- Pin `github:Fenris159/PEGE#v1.2.0` and reinstall so both the module and `data/pege-runtime.bin` move together. PEGE remains ESM-only and is still not the unrelated unscoped npm registry package. [Package installation](https://github.com/Fenris159/PEGE/blob/v1.2.0/README.md#L34-L48)
- The minimum supported Node version changed from 18 to 22. This affects local builds, tests, and CI; it does not change the browser coordinate contract. [Package engines](https://github.com/Fenris159/PEGE/blob/v1.2.0/package.json#L38-L40)
- The runtime grew from 37,263,836 to 42,256,765 bytes and its data format moved from 2 to 3 to include compiled primary-star data. The v1.2 decoder accepts both formats, but a v1.1 decoder cannot consume the new binary. Version the deployed asset URL and invalidate ED3DM's IndexedDB overview/profile cache on upgrade. [Runtime data](https://github.com/Fenris159/PEGE/blob/v1.2.0/docs/runtime-data.md#L1-L28) [Decoder compatibility](https://github.com/Fenris159/PEGE/blob/v1.2.0/dist/galaxy-runtime-data.js#L461-L477)
- No existing public method or regional request field was removed. `resolveStellarProfile()` and its types are additive; the packed System spatial layout remains 24 bytes.

## Persistent galaxy-wide overview and LOD

`decodeGalaxyRuntimeData()` returns a public `GalaxyEngineDataset` containing `authoredSystems`. Each authored record includes ID64, canonical name, and exact Sol-relative `starPosXyz`. There is no dedicated “stream all authored Systems” method, but the decoded array is available before constructing the long-lived `Pege` instance. [Dataset declaration](https://github.com/Fenris159/PEGE/blob/v1.2.0/dist/galaxy-runtime-model.d.ts#L75-L80)

The inspected v1.2 runtime contains 143,458 authored Systems across all mass codes. Their measured coordinate envelope is:

| Axis | Minimum ly | Maximum ly |
| --- | ---: | ---: |
| X | -40,688.625 | 45,131.750 |
| Y | -29,359.8125 | 39,518.34375 |
| Z | -23,405.000 | 46,194.375 |

Their mass-code distribution is `a: 182`, `b: 20,241`, `c: 45,359`, `d: 52,268`, `e: 17,545`, `f: 6,744`, `g: 747`, and `h: 372`. This makes the complete authored array a much better persistent, exact-position map skeleton than a mass-H-only stream. It is PEGE runtime output rather than the removed placeholder JSON catalogue. It is not the complete generated galaxy, and it retains exploration/catalogue sampling bias.

Recommended ED3DM policy:

1. Decode PEGE once in the Worker and retain one engine.
2. Build and upload one fixed `fullOverview` from every authored System. Keep this GPU buffer resident while the map is open.
3. Give every ID64 a stable hash score. Zoom and the LOD slider change only the score threshold. `All Visible` sets the threshold to 1 and draws every resident overview point.
4. Treat nearby procedural streams as an additive detail layer. Camera movement may replace that local layer, but must never replace, recenter, rescale, or crop `fullOverview`.
5. If points behind the camera need to be cheaper, reject them in the shader/frustum draw path while retaining their resident records. Do not use camera visibility to redefine the galaxy's coordinate envelope.
6. If a wider procedural far reservoir is later required, make it a fixed, spatially stratified ID64 sample across the full envelope and all relevant mass codes. Do not treat one mass code as a percentage LOD.

This satisfies “LOD thins, not trims”: the same spatial population persists and lower settings select a stable subset. It also makes a scale regression directly testable by asserting that the GPU envelope, Sol-to-System distances, and 10-light-year grid spacing are unchanged across every LOD setting.

PEGE cannot materialize every generated galaxy System into browser memory. `enumerateGalaxyBoxels()` covers an AABB and selected mass codes, and each streamed boxel is generated completely before it is yielded. Even the full address grid contains 1,048,576 H boxels and roughly 2.2 trillion A boxels. “Load the full galaxy” should therefore mean loading the fixed galaxy-wide overview reservoir, not expanding every theoretical System. [Boxel enumeration](https://github.com/Fenris159/PEGE/blob/v1.2.0/dist/webgpu-galaxy-stream.js#L75-L93) [Async streaming](https://github.com/Fenris159/PEGE/blob/v1.2.0/dist/webgpu-galaxy-stream.js#L108-L125)

## Stellar profile, realistic color, size, and filters

`Pege.resolveStellarProfile(id64)` returns either:

- `resolved` with a `profile` and source `compiled-catalogue` or `procedural-primary-model`; or
- `unknown` with `outside-generated-population`, `placement-fallback-required`, or `stellar-generation-unresolved`.

Compiled catalogue primaries expose exact encoded class, subclass, luminosity class, absolute magnitude, engine-palette color, and whichever physical fields exist in the runtime. Procedural primaries expose exact recovered mass plus an **estimated** main-sequence class and palette color. All current engine profiles are `partial`; companion hierarchies are not complete. [Resolution behavior](https://github.com/Fenris159/PEGE/blob/v1.2.0/docs/stellar-profiles.md#L7-L22) [Resolution type](https://github.com/Fenris159/PEGE/blob/v1.2.0/dist/stellar-system-profile.d.ts#L50-L63)

Concrete UI mapping:

- The realistic theme should use `primary.displayColor.srgb`. Preserve `source` and `validation` so exact compiled color is distinguishable from an estimated procedural color. The two artistic themes remain ED3DM-owned palettes.
- `primary.radiusMeters` is optional and is supplied only where the compiled catalogue contains it. Procedural primaries currently provide `stellarMassSolar` but no radius. Use a compressed/clamped radius scale when radius exists and a documented neutral default when it does not; do not present an inferred procedural radius as engine data. [Component fields](https://github.com/Fenris159/PEGE/blob/v1.2.0/dist/stellar-system-profile.d.ts#L28-L48) [Procedural profile implementation](https://github.com/Fenris159/PEGE/blob/v1.2.0/dist/stellar-system-profile.js#L75-L111)
- The 32-byte packed Stellar attribute buffer includes class masks, mass, temperature, total mass, and color, but not `radiusMeters`. ED3DM needs a small aligned radius/point-size sidecar buffer if sizing is performed in the shader. [Packed profile attributes](https://github.com/Fenris159/PEGE/blob/v1.2.0/docs/stellar-profiles.md#L45-L49)
- Primary type, mass, temperature, luminosity, and color controls can use resolved profiles. Companion/multiplicity controls and “complete composition” must be shown as unavailable or partial because every engine profile is currently partial.
- Regional spatial tiles do not automatically carry profiles. Resolve and pack profiles in the Worker for the records ED3DM will actually draw, transfer the aligned attribute buffer, and cache results by ID64. Avoid returning thousands of profile-shaped JavaScript objects to the main thread.

Local release verification found 143,477 compiled Systems and primary profiles. Sol resolves as an exact compiled G2 V primary with its engine color and radius; a generated procedural sample resolved with exact mass and estimated A-class/color but no radius.

## Full-screen generation progress

PEGE explicitly recommends showing load progress, but v1.2 exposes no progress callback or event. ED3DM must own the full-screen loading state. [Caching guidance](https://github.com/Fenris159/PEGE/blob/v1.2.0/docs/runtime-data.md#L22-L28) [Stream options](https://github.com/Fenris159/PEGE/blob/v1.2.0/dist/webgpu-galaxy-stream.d.ts#L34-L39)

A truthful progress sequence is:

1. **Downloading engine data:** stream `fetch().body` and use `Content-Length` when available.
2. **Decoding galaxy:** show an indeterminate phase because `decodeGalaxyRuntimeData()` is synchronous and has no intermediate callbacks.
3. **Generating overview:** copy/pack the known `authoredSystems.length` records and report an exact processed/total count; report yielded procedural boxels separately if a fixed procedural reservoir is included.
4. **Preparing map:** upload the fixed buffers, render the first frame, then remove the full-screen `Please wait... Generating galaxy` overlay and enable controls.

The overlay should remain until the fixed overview buffer—not merely the 42 MB download—is resident and the first frame has completed. Cached reloads can skip download progress but should still report decode/cache restoration and GPU preparation.

## Local verification

The official v1.2.0 package tests passed on Node 24.14.0: 7 tests, 0 failures. The runtime decoded successfully with 143,458 authored Systems, 143,477 compiled Systems with primary profiles, 58 influence volumes, and 467 naming regions. These observations describe the tagged release and do not imply a supported API beyond its exported declarations.
