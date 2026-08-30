# ID64 procedural-galaxy feasibility

Research date: 2026-08-24

## Conclusion

An Elite Dangerous `SystemAddress`/ID64 can be decoded into a procedural system
name and the exact **3D boxel that contains the system**. It cannot, by itself,
tell us:

- the system's exact position inside that boxel;
- whether a syntactically valid address is occupied by a real Stellar Forge
  system; or
- the canonical displayed name of every hand-named system or every system inside
  a hand-authored naming region.

Therefore ID64 can replace the synthetic name index for exact ordinary procedural
lookups and can drive a complete on-demand 3D boxel lattice. It cannot faithfully
replace all real-system coordinate and membership data. The practical design is a
hybrid: generate the lattice and ordinary names, but retain a sparse, spatially
tiled catalogue containing at least `{ id64, x, y, z }` for real systems plus a
small exceptional-name index.

This is not just an implementation gap in this repository. The maintained
community implementations examined here explicitly model an ID64 position as a
boxel, and require an externally supplied journal/EDSM/Spansh position for the
exact point and for some naming overrides.

## What ID64 actually contains

The archived DISC reference describes the address as a 64-bit packed structure.
A current TypeScript implementation provides the following normal-address decoder
and matching encoder using `BigInt`:

```text
sc       = id64 & 7
zIndex   = (id64 >> 3)           & ((1 << (14 - sc)) - 1)
yIndex   = (id64 >> (17 - sc))   & ((1 << (13 - sc)) - 1)
xIndex   = (id64 >> (30 - 2*sc)) & ((1 << (14 - sc)) - 1)
sequence = (id64 >> (44 - 3*sc)) & ((1 << (11 + 3*sc)) - 1)
```

The shifts above are mathematical pseudocode. In TypeScript they must be `BigInt`
shifts (`1n << BigInt(width)`), not JavaScript `number` bitwise operations.

Sources: [archived DISC field description](https://web.archive.org/web/20220618134655/http://disc.thargoid.space/ID64),
[maintained decoder](https://github.com/DarkSession/Elite-Dangerous-Almanac/blob/e7fa9b07290c7591f21a37d9201155f23aa4a9b3/typescript/src/astro/system-address.ts#L219-L278),
and [matching encoder](https://github.com/DarkSession/Elite-Dangerous-Almanac/blob/e7fa9b07290c7591f21a37d9201155f23aa4a9b3/typescript/src/astro/system-address.ts#L353-L374).

`sc` is size class 0 through 7, corresponding to mass codes `a` through `h`.
The cube edge is `10 * 2^sc` light-years: 10, 20, 40, 80, 160, 320, 640,
or 1280 ly. The composite X and Z indices contain seven sector bits plus
`7 - sc` within-sector bits; Y contains six sector bits plus `7 - sc`
within-sector bits. At mass code `h`, a boxel is one entire 1280 ly sector.
[Mass-code implementation](https://github.com/DarkSession/Elite-Dangerous-Almanac/blob/e7fa9b07290c7591f21a37d9201155f23aa4a9b3/typescript/src/astro/mass-code.ts#L1-L76)

For a system address, bits 55 through 63 are zero. Composite body IDs use those
nine high bits; the established relationship is
`bodyAddress = systemAddress | (bodyId << 55)`.
[EliteDangerousCore implementation](https://github.com/EDDiscovery/EliteDangerousCore/blob/eccf8d19c4bba7df10dd9a2b4a99c4797cce013b/EliteDangerous/Bodies/Systems/SystemAddress.cs#L82-L105)
If an API accepts both kinds, distinguish them explicitly; masking a composite ID
with `(1n << 55n) - 1n` recovers its system address.

### The address gives a cube, not a point

The decoded absolute boxel indices convert to player coordinates as:

```text
edge = 10 * 2^sc ly
boxelCorner = (-49985, -40985, -24105) + (xIndex, yIndex, zIndex) * edge
boxelBounds = [boxelCorner, boxelCorner + edge) on all three axes
```

The origin and 1280 ly sector size are implemented in the current coordinate
bridge. [Galaxy-grid source](https://github.com/DarkSession/Elite-Dangerous-Almanac/blob/e7fa9b07290c7591f21a37d9201155f23aa4a9b3/typescript/src/astro/galaxy-grid.ts#L29-L74)

For example:

| System | ID64 | Mass code | Decoded boxel corner | Edge | Reported exact position |
| --- | ---: | --- | --- | ---: | --- |
| Sol | `10477373803` | d | `(-65, -25, -25)` | 80 ly | `(0, 0, 0)` |
| Oevasy SG-Y d0 | `10175390475` | d | `(-1505, -25, 65575)` | 80 ly | `(-1502.15625, -2.625, 65630.15625)` |

The API records confirm the address/point pairs for
[Sol](https://www.edsm.net/api-v1/system?systemName=Sol&showCoordinates=1&showId=1)
and [Oevasy SG-Y d0](https://www.edsm.net/api-v1/system?systemName=Oevasy%20SG-Y%20d0&showCoordinates=1&showId=1).
The maintained procedural facade is explicit that an ID64 contains only the
boxel, not the exact position; its `position` property is only the coordinate a
caller supplied from an external source.
[Procedural-system source](https://github.com/DarkSession/Elite-Dangerous-Almanac/blob/e7fa9b07290c7591f21a37d9201155f23aa4a9b3/typescript/src/astro/procedural-system.ts#L228-L276),
[position contract](https://github.com/DarkSession/Elite-Dangerous-Almanac/blob/e7fa9b07290c7591f21a37d9201155f23aa4a9b3/typescript/src/astro/procedural-system.ts#L365-L381)

The full grid is consequently 3D, not an X/Z plane. The current 2D grid can remain
the default navigation aid, while a 3D mode renders Y layers as cubes. A useful
bounded presentation would show the current layer plus one layer above and below,
or single/double stacked cubes around a selected plane, rather than attempting to
draw every cube in the galaxy.

## What can be derived as a name

For an ordinary procedural system, decoding supplies everything required by the
textual name:

1. sector X/Y/Z selects the procedural sector name;
2. within-sector X/Y/Z becomes a packed boxel code;
3. that code becomes the three letters and `N1`;
4. size class becomes mass code `a` through `h`; and
5. sequence becomes `N2`.

The textual form is `Region LL-L m[N1-]N2`, for example
`Synuefe EN-H d11-96`. [System-name structure and unpacking](https://github.com/DarkSession/Elite-Dangerous-Almanac/blob/e7fa9b07290c7591f21a37d9201155f23aa4a9b3/typescript/src/astro/system-name.ts#L1-L127)
The sector-name generator is a deterministic mapping from the 3D sector-grid
position. [Sector-name implementation](https://github.com/DarkSession/Elite-Dangerous-Almanac/blob/e7fa9b07290c7591f21a37d9201155f23aa4a9b3/typescript/src/astro/sector-name.ts#L726-L768)

This supports two valuable index-free operations:

- procedural name to ID64 to containing boxel; and
- known ID64 to procedural name and containing boxel.

It does **not** establish that the named system exists. It only round-trips a
syntactically representable address/name tuple. For a hand-named address such as
Sol's, the derived result is its underlying procedural alias, not `Sol`; the
canonical-name override must win at display time.

## Why raw ID64 enumeration cannot generate the real galaxy

### There is no occupancy information

The decoded sequence (`N2`) is an identifier within a boxel. Its field width is a
capacity of `11 + 3*sc` bits, not a statement that every value from zero to the
maximum is occupied. The examined address/name algorithms do not implement a
Stellar Forge density function, an occupancy test, or the game's generator for an
exact in-boxel point. An arbitrary 64-bit pattern can therefore decode into fields
without identifying a real system.

Known-system services demonstrate the separate membership lookup: Spansh exposes
an ID64-keyed system endpoint backed by its observed catalogue.
[Spansh OpenAPI](https://docs.spansh.co.uk/)
The journal/EDDN data model also transports `StarSystem`, `StarPos`, and
`SystemAddress` as separate fields rather than deriving the point from the address.
[EDDN journal schema](https://github.com/EDCD/EDDN/blob/153e62426eb58b6cd23def535cb4b7e1082e777f/schemas/journal-v1.0.json#L61-L75)

### Numeric order is not spatial order

The lowest three bits choose the mass code, and that choice changes the widths and
offsets of every following coordinate and sequence field. Incrementing the integer
therefore repeatedly changes the interpretation of the entire value. A loop over a
decimal range is neither a spatial traversal nor an enumeration of actual stars.

Traverse visible sectors/boxels by 3D coordinate and mass code. Query a sparse
membership structure for the real systems in those cells. Do not walk sequential
decimal ID64 values.

### The proposed 11-digit floor is false as a coding invariant

The live Spansh catalogue currently contains `i Carinae` with the 10-digit system
address `5533856349` and coordinates `(526.125, -90.96875, 97.125)`.
[Spansh system record](https://www.spansh.co.uk/api/system/5533856349)

That single public record disproves "no publicly reported system has a 10-digit
(or fewer) ID64." There may be dataset-specific minima, but decimal digit count is
not part of the bit layout and must not be used for validation or iteration bounds.
Accept the integer representation, validate its bit structure and catalogue
membership separately.

## Hand-named systems and naming-region overrides

An `id64 -> canonical display name` translation catalogue is a sound way to handle
individual hand-named systems such as Sol, Maia, Shinrarta Dezhra, catalogued real
stars, and named systems outside the bubble. It should be galaxy-wide, not bounded
to the human bubble. ID64 is the stable key; name alone is not sufficient because
public catalogues contain duplicate/ambiguous names.

There is a second exception class: systems with otherwise procedural-looking names
inside hand-authored naming regions such as Pleiades or Coalsack. These region
overrides are 3D spatial volumes. An ID64 only narrows a system to its boxel, so an
exact external coordinate is needed to decide membership when a boxel intersects a
region boundary. The maintained implementation requires `position` for this reason.
[Hand-authored-region model](https://github.com/DarkSession/Elite-Dangerous-Almanac/blob/e7fa9b07290c7591f21a37d9201155f23aa4a9b3/typescript/src/astro/hand-authored-regions.ts#L1-L21),
[override behavior](https://github.com/DarkSession/Elite-Dangerous-Almanac/blob/e7fa9b07290c7591f21a37d9201155f23aa4a9b3/typescript/src/astro/procedural-system.ts#L71-L94)

Two robust choices are available:

- ship both the hand-authored region-volume catalogue and exact system points; or
- during conversion, compare each observed canonical name with the decoded name
  and emit an ID64-keyed override for every mismatch.

The second is simpler at runtime and automatically catches named systems outside
the bubble, but it is only as complete as the input dump. No public observation
catalogue can reveal a hand-authored system that has never been reported.

## Recommended ED3DM architecture

### 1. Procedural spatial layer

Generate these on demand from camera-visible 3D cell ranges:

- sector and nested boxel geometry;
- boxel bounds and labels;
- ordinary procedural names from a known ID64; and
- optional deterministic density impostors, clearly treated as a visual estimate
  rather than real systems.

The 2D X/Z grid becomes one view of the same 3D lattice. Keep Y in every cell key and
data API now, even if the default renderer displays only the selected plane.

### 2. Sparse real-system layer

Retain tiled records containing at minimum:

```text
id64 + exact fixed-point x/y/z
```

Derive ordinary names at runtime. Add only the exceptional canonical name where it
differs. Other data such as population, allegiance, station/body sidecars, and
category membership remains optional and independently streamable.

This reduces repeated name storage and removes the need for a giant procedural-name
search index, but it does not remove the real coordinate/occupancy catalogue.

### 3. Search split

- Parse and encode an ordinary procedural name directly to ID64, derive its boxel,
  and verify that ID in the corresponding real-system tile.
- Decode a supplied ID64 directly to its procedural name and boxel, then resolve any
  canonical-name override.
- Keep a compact normalized-name index only for hand names and other aliases.

Exact-name parsing does not provide fuzzy search, substring search, or global
autocomplete. Those features still require an index over the systems actually in
the real catalogue (or a deliberately narrower suggestion set).

### 4. Integer representation

Treat external IDs as unsigned 64-bit values, using TypeScript `bigint` for address
arithmetic and decimal strings at JSON boundaries. JavaScript bitwise operators on
`number` truncate to 32 bits, and large composite body IDs exceed IEEE-754's exact
integer range. If an ID must reach a GPU buffer, split it into two `uint32` words or
send already-decoded fields; do not cast it to a floating-point number.

## Suggested proof milestone before changing the renderer

1. Implement an isolated `BigInt` decoder/encoder and known-vector tests for the
   archived `Eol Prou RS-T d3-94` example, Sol, Oevasy, and several procedural names.
2. Prove the result is a 3D bounding cube and assert the independently sourced exact
   point lies inside it.
3. Run an offline dump analysis that compares stored canonical names with decoded
   names, counts overrides, and measures the compressed cost of
   `{id64, fixed-point x/y/z}` tiles.
4. Prototype procedural-name search without `search.json`, while retaining a compact
   hand-name index.
5. Add a bounded 3D boxel-grid view around the active Y slice.

The go/no-go criterion should be accuracy: no generated point may be presented as an
actual Elite system unless membership and exact coordinates came from a real-data
source. Procedural impostors are still useful, but they represent estimated density,
not reconstructed Stellar Forge stars.

## Source notes

- The [DISC page](https://web.archive.org/web/20220618134655/http://disc.thargoid.space/ID64)
  is the user's historical reference and the original field-layout explanation.
- The [Elite Dangerous Almanac implementation](https://github.com/DarkSession/Elite-Dangerous-Almanac/tree/e7fa9b07290c7591f21a37d9201155f23aa4a9b3/typescript/src/astro)
  is a current, tested TypeScript implementation of the community-reversed address,
  name, sector, boxel, and hand-authored-region algorithms. Its code is MIT-licensed;
  bundled catalogues retain source-specific terms, so review its
  [license and notices](https://github.com/DarkSession/Elite-Dangerous-Almanac/blob/e7fa9b07290c7591f21a37d9201155f23aa4a9b3/LICENSE)
  before copying data.
- Frontier's [Journal Manual v31](https://hosting.zaonce.net/community/journal/v31/Journal_Manual_v31.pdf)
  and the EDDN schema establish the public transport fields, but Frontier does not
  publish the Stellar Forge occupancy/exact-position generator there.
- EDSM and Spansh are observation catalogues, not complete enumerations of every
  in-game system. Their absence response must not be interpreted as proof that an
  address cannot exist in game.
