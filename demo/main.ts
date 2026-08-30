import { ED3DM, MASS_CODES, PegeGalaxySource, distanceFromSol } from "../src/index";
import pegeRuntimeUrl from "pege/pege-runtime.bin?url";
import { galaxyLoadPresentation } from "../src/loading-progress";
import type {
  Ed3dmMap,
  GalaxyLoadProgress,
  MassCode,
  System,
  VisualTheme,
} from "../src/index";

const panel = document.querySelector("#panel") as HTMLElement;
const search = document.querySelector("#search") as HTMLInputElement;
const goButton = document.querySelector("#go") as HTMLButtonElement;
const suggestions = document.querySelector("#search-suggestions") as HTMLElement;
const lod = document.querySelector("#lod") as HTMLInputElement;
const lodReadout = document.querySelector("#lod-readout") as HTMLElement;
const engineStatus = document.querySelector("#engine-status") as HTMLElement;
const hint = document.querySelector("#hint") as HTMLElement;
const loadingScreen = document.querySelector("#loading-screen") as HTMLElement;
const loadingDetail = document.querySelector("#loading-detail") as HTMLElement;
const loadingProgress = document.querySelector("#loading-progress") as HTMLElement;
const loadingProgressFill = document.querySelector("#loading-progress-fill") as HTMLElement;
const loadingPercent = document.querySelector("#loading-percent") as HTMLElement;
const filter = document.querySelector("#filter") as HTMLSelectElement;
const grid = document.querySelector("#grid") as HTMLInputElement;
const regions = document.querySelector("#regions") as HTMLInputElement;
const height = document.querySelector("#height") as HTMLInputElement;
const heightFill = document.querySelector("#height-fill") as HTMLElement;
const heightReadout = document.querySelector("#height-readout") as HTMLElement;
const heightUp = document.querySelector("#height-up") as HTMLButtonElement;
const heightDown = document.querySelector("#height-down") as HTMLButtonElement;
const masscode = document.querySelector("#masscode") as HTMLSelectElement;
const HEIGHT_STEP = 10;
let map: Ed3dmMap;
let lodRevision = 0;
let finestMassCode: MassCode = "h";
let visibleDetailCount = 0;
const pegeRuntimeV15Url = `${pegeRuntimeUrl}${pegeRuntimeUrl.includes("?") ? "&" : "?"}v=1.5.0`;

function setLoading(percent: number, label: string) {
  const value = Math.min(100, Math.max(0, Math.round(percent)));
  loadingDetail.textContent = label;
  loadingProgress.setAttribute("aria-valuenow", String(value));
  loadingProgressFill.style.width = `${value}%`;
  loadingPercent.textContent = `${value}%`;
}

function updateLoading(progress: GalaxyLoadProgress) {
  const presentation = galaxyLoadPresentation(progress);
  setLoading(presentation.percent, presentation.label);
}

function syncLodReadout() {
  const value = Number(lod.value);
  lodReadout.dataset.danger = String(value === 100);
  lodReadout.textContent =
    value === 100
      ? "ALL RESIDENT · high load"
      : finestMassCode === "a"
        ? `50,000 floor · ${value}% local detail`
        : `50,000 floor · ${value}% detail`;
}

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

function syncHeightUi(y: number) {
  const { min, max } = heightBounds();
  const n = Math.min(max, Math.max(min, y));
  if (document.activeElement !== height) height.value = String(n);
  heightReadout.textContent = formatHeight(n);
  const thumb = (1 - (n - min) / (max - min)) * 100;
  heightFill.style.top = `${Math.min(thumb, 50)}%`;
  heightFill.style.height = `${Math.abs(thumb - 50)}%`;
  heightUp.disabled = n >= max;
  heightDown.disabled = n <= min;
}

function applyHeight(y: number) {
  const n = snapHeight(y);
  height.value = String(n);
  map.setPlaneHeight(n);
  syncHeightUi(n);
}

function bindHeightNudge(button: HTMLButtonElement, delta: number) {
  let timer = 0;
  const stop = () => {
    window.clearTimeout(timer);
    timer = 0;
  };
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    applyHeight(Number(height.value) + delta);
    const began = Date.now();
    const tick = () => {
      applyHeight(Number(height.value) + delta);
      timer = window.setTimeout(tick, Date.now() - began > 700 ? 40 : 160);
    };
    timer = window.setTimeout(tick, 380);
  });
  button.addEventListener("pointerup", stop);
  button.addEventListener("pointerleave", stop);
  button.addEventListener("pointercancel", stop);
}

function show(system: System | undefined) {
  hint.textContent = system
    ? "Connected neighbors are on selection rails · Click empty space or Close to unlock · Right-drag pans X/Z · Scroll zooms"
    : "Click any factual star · Density glow is not selectable · Drag rotates · Right-drag pans X/Z · Scroll zooms";
  if (!system) {
    panel.classList.remove("open");
    panel.textContent = "";
    return;
  }
  panel.classList.add("open");
  const stellarClass = system.stellarType
    ? `${system.stellarType}${system.stellarSubclass ?? ""}${system.stellarLuminosityClass ? ` ${system.stellarLuminosityClass}` : ""}`
    : "unresolved";
  const stellarProfile = system.stellarProfileSource
    ? `${system.stellarProfileValidation ?? "unknown"} ${system.stellarProfileSource} (${system.stellarProfileComposition ?? "partial"})`
    : "unresolved by PEGE 1.5";
  const radius = system.stellarRadiusMeters
    ? `${(system.stellarRadiusMeters / 695_700_000).toFixed(3)} solar radii`
    : "not supplied";
  panel.innerHTML = `<button type="button" id="deselect">Close</button>
    <h2>${system.name}</h2>
    <p>ID64 ${system.id64 ?? "—"}</p>
    <p>Generation ${system.generation ?? "catalogue"}</p>
    <p>Elite space ${system.coords.x.toFixed(2)}, ${system.coords.y.toFixed(2)}, ${system.coords.z.toFixed(2)}</p>
    <p>Distance from Sol ${distanceFromSol(system.coords).toFixed(2)} ly</p>
    <p>Position ${system.exactPosition ? "exact PEGE generation" : "generated"}</p>
    <p>Primary ${stellarClass}</p>
    <p>Profile ${stellarProfile}</p>
    <p>Mass ${system.stellarMassSolar?.toFixed(4) ?? "not supplied"} solar masses</p>
    <p>Radius ${radius}</p>
    <p>Temperature ${system.stellarTemperatureKelvin?.toFixed(0) ?? "not supplied"} K</p>`;
  panel.querySelector("#deselect")?.addEventListener("click", () => {
    map.clearSelection();
    show(undefined);
  });
}

function syncMassCodeUi(code: MassCode, finest: MassCode) {
  finestMassCode = finest;
  for (const option of Array.from(masscode.options)) {
    option.disabled = false;
  }
  if (masscode.value !== code) masscode.value = code;
  syncLodReadout();
}

function updateCount() {
  const detail = visibleDetailCount
    ? ` · ${visibleDetailCount.toLocaleString()} detail`
    : "";
  engineStatus.textContent = `${map.visibleSystems().length.toLocaleString()} Systems${detail} · aggregate density`;
}

async function main() {
  const source = new PegeGalaxySource({
    runtimeUrl: pegeRuntimeV15Url,
    onProgress: updateLoading,
  });
  map = await ED3DM.create({
    container: "#edmap",
    source,
    lod: Number(lod.value),
    theme: "realistic",
    onSystemClick: show,
    onPlaneHeight: syncHeightUi,
    onMassCode: syncMassCodeUi,
    onVisibleSystemsChange(count, detailCount) {
      visibleDetailCount = detailCount;
      const detail = detailCount
        ? ` · ${detailCount.toLocaleString()} detail`
        : "";
      engineStatus.textContent = `${count.toLocaleString()} Systems${detail} · aggregate density`;
    },
    viewCompass: document.querySelector("#view-compass-canvas") as HTMLCanvasElement,
  });
  setLoading(99, "Rendering the first galaxy frame");
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  setLoading(100, "Galaxy ready");
  loadingScreen.setAttribute("aria-hidden", "true");
  updateCount();

  document.querySelector("#view-compass")?.addEventListener("click", () => {
    map.resetTopView();
  });

  let suggestTimer = 0;
  let suggestRevision = 0;
  let searchRevision = 0;
  let suggestionsSuppressed = false;

  async function go() {
    const query = search.value.trim();
    if (!query) return;
    window.clearTimeout(suggestTimer);
    suggestRevision += 1;
    suggestionsSuppressed = true;
    suggestions.hidden = true;
    suggestions.replaceChildren();
    const revision = ++searchRevision;
    search.setAttribute("aria-busy", "true");
    goButton.textContent = "Finding…";
    engineStatus.textContent = "PEGE locating System";
    const system = await map.flyTo(query);
    if (revision !== searchRevision) return;
    search.removeAttribute("aria-busy");
    goButton.textContent = "Go";
    show(system);
    if (!system) {
      panel.classList.add("open");
      panel.textContent = `No System name or ID64 matched ${query}.`;
    }
    updateCount();
  }

  goButton.addEventListener("click", () => void go());
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void go();
  });

  search.addEventListener("input", () => {
    window.clearTimeout(suggestTimer);
    const revision = ++suggestRevision;
    suggestionsSuppressed = false;
    const query = search.value.trim();
    suggestions.replaceChildren();
    suggestions.hidden = true;
    if (query.length < 2 || /^\d+$/.test(query)) return;
    suggestTimer = window.setTimeout(() => {
      const pending = document.createElement("span");
      pending.className = "search-suggestion-status";
      pending.textContent = "Searching system names…";
      suggestions.replaceChildren(pending);
      suggestions.hidden = false;
      void map.suggest(query, 12).then((matches) => {
        if (
          suggestionsSuppressed ||
          revision !== suggestRevision ||
          search.value.trim() !== query
        ) return;
        if (!matches.length) {
          pending.textContent = "No system names matched";
          return;
        }
        const buttons = matches.map((match) => {
          const button = document.createElement("button");
          button.type = "button";
          button.setAttribute("role", "option");
          const name = document.createElement("span");
          name.textContent = match.name;
          const id = document.createElement("small");
          id.textContent = `${match.id64}${
            match.exactPosition === false ? " · decoded boxel" : ""
          }`;
          button.append(name, id);
          button.addEventListener("pointerdown", (event) => event.preventDefault());
          button.addEventListener("click", () => {
            search.value = match.name;
            suggestions.hidden = true;
            void go();
          });
          return button;
        });
        suggestions.replaceChildren(...buttons);
      });
    }, 50);
  });
  search.addEventListener("blur", () => {
    window.setTimeout(() => { suggestions.hidden = true; }, 120);
  });
  search.addEventListener("focus", () => {
    if (suggestions.childElementCount) suggestions.hidden = false;
  });

  lod.addEventListener("input", () => {
    const revision = ++lodRevision;
    const value = Number(lod.value);
    syncLodReadout();
    engineStatus.textContent = "PEGE generating";
    void map.setLod(value === 100 ? "all" : value).then(() => {
      if (revision === lodRevision) updateCount();
    });
  });
  filter.addEventListener("change", () => {
    const value = filter.value;
    if (value.startsWith("generation:")) {
      map.setFilter({
        generations: [
          value.slice("generation:".length) as NonNullable<System["generation"]>,
        ],
      });
    } else if (value.startsWith("stellar:")) {
      map.setFilter({ stellarTypes: [value.slice("stellar:".length)] });
    } else {
      map.setFilter({});
    }
    updateCount();
  });
  grid.addEventListener("change", () => map.setGrid(grid.checked));
  regions.addEventListener("change", () => map.setRegionGrid(regions.checked));
  height.addEventListener("input", () => applyHeight(Number(height.value)));
  bindHeightNudge(heightUp, HEIGHT_STEP);
  bindHeightNudge(heightDown, -HEIGHT_STEP);
  masscode.addEventListener("change", () => {
    map.setMassCode(masscode.value as MassCode);
  });
  document
    .querySelectorAll<HTMLButtonElement>("#theme-picker button")
    .forEach((button) => {
      button.addEventListener("click", () => {
        const next = button.dataset.theme as VisualTheme;
        map.setTheme(next);
        document.documentElement.dataset.theme = next;
        document
          .querySelectorAll<HTMLButtonElement>("#theme-picker button")
          .forEach((candidate) => {
            candidate.setAttribute("aria-pressed", String(candidate === button));
          });
      });
    });

  map.setGrid(grid.checked);
  map.setRegionGrid(regions.checked);
  syncHeightUi(0);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  engineStatus.textContent = message;
  loadingScreen.querySelector("h1")!.textContent = "Galaxy generation failed";
  loadingScreen.querySelector("p")!.textContent = message;
  loadingScreen.querySelector(".loading-mark")?.remove();
});
