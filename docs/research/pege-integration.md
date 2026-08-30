# PEGE integration research

Research date: 2026-08-25  
PEGE product reviewed: `v1.1.0` / `9781e9b2230e933999ab04856251706ab47170c1`  
PEGE source reviewed: `b20f4e5f4bfc1ecc919e4abe3f8f2b187fc86d21`

## Executive finding

PEGE can replace ED3DM-WebGPU's placeholder overview, search-index, and JSON tile catalogue as the source of **System identity and position**. It is not an HTTP API and it does not render anything. It is a local ECMAScript module plus an approximately 37 MB immutable binary dataset; the intended browser architecture is one long-lived `Pege` instance in a Worker, with asynchronously streamed 24-byte System records transferred to the render thread. The existing ED3DM renderer and Map app therefore remain responsible for camera state, visual themes, selection, labels, controls, LOD policy, and GPU-buffer lifetime. [PEGE package model](https://github.com/Fenris159/PEGE/blob/v1.1.0/docs/getting-started.md#L1-L30) [Worker integration](https://github.com/Fenris159/PEGE/blob/v1.1.0/docs/webgpu-integration.md#L1-L32)

There is one material blocker to the requested realistic theme and star-size filters: **PEGE 1.1 does not generate or return stellar profiles**. It exports profile types, an application-managed `StellarProfileIndex`, filter helpers, and a profile-to-GPU packer, but profiles must already have been supplied by the application (for example from journals or another external store). The regional stream contains only ID64, position, and flags. Consequently, generated Systems currently have no API-provided star color, radius, temperature, class, mass, luminosity, or multiplicity for ED3DM to consume. [Stellar-profile ownership](https://github.com/Fenris159/PEGE/blob/v1.1.0/docs/stellar-profiles.md#L21-L32) [Public engine methods](https://github.com/Fenris159/PEGE/blob/v1.1.0/dist/galaxy-system-engine.d.ts#L45-L54)

That gap should be resolved in PEGE itself before ED3DM claims to color or size every generated System from PEGE data. ED3DM should not invent name-derived spectral colors as a substitute for a realistic theme.

## Package, build, and deployment model

- Install the release from its versioned GitHub tag: `github:Fenris159/PEGE#v1.1.0`. The unscoped npm name belongs to another project. PEGE is ESM-only, exports its package root and `./pege-runtime.bin`, declares `sideEffects: false`, and supports modern browsers, Workers, and Node 18 or newer. [Installation](https://github.com/Fenris159/PEGE/blob/v1.1.0/README.md#L35-L46) [Package exports](https://github.com/Fenris159/PEGE/blob/v1.1.0/package.json#L1-L29)
- Copy `node_modules/pege/data/pege-runtime.bin` into a deployed static-assets location. Fetch and decode it once per Worker, then retain the decoded dataset and `Pege` instance because the engine caches population and ancestor-boxel results. The v1.1.0 file inspected locally is 37,263,836 bytes; PEGE documents it as approximately 37 MB before HTTP compression. [Runtime deployment](https://github.com/Fenris159/PEGE/blob/v1.1.0/docs/runtime-data.md#L1-L24)
- The binary is immutable and checksum/version validated. Content-version its URL and cache it indefinitely; a service worker may precache it. Loading progress should be visible before galaxy navigation is enabled. [Runtime integrity and caching](https://github.com/Fenris159/PEGE/blob/v1.1.0/docs/runtime-data.md#L18-L28)
- The package is Apache-2.0. ED3DM-WebGPU can consume it as a dependency, but distribution needs to retain the dependency's required notices/license rather than treating it as MIT-owned ED3DM source. [PEGE license declaration](https://github.com/Fenris159/PEGE/blob/v1.1.0/package.json#L28-L32)

## Implemented public API

| Need | PEGE 1.1 public operation | Result and integration use |
| --- | --- | --- |
| Initialize | `decodeGalaxyRuntimeData(bytes)`, `new Pege(dataset)` | Decode once and keep one engine per Worker. |
| Resolve ID64 | `resolveAddress(bigint)` | Returns `authored`, `procedural`, or `unknown`; resolved records include the Sol-relative position. ID64 must remain `bigint`. |
| Display name | `resolveDisplayName(bigint)` | Resolves authored, named-region, or procedural-sector display name for a known address. Use only for selections and visible labels. |
| Exact authored name | `resolveAuthoredName(text)` | Returns matched, ambiguous, or not found. |
| Authored autocomplete | `suggestAuthoredNames(prefix, limit)` | Case/Unicode/whitespace-normalized prefix search, 1–100 results, canonical spelling preserved. |
| One boxel | `generateBoxel(address)` | Generates the complete containing boxel and reports generation counts plus unresolved placements. |
| Spatial request | `enumerateGalaxyBoxels(request)` | Lazily enumerates boxels intersecting a fixed-coordinate AABB. |
| GPU stream | `streamPackedGalaxyRegionAsync(engine, request, options)` | Streams one packed `ArrayBuffer` per boxel; supports cooperative scheduling and cancellation. |
| Grid helpers | `decodeBoxelBounds`, `decodeSystemAddressIdentity`, `encodeSystemAddressFromGrid`, `parentBoxelAddress` | Useful for the existing flat/3D boxel grid UI and selection details. |

The complete documented surface is listed in PEGE's [public API reference](https://github.com/Fenris159/PEGE/blob/v1.1.0/docs/api-reference.md#L1-L67). `resolveAddress()` and `resolveDisplayName()` return `unknown` for an address outside generated population or when placement fallback is required; the UI must handle both cases rather than assuming every parsed integer resolves. [Resolution result declarations](https://github.com/Fenris159/PEGE/blob/v1.1.0/dist/galaxy-system-engine.d.ts#L4-L27)

### Packed System output

Each spatial record is a little-endian 24-byte structure:

| Bytes | Field |
| ---: | --- |
| 0–3 | ID64 low `uint32` |
| 4–7 | ID64 high `uint32` |
| 8–11 | X `int32`, 1/32 ly |
| 12–15 | Y `int32`, 1/32 ly |
| 16–19 | Z `int32`, 1/32 ly |
| 20–23 | `GalaxySystemFlags` |

The flags distinguish authored, ordinary, constrained, and exact-position records. The public request coordinate system is signed fixed-point XYZ relative to Sol, with maximum AABB bounds exclusive; generated `starPosXyz` values returned from object-level resolution are in light-years. [Record layout](https://github.com/Fenris159/PEGE/blob/v1.1.0/docs/webgpu-integration.md#L34-L49) [Coordinate convention](https://github.com/Fenris159/PEGE/blob/v1.1.0/docs/api-reference.md#L65-L67)

Names are deliberately not repeated in the spatial buffer. `PackedGalaxyBoxel.names` contains sparse authored names indexed to records, while procedural names should be resolved lazily for selected Systems and visible labels. GPU selection should retain the two ID64 words as stable identity. [Name and identity guidance](https://github.com/Fenris159/PEGE/blob/v1.1.0/docs/webgpu-integration.md#L47-L59)

## Search-bar mapping

The current single search field can support these modes without a JSON search index:

1. **Decimal ID64:** parse losslessly with `BigInt`, call `resolveAddress`, then `resolveDisplayName`; focus the returned `starPosXyz` when resolved.
2. **Authored display name:** call `suggestAuthoredNames(query, limit)` as the user types. Selecting a suggestion already provides its full authored System and position. On submission, `resolveAuthoredName()` can distinguish a unique result from ambiguity or no match. [Authored lookup behavior](https://github.com/Fenris159/PEGE/blob/v1.1.0/docs/api-reference.md#L21-L29)
3. **Already-visible generated name:** ED3DM may search the names it has explicitly resolved and cached for current labels/selections.

**Gap:** PEGE exposes forward resolution from ID64 to a procedural display name, but no inverse parser or galaxy-wide autocomplete for procedural names. The engine method list contains authored-name search only. Arbitrary procedural-name search therefore cannot replace the existing search index in v1.1 without an upstream PEGE method such as `resolveProceduralName(name)` or `resolveSystemName(name)`. [Public engine method list](https://github.com/Fenris159/PEGE/blob/v1.1.0/dist/galaxy-system-engine.d.ts#L45-L54)

## Spatial navigation and renderer ownership

PEGE accepts an axis-aligned bounding box, not camera, frustum, zoom, focus, or screen coordinates. ED3DM must convert its camera-visible/request volume from floating-point light-years into integer `minimumFixedXyz` and exclusive `maximumExclusiveFixedXyz` values, choose `massCodes`, and send that request to the Worker. `massCodes` must be non-empty and each value is an integer from 0 through 7. [Regional request declaration](https://github.com/Fenris159/PEGE/blob/v1.1.0/dist/webgpu-galaxy-stream.d.ts#L26-L39)

Recommended lifecycle:

1. Map app creates ED3DM and supplies a PEGE runtime URL instead of catalogue URLs.
2. ED3DM creates a Worker; the Worker fetches/decodes the runtime and owns one `Pege` instance.
3. Camera idle or a meaningful zoom/focus change produces a new fixed AABB plus active mass-code set.
4. Abort the previous regional request and stream the replacement asynchronously.
5. Transfer each `tile.records` buffer to the render thread without JSON/object expansion; upload or adapt the fixed-point records into ED3DM's instanced-orb buffers.
6. Preserve ID64 low/high alongside every rendered instance for picking. Ask the Worker for display name and object-level resolution only after selection or when a label becomes visible.
7. On destruction, abort generation, terminate the Worker, and dispose ED3DM GPU buffers. `Pege` itself has no public `destroy()` method.

PEGE checks cancellation between generated boxels, not during a single synchronous `generateBoxel()` call. Dense individual boxels may therefore delay cancellation until that boxel completes. The async stream yields to its scheduler every eight boxels by default. [Streaming implementation](https://github.com/Fenris159/PEGE-Source/blob/b20f4e5f4bfc1ecc919e4abe3f8f2b187fc86d21/src/webgpu-galaxy-stream.ts#L116-L152)

PEGE owns generation; ED3DM owns rendering. No PEGE public call changes theme, point size, filters, selection, grid visibility, camera, zoom, or LOD slider state.

## LOD mapping

PEGE has one built-in generation-detail input: the requested `massCodes`. Its documentation explicitly tells callers to choose mass codes according to the current level of detail. It has **no percentage, maximum-System count, point budget, distance falloff, LOD score, zoom parameter, or region-cost estimator** in the v1.1 public request. [PEGE Worker guidance](https://github.com/Fenris159/PEGE/blob/v1.1.0/docs/webgpu-integration.md#L14-L32) [Request type](https://github.com/Fenris159/PEGE/blob/v1.1.0/dist/webgpu-galaxy-stream.d.ts#L26-L39)

The ED3DM policy should therefore combine two controls:

- **Generation detail:** at far zoom request only coarser/higher mass codes; progressively add lower mass codes as the camera approaches. Close `a`/`b` views request all relevant codes. Because a System has one mass code, adding codes produces nested detail rather than duplicates.
- **Render percentage:** after a packed record arrives, compute a permanent score from its ID64 low/high words and compare it with the zoom/slider threshold. This gives stable nested subsets. The ID64—not the display name—must supply the score because names are lazy and may change.

`All Visible` should request mass codes 0–7 for the active AABB and set the render threshold to 100%. It must remain progressive and cancellable and should warn before a very large request. PEGE cannot currently preflight the resulting System count without generating boxels, so the first implementation can report boxel count and streamed System count while offering cancellation. A true preflight estimator would require a new PEGE API.

Percentage thinning in ED3DM reduces upload/draw load but **does not reduce the work PEGE performs inside each requested boxel**, because `streamPackedGalaxyRegionAsync()` generates and packs the whole boxel before yielding it. If the LOD slider must reduce generation cost within a mass code, PEGE needs an upstream streaming option for deterministic sampling or an engine-level LOD threshold. [Whole-boxel packing path](https://github.com/Fenris159/PEGE-Source/blob/b20f4e5f4bfc1ecc919e4abe3f8f2b187fc86d21/src/webgpu-galaxy-stream.ts#L58-L95) [Async generation path](https://github.com/Fenris159/PEGE-Source/blob/b20f4e5f4bfc1ecc919e4abe3f8f2b187fc86d21/src/webgpu-galaxy-stream.ts#L134-L152)

## Filters, realistic color, and orb size

### What the profile model can represent

`StellarComponent` can represent star type, subclass, luminosity class, mass, radius, absolute magnitude, surface temperature, age, hierarchy, orbit, rings, and optional sRGB display color. A `StellarSystemProfile` identifies a primary body and contains one or more components. [Stellar declarations](https://github.com/Fenris159/PEGE/blob/v1.1.0/dist/stellar-system-profile.d.ts#L25-L54)

`matchesStellarSystemFilter()` supports:

- primary star type, luminosity class, mass, temperature, and age;
- matching any component on those fields;
- star-count and total-stellar-mass ranges;
- requiring complete composition.

The existing category filter could eventually be replaced with controls built from this shape. PEGE intentionally leaves the UI, ordering, and visual style to the consuming application. [Filter contract](https://github.com/Fenris159/PEGE/blob/v1.1.0/docs/stellar-profiles.md#L7-L26)

### What PEGE 1.1 actually supplies

The stellar-profile facilities are consumers of application-supplied profiles, not a profile generator:

- `StellarProfileIndex` only stores, resolves, upserts, and deletes profiles supplied to it.
- `matchesStellarSystemFilter()` evaluates a profile already in hand.
- `packStellarSystemAttributes(profiles)` packs profiles supplied in the same order as spatial records; callers pass `undefined` where none exists.
- `Pege.resolveAddress()`, `generateBoxel()`, and regional streaming return no `StellarSystemProfile`.
- `pege-runtime.bin` contains density, authored-System/name/position data, influence volumes, and naming regions—not a generated profile table. The documented runtime API surface exposes no method that produces a profile. [Application-managed overlay](https://github.com/Fenris159/PEGE/blob/v1.1.0/docs/stellar-profiles.md#L21-L32) [Public exports](https://github.com/Fenris159/PEGE-Source/blob/b20f4e5f4bfc1ecc919e4abe3f8f2b187fc86d21/src/runtime-index.ts#L1-L6)

The optional 32-byte attribute buffer packs primary class, class masks, star count/flags, primary mass, primary temperature, total mass, and sRGB color. It does **not** pack `radiusMeters`, luminosity class, absolute magnitude, or age even when a supplied profile contains them. [Packed attribute fields](https://github.com/Fenris159/PEGE/blob/v1.1.0/docs/stellar-profiles.md#L29-L32) [Attribute declaration](https://github.com/Fenris159/PEGE/blob/v1.1.0/dist/stellar-system-profile.d.ts#L96-L112)

### Required behavior for ED3DM

- Keep `paper` and `charcoal` as the two artistic themes using ED3DM-owned palettes.
- In `realistic`, use the primary component's `displayColor.srgb` only when PEGE (after an upstream extension) or an application overlay actually supplies it. Remove the current name-hash `spectralColor()` fallback; a hashed name is not stellar color.
- Use the primary component's `radiusMeters` for one System orb, because one map point represents the System rather than every component. Apply a monotonic, perceptually compressed and clamped scale around a small base size; literal linear astronomical radii would make giants dominate the map. Keep the existing shader's minimum/maximum pixel safeguards.
- Until profiles are available, render a documented neutral color and default orb size. Do not silently infer physical data from ID64, name, or mass code.
- Hide or disable stellar filters whose required profile coverage is absent. The UI should communicate partial coverage rather than treating unknown attributes as a failed match.

PEGE also explicitly does not model planets, markets, factions, traffic, exploration status, or other changing state. Existing economy, allegiance, government, population, body, and station controls therefore require separate optional overlays/backend data and are not PEGE filters. [PEGE scope](https://github.com/Fenris159/PEGE/blob/v1.1.0/README.md#L9-L25)

## ED3DM-WebGPU migration consequences

Before this integration, the ED3DM interface required `catalog.overviewUrl`, loaded JSON tiles and a JSON search index, used category/economy/allegiance/government fields on each `System`, derived realistic colors by hashing the System name, and sized orbs from population. Those seams needed replacement rather than adaptation into fake catalogue objects. The repository paths below now show the resulting implementation rather than that pre-integration baseline: [source contract](../../src/types.ts) [source integration](../../src/index.ts) [physical display scaling](../../src/scene.ts)

Recommended new ED3DM integration shape:

```ts
type PegeOptions = {
  runtimeUrl: string;
  workerUrl?: string;
};

type SystemIdentity = {
  id64Low: number;
  id64High: number;
  positionFixedXyz: readonly [number, number, number];
  flags: number;
};
```

Keep names and stellar profiles lazy and ID64-keyed. Do not construct millions of JavaScript `System` objects or eagerly resolve names merely to satisfy the old catalogue type. The render path should consume transferred typed buffers, while selection/search responses can use small object messages.

Suggested Worker message surface:

- `initialize(runtimeUrl)` → `ready | progress | error`
- `requestRegion(requestId, fixedAabb, massCodes, lodThreshold)` → repeated `boxel` messages then `complete`
- `cancelRegion(requestId)`
- `resolveAddress(id64)` / `resolveDisplayName(id64)`
- `resolveAuthoredName(text)` / `suggestAuthoredNames(text, limit)`

The LOD threshold belongs to ED3DM in v1.1; the Worker can apply it to packed output before transfer, but that still does not reduce PEGE's boxel-generation cost.

## Implemented, internal-only, and missing capability matrix

| Capability | Status in PEGE 1.1 | ED3DM action |
| --- | --- | --- |
| Procedural System existence and placement | Implemented public API | Use `resolveAddress`, `generateBoxel`, regional stream. |
| Authored overlays and canonical names | Implemented public API | Use autocomplete and lazy display-name resolution. |
| Procedural name from known ID64 | Implemented public API | Resolve for selection/labels. |
| Procedural name to ID64 search | Missing | Request upstream API; visible-cache search is only a partial fallback. |
| Spatial region generation | Implemented public API | Worker AABB streaming. |
| Camera/frustum/zoom controls | Not PEGE-owned | Keep in ED3DM. |
| Mass-code generation detail | Implemented public request | Map zoom to a nested mass-code set. |
| Percentage LOD / point budget / count estimate | Missing | Stable ID64 thinning in ED3DM; upstream API needed to reduce generation cost or preflight Systems. |
| Stellar profile schema | Implemented public types | Safe to design UI and overlays around it. |
| Generated stellar profiles | **Missing** | Blocking for PEGE-driven realistic colors, radii, and stellar filters. |
| Profile filtering and GPU packing | Implemented for caller-supplied profiles | Use only when coverage exists. |
| Radius in packed attribute buffer | Missing | Extend PEGE attribute layout or maintain a separate aligned size buffer. |
| Renderer and visual themes | Not PEGE-owned | Retain ED3DM WebGPU renderer and existing visual style. |
| Planets, economy, allegiance, government, live state | Out of scope | Optional external overlays/backend only. |

## Recommended upstream PEGE additions

The requested Map app can integrate positions immediately, but these PEGE additions are needed for the full brief:

1. `resolveStellarProfile(systemAddress)` or a profile attached to address/boxel resolution, backed by deterministic profile generation for procedural Systems and authored overrides where necessary.
2. A regional stellar-attribute stream aligned with each `PackedGalaxyBoxel`, including primary display color and a render-size input (`radiusMeters` or an explicitly defined normalized radius).
3. A reverse procedural-name resolver or unified `resolveSystemName(name)` for galaxy-wide search.
4. Optional deterministic LOD sampling/count estimation in the region streamer so lower percentages reduce generation/transfer work instead of only GPU draw work.

Until item 1 exists, ED3DM can truthfully replace the placeholder catalogue with PEGE's generated Systems and positions, but the realistic theme must remain neutral/default rather than pretending that PEGE supplied physical star color and size.

## Local verification

The PEGE v1.1.0 distribution test suite was run from a clean clone on 2026-08-25: all 5 public-API tests passed. The inspected runtime decoded successfully and reported 143,458 authored Systems and 58 influence volumes. This verification confirms package behavior in the checked-out release; it does not add undocumented APIs to the supported surface.
