# Elite Dangerous galaxy map

A 3D map of Elite Dangerous star systems, shown in a browser. This repository is **ED3DM-WebGPU**: the **ED3DM** library, Map app, and (later) Converter. The Next.js tree `Fenris159/elite-dangerous-galaxy-map` is the **reference app** only.

## Language

**ED3D**:
The 2015–2017 gbiobob browser plugin (`Ed3d.init`) that embeds a JSON-driven star map in a host page.
_Avoid_: ED3DM, ED3DM-WebGPU, reference app, any GitHub fork of ED3D as “the plugin”

**ED3DM**:
The embeddable 2026 map library. Hosts call `ED3DM.create`. No React in the core.
_Avoid_: ED3D, Ed3dMap, GalaxyMap, the Next app, ED3DM-WebGPU (that is the repository name)

**ED3DM-WebGPU**:
This GitHub repository (`Fenris159/ED3DM-WebGPU`). The name marks the WebGPU renderer; WebGL2 fallback is documented, not part of the JS identifier.
_Avoid_: using this string as the constructor; ED3D

**Reference app**:
The living patrickrb Next.js map in this repository (`Fenris159/elite-dangerous-galaxy-map`, default branch `develop`). Scene, camera, coloring, and picking to steal from while rewriting ED3DM. Not converted in place.
_Avoid_: the map, ED3D, ED3DM, “main” (this remote’s default is `develop`)

**Host**:
The page that embeds ED3DM by supplying a container, a Catalog URL or payload, and options. The Host’s operator serves the Catalog on their own server. Fenris does not host Catalogs or nightly dumps.
_Avoid_: calling ED3DM “the webapp”; Map app (that is the site we ship)

**Map app**:
The website an Operator deploys: 3D galaxy view, orbit/pan/zoom, click-to-select, side panels, later search and tools. It is a Host that uses ED3DM. The chrome (panels, search) is not inside the renderer. Visual target: the [AI Coding Dictionary](https://www.aicodingdictionary.com/) scene (orbit, depth, spherical nodes, labels in space, a swinging detail panel) — not that site’s force-directed *placement* of nodes.
_Avoid_: ED3DM, webapp, “the library”; using a force-directed layout to place Systems

**Operator**:
Whoever deploys a Host and serves a Catalog. They run the Converter on nightly dumps. Not Fenris unless Fenris is running their own Host.
_Avoid_: Host (that is the page), user, “we” when you mean a stranger’s site

**Converter**:
A CLI the Operator runs on their own machine or Catalog server. Turns a nightly dump into tiles (and, once, the density overview). Not a GitHub Action: dumps are too large for GH runners. Not the renderer and not a Fenris-hosted service.
_Avoid_: putting dump parsing in the browser; running dumps on GitHub Actions; calling the Converter ED3DM

**System**:
A named star system with a position in Elite space.
_Avoid_: star, particle, point, planet, orb (those are renderings or other objects)

**Orb**:
The camera-facing 2D sprite that stands for a System. It does not spin; the camera orbits in 3D around Elite space. Not drawn until that System’s tile is loaded.
_Avoid_: planet; a 3D sphere mesh that rotates with the galaxy; impostor (that is the far stand-in)

**Impostor**:
A cheap far-away mark for a boxel (hashed dots or a puff from a density count). Not a System; not clickable as a named star. Startup view is impostors only.
_Avoid_: orb; placing real Catalog Systems at random

**Density overview**:
The small JSON loaded at page start: per-boxel counts (and cell origin/size). Impostor positions are hashed in the shader, not stored as point lists. Built once (or rarely); nightly tile rebuilds do not redo it.
_Avoid_: embedding millions of System rows; a new random layout every frame; regenerating this on every dump

**Tile**:
One static Catalog file for a boxel of Systems (real orbs). Tile *size* follows density: large cells on the sparse rim, smaller cells toward the crowded core, so each file stays near a point budget. Loaded when the camera (or search) needs that cell. **LOD** (a user setting) sets how many *neighbouring* tiles also become real orbs; the rest stay impostors. Default uses a point budget. The user can set LOD to load **all** tiles and hide impostors.
_Avoid_: one tile size for the whole galaxy; making “load everything” the default

**Boxel**:
Elite’s nested cubic grid of space (from **id64** / procedural name). Sizes run **a** (10 ly) up to **h** (1280 ly, one cube per **sector**). Origin in Elite space is **BOXEL_ORIGIN** (−49985, −40985, −24105), *not* Sol. Catalog tiles, the drawn grid, and procedural names use this lattice. Sol sits inside a cube: the mass-code **d** (80 ly) corner is (−65, −25, −25).
_Avoid_: treating mass code as a camera LOD slider; treating Sol as a boxel corner; placing Systems in boxel-grid coordinates

**Mass code**:
A letter **a–h** on a procedural System (and in **id64**). It is the size of *that System’s* boxel and a hint about stellar mass. Each System has one mass code; zooming in does not “reveal” extra mass codes of the same star.
_Avoid_: “load mass code h when far, mass code a when close” as if they were mipmaps of one point cloud

**Sector**:
A 1280 ly cube of the galaxy (procedural name like Eol Prou, or a hand-authored volume). Contains nested boxels. Same Forge origin as Boxel.
_Avoid_: Region (codex regions are coarser named volumes, a different partition)

**LOD**:
A Map app setting for how much of the Catalog is real **orbs** vs **impostors**. It controls the neighbour-tile ring and can override the default budget, including “everything real, no impostors.”
_Avoid_: treating LOD as mass code; forcing a cap the user cannot raise

**Search index**:
A compact name → Elite-space position table so the Map app can snap to a System without that System’s tile already loaded.
_Avoid_: searching only among currently rendered orbs; scanning nightly dumps in the browser

**Elite space**:
The native coordinate space players use: in-game light years, **Sol at (0,0,0)**, same numbers as EDSM `coords.{x,y,z}` and EDDN `StarPos` `[x,y,z]`. Orbs, distances, and the Host API live here. The Forge boxel origin is a different point; converting is a translation by BOXEL_ORIGIN. ED3D JSON is adapted into this space (Z negated on ingest).
_Avoid_: “ED3D coordinates” as native; treating Three.js world axes as the Host-facing API; treating (0,0,0) as a boxel corner

**EDSM**:
Third-party catalog of systems in Elite space. The authoritative *source* of stars for ED3DM, via its nightly dumps — not something ED3DM fetches in the browser.
_Avoid_: EDDN; calling a raw dump “the map”

**Nightly dump**:
An EDSM gzipped JSON catalog file (`systemsWithCoordinates`, `systemsPopulated`, `stations`, `bodies7days`, …). Source material for a prep step. Not the file a Host passes to `ED3DM.create`.
_Avoid_: catalog (the prepared payload); committing these files to git

**Catalog**:
The prepared star data an Operator hosts and ED3DM loads. A System row is `{ name, coords, id64, population, primary_economy, allegiance, government, cat? }`. Station/Body lists are a sidecar, not on the orb. The Map app and ED3DM define this shape; the Converter emits it from nightly dumps.
_Avoid_: nightly dump; a SQL database the browser queries (unless we later add one)

**Category**:
An ED3D-style named group on a System (`cat`) used to filter orbs on and off.
_Avoid_: color-by (that is attribute painting, not a filter group)

**Color-by**:
A display mode that paints orbs from a System attribute (economy, allegiance, or government). Independent of Category filters.
_Avoid_: replacing Category filters; putting `colorBy` on an `Ed3d.init` shim

**Station**:
A port that belongs to a System (pad, outpost, station). It has distance-from-arrival, not its own galaxy x,y,z.
_Avoid_: treating a Station as a System / extra galaxy point

**Body**:
A star or world that belongs to a System. Same: not a galaxy point.
_Avoid_: System, Station

**EDDN**:
Relay of commander journal events. Position is `StarPos` `[x,y,z]` in Elite space. A stream, not a star catalog.
_Avoid_: EDSM, Frontier API
