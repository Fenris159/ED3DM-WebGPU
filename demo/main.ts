import { ED3DM } from "../src/index";
import type { ColorByMode, Ed3dmMap, LodSetting, System } from "../src/index";

const panel = document.querySelector("#panel") as HTMLElement;
const search = document.querySelector("#search") as HTMLInputElement;
const lod = document.querySelector("#lod") as HTMLSelectElement;
const colorby = document.querySelector("#colorby") as HTMLSelectElement;
const filter = document.querySelector("#filter") as HTMLSelectElement;
const grid = document.querySelector("#grid") as HTMLInputElement;
const backdrop = document.querySelector("#backdrop") as HTMLInputElement;
let map: Ed3dmMap;

function show(sys: System | undefined) {
  if (!sys) {
    panel.classList.remove("open");
    panel.textContent = "";
    return;
  }
  panel.classList.add("open");
  panel.innerHTML = `<button type="button" id="deselect">Close</button>
    <h2>${sys.name}</h2>
    <p>Elite space ${sys.coords.x.toFixed(2)}, ${sys.coords.y.toFixed(2)}, ${sys.coords.z.toFixed(2)}</p>
    <p>Economy ${sys.primary_economy ?? "—"}</p>
    <p>Allegiance ${sys.allegiance ?? "—"}</p>
    <p>Government ${sys.government ?? "—"}</p>
    <p>Population ${sys.population ?? "—"}</p>`;
  panel.querySelector("#deselect")?.addEventListener("click", () => {
    map.clearSelection();
    show(undefined);
  });
}

map = await ED3DM.create({
  container: "#edmap",
  catalog: {
    overviewUrl: "/catalog/overview.json",
    searchIndexUrl: "/catalog/search.json",
    tileBaseUrl: "/catalog/",
    routesUrl: "/catalog/routes.json",
  },
  onSystemClick: show,
});

async function go() {
  const name = search.value.trim();
  if (!name) return;
  const sys = await map.flyTo(name);
  show(sys);
  if (!sys) panel.classList.add("open"), (panel.textContent = `No System named ${name} in the search index.`);
}

document.querySelector("#go")?.addEventListener("click", () => void go());
search.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void go();
});
lod.addEventListener("change", () => {
  const v = lod.value;
  const setting: LodSetting = v === "all" ? "all" : Number(v);
  void map.setLod(setting);
});
colorby.addEventListener("change", () => {
  map.setColorBy(colorby.value as ColorByMode);
});
filter.addEventListener("change", () => {
  const v = filter.value;
  map.setFilter(v ? { categories: [v] } : {});
});
grid.addEventListener("change", () => map.setGrid(grid.checked));
backdrop.addEventListener("change", () => map.setBackdrop(backdrop.checked));
