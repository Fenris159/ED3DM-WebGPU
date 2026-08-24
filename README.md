# ED3DM-WebGPU

Embeddable Elite Dangerous 3D galaxy map (TypeScript, Three.js WebGPU with WebGL2 fallback). **Operators host their own Catalog.** Fenris does not serve dumps.

This is the first running Map app from [spec #1](https://github.com/Fenris159/elite-dangerous-galaxy-map/issues/1). The Converter (dump → tiles) is not in this cut.

## Run

```bash
npm install
npm test
npm run dev
```

Open the Vite URL. First paint is **impostors** from `public/catalog/overview.json` (no tile fetches). Search `Sol`, `Colonia`, or `Sagittarius A*` — or raise LOD and click the view — to load **Tile** files as real **orbs**. LOD **everything real** loads every tile and hides impostors.

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
    },
    onSystemClick: (sys) => console.log(sys.name),
  });
  await map.flyTo("Sol");
</script>
```

## Catalog (fixtures)

- `overview.json` — density cells for impostors (one-time silhouette).
- `tiles/*.json` — Map-ready Systems, **one file per tile**, fetched only on zoom/search/LOD.
- `search.json` — name → Elite-space position.

Run the Converter on your own server later; do not process EDSM dumps in GitHub Actions.
