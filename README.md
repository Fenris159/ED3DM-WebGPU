# ED3DM-WebGPU

Embeddable Elite Dangerous 3D galaxy map. **Operators host their own Catalog.** Fenris does not serve dumps.

Three pieces:

1. **ED3DM** — React-free TypeScript renderer (`ED3DM.create`). WebGPU with WebGL2 fallback. Orbs are TSL instanced discs (WebGPU point primitives are 1px).
2. **Map app** — first-party Host: orbit, search, side panel, LOD, color-by, grid, Milky Way backdrop.
3. **Converter** — CLI the Operator runs on their machine. Never a GitHub Action.

Spec: [issue #1](https://github.com/Fenris159/elite-dangerous-galaxy-map/issues/1).

## Run the Map app

```bash
npm install
npm test
npm run dev
```

Open the Vite URL. First paint is **impostors** from `public/catalog/overview.json` (no tile fetches). Search `Sol`, `Colonia`, or `Sagittarius A*` — or raise LOD and click the view — to load **Tile** files as real **orbs**.

## Embed

```html
<div id="edmap" style="height:100vh"></div>
<script type="module">
  import { ED3DM } from "ed3dm-webgpu";
  const map = await ED3DM.create({
    container: "#edmap",
    catalog: {
      overviewUrl: "/catalog/overview.json",
      searchIndexUrl: "/catalog/search.json",
      tileBaseUrl: "/catalog/",
      routesUrl: "/catalog/routes.json",
    },
    onSystemClick: (sys) => console.log(sys?.name),
  });
  await map.flyTo("Sol");
  map.setColorBy("economy");
</script>
```

Library build (ESM + IIFE, Three bundled in the IIFE):

```bash
npm run build:lib
```

## Converter (Operator)

Turn a nightly dump (JSON array or NDJSON of `{ name, coords }`) into the Catalog layout the Map app already loads.

```bash
npm run convert -- --in systemsWithCoordinates.json --out ./catalog --budget 2000
```

Writes `overview.json`, `search.json`, `tiles/*.json`, and optional `stations.json` / `bodies.json` sidecars. Do **not** run this in GitHub Actions; dumps are too large.

CI only typechecks and runs tests against tiny synthetic dumps.

## Catalog

- `overview.json` — density cells for impostors (one-time silhouette).
- `tiles/*.json` — Map-ready Systems, **one file per tile**.
- `search.json` — name → Elite-space position.
- `routes.json` — optional exploration paths.
- `stations.json` / `bodies.json` — sidecars, not extra galaxy points.

License: MIT.
