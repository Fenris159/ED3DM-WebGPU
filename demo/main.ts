import { ED3DM, MASS_CODES, PegeGalaxySource } from "../src/index";
import pegeRuntimeUrl from "pege/pege-runtime.bin?url";
import { heightRailLayout } from "./hud-layout";
import { LOCAL_DETAIL_MAX_DISTANCE_LY } from "../src/pege-tiles";
import { cameraZoomPercent } from "../src/scene";
import {
  detailLoadPresentation,
  filterApplyPresentation,
  filteredDetailResultPresentation,
  galaxyLoadProgressComplete,
  galaxyLoadPresentation,
} from "../src/loading-progress";
import type {
  Ed3dmMap,
  GalaxyLoadProgress,
  MassCode,
  System,
  VisualTheme,
} from "../src/index";
import {
  STELLAR_FILTER_GROUPS,
  renderSystemDetails,
  stellarFilterLabel,
  stellarFilterForKeys,
} from "./stellar-ui";

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
const detailLoadingStatus = document.querySelector("#detail-loading-status") as HTMLElement;
const detailLoadingPercent = document.querySelector("#detail-loading-percent") as HTMLElement;
const detailLoadingCopy = document.querySelector("#detail-loading-copy") as HTMLElement;
const filter = document.querySelector("#filter") as HTMLDetailsElement;
const filterOptions = document.querySelector("#filter-options") as HTMLElement;
const filterSummary = document.querySelector("#filter-summary") as HTMLElement;
const grid = document.querySelector("#grid") as HTMLInputElement;
const regions = document.querySelector("#regions") as HTMLInputElement;
const names = document.querySelector("#names") as HTMLInputElement;
const height = document.querySelector("#height") as HTMLInputElement;
const heightFill = document.querySelector("#height-fill") as HTMLElement;
const heightReadout = document.querySelector("#height-readout") as HTMLElement;
const zoomPercent = document.querySelector("#zoom-percent") as HTMLElement;
const heightUp = document.querySelector("#height-up") as HTMLButtonElement;
const heightDown = document.querySelector("#height-down") as HTMLButtonElement;
const gridSize = document.querySelector("#grid-size") as HTMLSelectElement;
const massCodeFilter = document.querySelector("#masscode-filter") as HTMLSelectElement;
const massCodeChildren = document.querySelector("#masscode-children") as HTMLInputElement;
const hud = document.querySelector("#hud") as HTMLElement;
const heightRail = document.querySelector("#height-rail") as HTMLElement;
const viewAnchor = document.querySelector("#view-anchor") as HTMLElement;
const HEIGHT_STEP = 10;
let map: Ed3dmMap;
let lodRevision = 0;
let finestMassCode: MassCode = "h";
let visibleDetailCount = 0;
let detailLoadingHideTimer = 0;
let filterApplicationActive = false;
let filteredPopulationActive = false;
let currentZoomPercent = 0;
let latestDetailGenerationComplete = true;
const pegeRuntimeStellarReplayUrl = `${pegeRuntimeUrl}${pegeRuntimeUrl.includes("?") ? "&" : "?"}v=1.8.0-runtime-2`;

function syncHeightRailLayout() {
  const layout = heightRailLayout({
    viewportHeight: window.innerHeight,
    hudBottom: hud.getBoundingClientRect().bottom,
    compassTop: viewAnchor.getBoundingClientRect().top,
  });
  heightRail.style.top = `${layout.top}px`;
  heightRail.style.bottom = `${layout.bottom}px`;
  heightRail.dataset.compact = String(layout.compact);
  heightRail.hidden = layout.hidden;
}

const heightRailObserver = new ResizeObserver(syncHeightRailLayout);
heightRailObserver.observe(hud);
heightRailObserver.observe(viewAnchor);
window.addEventListener("resize", syncHeightRailLayout);
window.requestAnimationFrame(syncHeightRailLayout);
void document.fonts.ready.then(syncHeightRailLayout);

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

function updateDetailLoading(progress: GalaxyLoadProgress) {
  const presentation = detailLoadPresentation(progress);
  latestDetailGenerationComplete = galaxyLoadProgressComplete(progress);
  showDetailLoading(
    presentation.percent,
    presentation.label,
    presentation.percent < 100,
  );
}

function updateFilterLoading(progress: GalaxyLoadProgress) {
  const presentation = filterApplyPresentation(progress);
  showDetailLoading(presentation.percent, presentation.label, true);
}

function showDetailLoading(
  percent: number,
  label: string,
  persistent = false,
) {
  window.clearTimeout(detailLoadingHideTimer);
  detailLoadingPercent.textContent = `${percent}%`;
  detailLoadingCopy.textContent = label;
  detailLoadingStatus.hidden = false;
  detailLoadingStatus.setAttribute("aria-label", `${percent}% ${label}`);
  if (persistent) return;
  detailLoadingHideTimer = window.setTimeout(
    () => {
      detailLoadingStatus.hidden = true;
    },
    percent >= 100 ? 1_500 : 30_000,
  );
}

function showDetailRendered() {
  if (filterApplicationActive) {
    updateFilterLoading({ phase: "detail", completed: 1, total: 1 });
    return;
  }
  if (!latestDetailGenerationComplete) return;
  if (filteredPopulationActive) {
    const presentation = filteredDetailResultPresentation(
      visibleDetailCount,
      currentZoomPercent >= cameraZoomPercent(LOCAL_DETAIL_MAX_DISTANCE_LY),
    );
    showDetailLoading(presentation.percent, presentation.label);
    return;
  }
  const presentation = detailLoadPresentation(
    { phase: "detail", completed: 1, total: 1 },
    true,
  );
  showDetailLoading(presentation.percent, presentation.label);
}

function updateEngineProgress(progress: GalaxyLoadProgress) {
  if (filterApplicationActive) updateFilterLoading(progress);
  else if (progress.phase === "detail") updateDetailLoading(progress);
  else updateLoading(progress);
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

function syncZoomUi(percent: number) {
  currentZoomPercent = Math.min(100, Math.max(0, Math.round(percent)));
  zoomPercent.textContent = `${currentZoomPercent}%`;
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
  hint.textContent =
    "Left-drag rotates freely · Right-drag grabs and pans X/Z · Scroll zooms";
  if (!system) {
    panel.classList.remove("open");
    panel.textContent = "";
    return;
  }
  panel.classList.add("open");
  panel.innerHTML = renderSystemDetails(system);
  panel.querySelector("#deselect")?.addEventListener("click", () => {
    map.clearSelection();
    show(undefined);
  });
}

function syncGridSizeUi(code: MassCode, finest: MassCode) {
  finestMassCode = finest;
  for (const option of Array.from(gridSize.options)) {
    option.disabled = false;
  }
  if (gridSize.value !== code) gridSize.value = code;
  syncLodReadout();
}

function selectedMassCodes(): number[] | undefined {
  if (massCodeFilter.value === "all") return undefined;
  const selected = MASS_CODES.indexOf(massCodeFilter.value as MassCode);
  if (selected < 0) return undefined;
  return massCodeChildren.checked
    ? Array.from({ length: selected + 1 }, (_, index) => index)
    : [selected];
}

function updateCount() {
  const detail = visibleDetailCount
    ? ` · ${visibleDetailCount.toLocaleString()} detail`
    : "";
  engineStatus.textContent = `${map.visibleSystems().length.toLocaleString()} Systems${detail} · aggregate density`;
}

async function main() {
  const source = new PegeGalaxySource({
    runtimeUrl: pegeRuntimeStellarReplayUrl,
    onProgress: updateEngineProgress,
  });
  map = await ED3DM.create({
    container: "#edmap",
    source,
    lod: Number(lod.value),
    theme: "realistic",
    onSystemClick: show,
    onPlaneHeight: syncHeightUi,
    onZoom: syncZoomUi,
    onGridSize: syncGridSizeUi,
    onVisibleSystemsChange(count, detailCount) {
      visibleDetailCount = detailCount;
      const detail = detailCount
        ? ` · ${detailCount.toLocaleString()} detail`
        : "";
      engineStatus.textContent = `${count.toLocaleString()} Systems${detail} · aggregate density`;
    },
    onDetailRendered: showDetailRendered,
    viewCompass: document.querySelector("#view-compass-canvas") as HTMLCanvasElement,
  });
  map.setFilter(stellarFilterForKeys([]));
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
  const allFilter = document.createElement("input");
  allFilter.type = "checkbox";
  allFilter.value = "all";
  allFilter.checked = true;
  const allLabel = document.createElement("label");
  allLabel.className = "filter-all";
  allLabel.append(allFilter, document.createTextNode("All"));
  filterOptions.append(allLabel);

  for (const group of STELLAR_FILTER_GROUPS) {
    const fieldset = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = group.label;
    fieldset.append(legend);
    for (const choice of group.choices) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "stellar-filter";
      input.value = choice.key;
      const label = document.createElement("label");
      const text = document.createElement("span");
      text.textContent = choice.label;
      label.append(input, text);
      if (choice.description) {
        const description = document.createElement("small");
        description.textContent = choice.description;
        label.append(description);
      }
      fieldset.append(label);
    }
    filterOptions.append(fieldset);
  }

  const applyFilter = document.createElement("button");
  applyFilter.id = "filter-apply";
  applyFilter.type = "button";
  applyFilter.textContent = "Apply";
  applyFilter.disabled = true;
  filterOptions.append(applyFilter);

  const selectedFilterKeys = () => Array.from(
    filterOptions.querySelectorAll<HTMLInputElement>(
      'input[name="stellar-filter"]:checked',
    ),
    (input) => input.value,
  );
  let appliedFilterKeys: string[] = [];

  const applyFilters = async (keys: string[], closeStellarMenu: boolean) => {
    applyFilter.disabled = true;
    applyFilter.textContent = "Applying…";
    engineStatus.textContent = "PEGE filtering";
    filterApplicationActive = true;
    updateFilterLoading({ phase: "overview", completed: 0, total: 1 });
    try {
      await map.setFilter({
        ...stellarFilterForKeys(keys),
        ...(selectedMassCodes() ? { massCodes: selectedMassCodes() } : {}),
      });
      filteredPopulationActive =
        keys.length > 0 || Boolean(selectedMassCodes()?.length);
      const presentation = filteredPopulationActive
        ? filteredDetailResultPresentation(
            visibleDetailCount,
            currentZoomPercent >= cameraZoomPercent(LOCAL_DETAIL_MAX_DISTANCE_LY),
          )
        : filterApplyPresentation(
            { phase: "detail", completed: 1, total: 1 },
            true,
          );
      showDetailLoading(presentation.percent, presentation.label);
      updateCount();
      if (closeStellarMenu) filter.removeAttribute("open");
    } catch (error) {
      console.error("ED3DM: filter reload failed", error);
      engineStatus.textContent = "Filter failed";
      showDetailLoading(0, "Filter failed");
      throw error;
    } finally {
      filterApplicationActive = false;
      applyFilter.disabled = false;
      applyFilter.textContent = "Apply";
    }
  };

  filterOptions.addEventListener("change", (event) => {
    const changed = event.target as HTMLInputElement;
    if (changed === allFilter && allFilter.checked) {
      filterOptions
        .querySelectorAll<HTMLInputElement>('input[name="stellar-filter"]')
        .forEach((input) => { input.checked = false; });
    } else if (changed.name === "stellar-filter") {
      allFilter.checked = false;
    }
    const keys = selectedFilterKeys();
    if (keys.length === 0) allFilter.checked = true;
    filterSummary.textContent = stellarFilterLabel(keys);
    filterSummary.title = filterSummary.textContent;
    applyFilter.disabled = false;
  });
  applyFilter.addEventListener("click", () => {
    const keys = selectedFilterKeys();
    appliedFilterKeys = keys;
    void applyFilters(keys, true).catch(() => undefined);
  });
  grid.addEventListener("change", () => map.setGrid(grid.checked));
  regions.addEventListener("change", () => map.setRegionGrid(regions.checked));
  names.addEventListener("change", () => map.setNames(names.checked));
  height.addEventListener("input", () => applyHeight(Number(height.value)));
  bindHeightNudge(heightUp, HEIGHT_STEP);
  bindHeightNudge(heightDown, -HEIGHT_STEP);
  gridSize.addEventListener("change", () => {
    map.setGridSize(gridSize.value as MassCode);
  });
  massCodeFilter.addEventListener("change", () => {
    massCodeChildren.disabled = massCodeFilter.value === "all";
    if (massCodeChildren.disabled) massCodeChildren.checked = false;
    void applyFilters(appliedFilterKeys, false).catch(() => undefined);
  });
  massCodeChildren.addEventListener("change", () => {
    void applyFilters(appliedFilterKeys, false).catch(() => undefined);
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
  map.setNames(names.checked);
  map.setGridSize(gridSize.value as MassCode);
  syncHeightUi(0);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  engineStatus.textContent = message;
  loadingScreen.querySelector("h1")!.textContent = "Galaxy generation failed";
  loadingScreen.querySelector("p")!.textContent = message;
  loadingScreen.querySelector(".loading-mark")?.remove();
});
