# PEGE–ED3DM stellar population and presentation handoff

Date: 2026-08-26  
Audience: agent working on PEGE  
Consumer: ED3DM-WebGPU

## Objective

Make ED3DM's existing **Realistic** theme resemble Frontier's galaxy-map presentation without adding another user-facing theme and without changing the identity, position, class, or physical attributes of any System.

There are two distinct problems:

1. **Population selection:** which real PEGE Systems are present at a given LOD.
2. **Visual presentation:** how ED3DM converts each selected System's stellar data into color, brightness, size, opacity, and bloom.

PEGE owns the first problem and the source data for the second. ED3DM owns the final pixels. Keep this seam explicit.

## Ownership decision

### PEGE owns

- System existence, ID64, exact generated position, mass code, and name.
- Primary stellar class, mass, temperature, radius or luminosity when known, base display color, and exact-versus-estimated provenance.
- Deterministic population-aware selection when PEGE returns a representative LOD sample.
- Sampling metadata needed to explain and validate that sample.
- Memory-bounded generation, chunking, cancellation, and stable packed-record alignment.

### ED3DM owns

- sRGB-to-linear conversion and renderer color-space handling.
- Exposure, tone mapping, white balance, saturation, contrast, opacity, point size, and bloom.
- Distance-dependent blending between the whole-galaxy presentation and close local detail.
- The Frontier-calibrated appearance curve inside the existing **Realistic** theme.
- UI controls, camera policy, filters, selection details, and LOD target budgets.

### Shared seam

The shared seam is PEGE's packed primary-render Interface. PEGE describes the real star and the statistical meaning of the sample; ED3DM converts that description into a visual result.

The desired flow is:

```text
PEGE System and population model
  -> representative real-System sample
  -> packed spatial and primary-render attributes
  -> ED3DM Frontier-calibrated Realistic appearance
  -> renderer
```

## Existing PEGE 1.3 capability

PEGE 1.3 already supplies most of the required per-System data through `streamPackedGalaxyRegionAsync()` with:

```ts
{
  attributes: "spatial-primary-render",
  maxChunkBytes: 4 * 1024 * 1024,
}
```

The aligned output contains a 24-byte spatial record, a 32-byte primary stellar record, and one `float32` radius value per System. The stellar record includes primary class, mass, temperature, display color, and provenance flags. ED3DM has adopted this stream. [PEGE Worker integration](https://github.com/Fenris159/PEGE/blob/v1.3.0/docs/webgpu-integration.md) [PEGE stellar profiles](https://github.com/Fenris159/PEGE/blob/v1.3.0/docs/stellar-profiles.md)

PEGE 1.3 also bounds generated caches, but `maxChunkBytes` bounds emitted buffers rather than the transient full-boxel generation object. Preserve that documented distinction. [PEGE public Interface](https://github.com/Fenris159/PEGE/blob/v1.3.0/docs/api-reference.md)

The unresolved issue is representative whole-galaxy selection. ED3DM's current overview probes mostly mass codes E through H to control generation cost. Those mass codes inherently favor higher-mass A/B/O primaries, producing a blue-heavy resident population. A frontend color transform can soften the appearance, but it cannot display missing warm low-mass Systems.

## Requested PEGE work

### Step 1: Confirm the primary-render contract

Audit the existing packed primary-render record and document which values are exact, estimated, or unavailable for compiled and procedural Systems.

Required fields or equivalent information:

- ID64 and exact position;
- mass code and generation branch;
- primary stellar class;
- base sRGB display color;
- primary mass and temperature when available;
- radius, luminosity, or absolute-magnitude input when PEGE can support it honestly;
- exact-versus-estimated provenance for every modeled value.

Physical values absent from PEGE's model remain absent. Do not synthesize a value solely to make the renderer look better.

Completion criterion: the tagged documentation and tests account for every field ED3DM receives, including missing-value representation and provenance.

### Step 2: Design one representative view stream

Add one deep Module for map-oriented population selection. Its Interface should let ED3DM state spatial bounds, a target System count, a stable selection seed, and packed attribute requirements. Its Implementation should hide mass-code mixing, density allocation, stable selection, generation, and chunking.

A suitable shape is:

```ts
type GalaxyViewRequest = {
  minimumFixedXyz: readonly [number, number, number];
  maximumExclusiveFixedXyz: readonly [number, number, number];
  targetSystems: number;
  selectionSeed?: bigint;
  attributes: "spatial-primary-render";
};

type GalaxyViewSample = {
  selectionSeed: bigint;
  stratumKey: bigint;
  generatedSystemCount: bigint;
  selectedSystemCount: number;
  inclusionProbability: number;
};

async function* streamPackedGalaxyViewAsync(
  pege: Pege,
  request: GalaxyViewRequest,
  options?: {
    signal?: AbortSignal;
    maxChunkBytes?: number;
  },
): AsyncGenerator<PackedGalaxyBoxel & { sample: GalaxyViewSample }>;
```

The exact names may change, but preserve the Interface's Depth: ED3DM supplies a point budget, not a hand-selected mass-code recipe. Sampling details remain local to PEGE's Implementation.

Completion criterion: the Interface contract specifies determinism, nesting, spatial coverage, inclusion probability, cancellation latency, chunk-size behavior, and memory ownership.

### Step 3: Implement population-aware deterministic sampling

The sampler must:

1. Partition the requested galaxy volume into stable, camera-independent spatial strata.
2. Use PEGE density/population information to allocate the requested point budget among strata.
3. Include every mass code according to predicted System population instead of selecting only coarse mass codes.
4. Score Systems deterministically from ID64 and the selection seed.
5. Make a lower target count a strict subset of a higher target count for the same region and seed.
6. Return only genuine PEGE Systems at their exact PEGE coordinates.
7. Emit aligned spatial, primary-render, and radius buffers without per-System profile object allocation.
8. Retain the PEGE 1.3 cache budget, 4 MiB-compatible chunking, and cooperative cancellation behavior.

Sampling may be performed online or backed by a versioned PEGE-generated LOD pyramid. A precompiled pyramid is acceptable when every point still identifies a real PEGE System and regeneration is reproducible.

Completion criterion: a whole-galaxy request reaches its target budget with representative spatial, mass-code, and primary-class distributions while remaining deterministic and memory-bounded.

### Step 4: Supply sampling evidence

Add a calibration fixture or build-time report comparing the representative stream with an exactly enumerable smaller region.

Report at least:

- counts by spatial stratum;
- counts by mass code;
- counts by primary stellar class;
- generated versus selected counts;
- inclusion probabilities;
- coordinate envelope on X, Y, and Z;
- cache high-water mark and peak emitted chunk bytes.

Completion criterion: automated tests enforce documented tolerances and fail when the sampler regresses toward coarse-mass-code or blue-primary dominance.

## What ED3DM will do with the result

ED3DM will keep the existing **Realistic** theme and apply a Frontier-calibrated appearance Module to each PEGE primary-render record.

Its Interface will conceptually accept the PEGE stellar descriptor plus camera distance and return linear color, opacity, point scale, and bloom strength. Its Implementation will:

- convert PEGE sRGB to linear color;
- desaturate hot blue highlights toward white rather than recoloring their stellar class;
- apply a restrained warm white balance to distant galaxy views;
- compress the apparent brightness and size of extremely hot primaries;
- give warm primaries already present sufficient screen contribution;
- derive size and bloom from supplied physical attributes with documented clamps;
- reduce the far-view correction while zooming into local detail;
- preserve the unmodified PEGE values for filtering and selected-System details.

`All Visible` will continue to disable System thinning for the active view. The appearance curve may alter brightness and bloom, but it will not remove Systems or change their identities.

## Non-goals for PEGE

- Choosing ED3DM theme names or UI controls.
- Encoding Frontier-specific exposure, white balance, bloom, or tone mapping in the engine.
- Recoloring a B-class star as a warm class to compensate for selection bias.
- Generating synthetic density particles or non-System impostors.
- Claiming procedural profile estimates are exact Frontier data.
- Returning every System in the galaxy to browser memory at once.

## Acceptance criteria

1. **Real Systems only:** every streamed point resolves to a PEGE ID64 and exact PEGE position.
2. **Representative population:** a calibrated sample stays within documented tolerances for spatial, mass-code, and primary-class histograms.
3. **Nested LOD:** for one region and seed, every smaller sample is a strict subset of larger samples.
4. **Stable traversal:** output identity is independent of enumeration order, chunking, and camera movement.
5. **Aligned attributes:** every primary-render and radius record matches the spatial ID64 at the same index.
6. **Honest provenance:** exact, estimated, and missing values remain distinguishable.
7. **Bounded output:** no emitted chunk exceeds `maxChunkBytes`; 4 MiB remains a supported value.
8. **Bounded retention:** repeated galaxy traversal plateaus under the configured PEGE cache budget.
9. **Responsive cancellation:** cancellation is observed between chunks and does not retain partial output.
10. **Compatibility:** existing PEGE 1.3 fixture ID64s, coordinates, names, profile values, and provenance remain unchanged.

## Delivery checklist

- Tag the PEGE release containing the representative stream.
- Publish the updated Interface documentation and packed-layout details.
- Include deterministic and population-calibration fixtures.
- Record memory, chunk-size, and cancellation results.
- State remaining limitations explicitly, especially any full-boxel transient peak.
- Give ED3DM one minimal integration example using `spatial-primary-render` and a 4 MiB chunk cap.

The finished design should preserve a clean seam: PEGE determines **what real stars comprise a representative sample**; ED3DM determines **how the existing Realistic theme presents those stars in a Frontier-like way**.
