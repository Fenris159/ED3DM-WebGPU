import { ED3DM, MASS_CODES } from "../src/index";
import type {
  ColorByMode,
  Ed3dmMap,
  LodSetting,
  MassCode,
  System,
  VisualTheme,
} from "../src/index";

const panel = document.querySelector("#panel") as HTMLElement;
const search = document.querySelector("#search") as HTMLInputElement;
const lod = document.querySelector("#lod") as HTMLSelectElement;
const colorby = document.querySelector("#colorby") as HTMLSelectElement;
const filter = document.querySelector("#filter") as HTMLSelectElement;
const grid = document.querySelector("#grid") as HTMLInputElement;
const regions = document.querySelector("#regions") as HTMLInputElement;
const backdrop = document.querySelector("#backdrop") as HTMLInputElement;
const height = document.querySelector("#height") as HTMLInputElement;
const heightFill = document.querySelector("#height-fill") as HTMLElement;
const heightReadout = document.querySelector("#height-readout") as HTMLElement;
const heightUp = document.querySelector("#height-up") as HTMLButtonElement;
const heightDown = document.querySelector("#height-down") as HTMLButtonElement;
const HEIGHT_STEP = 10;
const masscode = document.querySelector("#masscode") as HTMLSelectElement;
let map: Ed3dmMap;

function formatHeight(y: number): string {
  const n = Math.round(y);
  if (n === 0) return "0 ly";
  return `${n > 0 ? "+" : ""}${n} ly`;
}

function heightBounds(): { min: number; max: number } {
  return { min: Number(height.min), max: Number(height.max) };
}

function snapHeight(y: number): number {
  const { min, max } = heightBounds();
  const n = Math.round(y / HEIGHT_STEP) * HEIGHT_STEP;
  return Math.min(max, Math.max(min, n));
}

function syncHeightFill(y: number) {
  const { min, max } = heightBounds();
  const t = (y - min) / (max - min);
  const thumb = (1 - t) * 100;
  const mid = 50;
  heightFill.style.top = `${Math.min(thumb, mid)}%`;
  heightFill.style.height = `${Math.abs(thumb - mid)}%`;
}

function syncHeightButtons(y: number) {
  const { min, max } = heightBounds();
  heightUp.disabled = y >= max;
  heightDown.disabled = y <= min;
}

function syncHeightUi(y: number) {
  const n = snapHeight(y);
  if (document.activeElement !== height) height.value = String(n);
  heightReadout.textContent = formatHeight(n);
  syncHeightFill(n);
  syncHeightButtons(n);
}

function applyHeight(y: number) {
  const n = snapHeight(y);
  height.value = String(n);
  map.setPlaneHeight(n);
  syncHeightUi(n);
}

function nudgeHeight(delta: number) {
  applyHeight(Number(height.value) + delta);
}

function bindHeightNudge(btn: HTMLButtonElement, delta: number) {
  let timer = 0;
  const stop = () => {
    window.clearTimeout(timer);
    timer = 0;
  };
  const start = (ev: PointerEvent) => {
    ev.preventDefault();
    nudgeHeight(delta);
    const began = Date.now();
    const tick = () => {
      nudgeHeight(delta);
      timer = window.setTimeout(tick, Date.now() - began > 700 ? 40 : 160);
    };
    timer = window.setTimeout(tick, 380);
  };
  btn.addEventListener("pointerdown", start);
  btn.addEventListener("pointerup", stop);
  btn.addEventListener("pointerleave", stop);
  btn.addEventListener("pointercancel", stop);
}

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

function syncMassCodeUi(code: MassCode, finest: MassCode) {
  const floor = MASS_CODES.indexOf(finest);
  for (const opt of Array.from(masscode.options)) {
    const i = MASS_CODES.indexOf(opt.value as MassCode);
    opt.disabled = i >= 0 && i < floor;
  }
  if (masscode.value !== code) masscode.value = code;
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
  onPlaneHeight: syncHeightUi,
  onMassCode: syncMassCodeUi,
  viewCompass: document.querySelector("#view-compass-canvas") as HTMLCanvasElement,
});
document.querySelector("#view-compass")?.addEventListener("click", () => {
  map.resetTopView();
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
regions.addEventListener("change", () => map.setRegionGrid(regions.checked));
backdrop.addEventListener("change", () => map.setBackdrop(backdrop.checked));
map.setGrid(grid.checked);
map.setRegionGrid(regions.checked);
map.setBackdrop(backdrop.checked);
height.addEventListener("input", () => {
  applyHeight(Number(height.value));
});
bindHeightNudge(heightUp, HEIGHT_STEP);
bindHeightNudge(heightDown, -HEIGHT_STEP);
masscode.addEventListener("change", () => {
  map.setMassCode(masscode.value as MassCode);
});
syncHeightUi(0);

document.querySelectorAll<HTMLButtonElement>("#theme-picker button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const next = btn.dataset.theme as VisualTheme;
    map.setTheme(next);
    document.documentElement.dataset.theme = next;
    document.querySelectorAll<HTMLButtonElement>("#theme-picker button").forEach((b) => {
      b.setAttribute("aria-pressed", String(b === btn));
    });
  });
});
