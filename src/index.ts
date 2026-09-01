import type {
  CatalogCell,
  ColorByMode,
  CreateOptions,
  GenerationKind,
  GalaxyLoadProgress,
  GalaxyCameraView,
  DensityOverview,
  GalaxyOverview,
  GalaxySpatialTile,
  GalaxySource,
  LodSetting,
  MassCode,
  Route,
  System,
  SystemFilter,
  SystemSuggestion,
  TileFile,
  VisualTheme,
} from "./types";
import { colorFor } from "./palettes";
import {
  attachScene,
  cameraZoomPercent,
  type SceneHandle,
} from "./scene";
import {
  LOCAL_DETAIL_MAX_DISTANCE_LY,
  cameraResidencyAnchor,
  cameraResidencyCacheScope,
  pegeTileKeyString,
  pegeTilePointBudget,
  radialSpatialShellContains,
  radialSpatialShellPlan,
  radialSpatialShellTargets,
} from "./pege-tiles";
import {
  FULL_DETAIL_CAMERA_DISTANCE_LY,
  focusedResidencyRegion,
} from "./lod";
import {
  filterOverviewDensityCells,
  hasResidentReplacementCoverage,
} from "./filter-overview-density";

export type {
  ColorByMode,
  CreateOptions,
  GenerationKind,
  GalaxyLoadProgress,
  GalaxyCameraView,
  GalaxyOverview,
  GalaxySpatialTile,
  LodSetting,
  System,
  SystemFilter,
  SystemSuggestion,
  GalaxySource,
  VisualTheme,
  MassCode,
} from "./types";
export { PegeGalaxySource } from "./pege-source";
export {
  MASS_CODES,
  BOXEL_ORIGIN,
  boxelSize,
  boxelToPlayer,
  containingBoxel,
  distanceFromSol,
  playerToBoxel,
} from "./boxel";
export { colorFor } from "./palettes";

export type Ed3dmMap = {
  setLod: (lod: LodSetting) => Promise<void>;
  focus: (coords: { x: number; y: number; z: number }) => Promise<void>;
  flyTo: (name: string) => Promise<System | undefined>;
  setFilter: (filter: SystemFilter) => Promise<void>;
  setColorBy: (mode: ColorByMode) => void;
  setGrid: (on: boolean) => void;
  setRegionGrid: (on: boolean) => void;
  setNames: (on: boolean) => void;
  setTheme: (theme: VisualTheme) => void;
  setPlaneHeight: (y: number) => void;
  planeHeight: () => number;
  setGridSize: (code: MassCode) => void;
  /** @deprecated Use setGridSize; this controls presentation spacing only. */
  setMassCode: (code: MassCode) => void;
  resetTopView: () => void;
  clearSelection: () => void;
  destroy: () => void;
  loadedTiles: () => string[];
  cells: () => CatalogCell[];
  selected: () => System | undefined;
  visibleSystems: () => System[];
  orbColor: (name: string) => string | undefined;
  suggest: (query: string, limit?: number) => Promise<SystemSuggestion[]>;
};

function resolveContainer(container: HTMLElement | string): HTMLElement {
  if (typeof container !== "string") return container;
  const el = document.querySelector(container);
  if (!el || !(el instanceof HTMLElement)) {
    throw new Error(`ED3DM: container not found: ${container}`);
  }
  return el;
}

function tileUrl(base: string | undefined, tile: string): string {
  if (/^https?:\/\//.test(tile) || tile.startsWith("/")) return tile;
  const root = base ?? "";
  if (!root) return tile;
  return root.endsWith("/") ? `${root}${tile}` : `${root}/${tile}`;
}

async function loadJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ED3DM: failed to load ${url} (${res.status})`);
  return (await res.json()) as T;
}

export const ED3DM = {
  async create(options: CreateOptions): Promise<Ed3dmMap> {
    const el = resolveContainer(options.container);
    const catalog = options.catalog;
    const source: GalaxySource | undefined = options.source;
    if (!catalog && !source) {
      throw new Error("ED3DM: create requires a galaxy source or Catalog");
    }
    const overview = catalog
      ? await loadJson<DensityOverview>(catalog.overviewUrl)
      : { cells: [] };
    const cells = overview.cells ?? [];
    const loaded = new Set<string>();
    const tileCache = new Map<string, System[]>();
    let lod: LodSetting = options.lod ?? 0;
    let focusAt: { x: number; y: number; z: number } | undefined;
    let cameraView: GalaxyCameraView | undefined;
    let cameraDistanceLy = 30_000;
    let sourceOverviewSystems: System[] = [];
    let sourceLocalSystems: System[] = [];
    let sourceSelectionSystems: System[] = [];
    let sourceSpatialTiles: GalaxySpatialTile[] = [];
    let completedSpatialTiers = new Set<"h" | "g" | "f" | "e">();
    let activeSpatialCompletionKey: string | undefined;
    let sourceOverviewRequest: AbortController | undefined;
    let sourceLocalRequest: AbortController | undefined;
    let sourceLocalRequestKey: string | undefined;
    let sourceSpatialRequest: AbortController | undefined;
    let sourceSelectionRequest: AbortController | undefined;
    let sourceSpatialRequestKey: string | undefined;
    let committedSpatialRequestKey: string | undefined;
    let committedLocalRequestKey: string | undefined;
    let committedSelectionRequestKey: string | undefined;
    let selected: System | undefined;
    let flyRevision = 0;
    let colorBy: ColorByMode = "none";
    let categoryFilter: string[] | undefined;
    let generationFilter: GenerationKind[] | undefined;
    let stellarTypeFilter: string[] | undefined;
    let massCodeFilter: number[] | undefined;
    let excludedStellarTypeFilter: string[] | undefined = ["RoguePlanet"];
    let showGrid = true;
    let showRegionGrid = true;
    let showNames = false;
    let theme: VisualTheme = options.theme ?? "realistic";
    let themePaintTimer: ReturnType<typeof setTimeout> | undefined;
    let viewIdleTimer: ReturnType<typeof setTimeout> | undefined;
    let viewLoadRunning = false;
    let viewLoadQueued = false;
    let activeDetailViewIdentity: string | undefined;
    let routes: Route[] = [];
    let searchIndex: Record<string, { x: number; y: number; z: number; tile?: string }> | null =
      null;

    function reportDetailLoadError(error: unknown) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      console.error("ED3DM: PEGE detail load failed", normalized);
    }

    function abortSourceDetailRequests() {
      sourceLocalRequest?.abort();
      sourceSpatialRequest?.abort();
    }

    function canonicalStellarFilter(types: readonly string[] | undefined): string {
      return types?.length ? [...new Set(types)].sort().join(",") : "all";
    }

    function canonicalMassCodeFilter(codes: readonly number[] | undefined): string {
      return codes?.length
        ? [...new Set(codes)].sort((left, right) => left - right).join(",")
        : "all";
    }

    async function ensureTile(cell: CatalogCell): Promise<System[]> {
      if (!cell.tile) return [];
      const url = tileUrl(catalog?.tileBaseUrl, cell.tile);
      if (tileCache.has(url)) return tileCache.get(url)!;
      const data = await loadJson<TileFile>(url);
      const systems = data.systems ?? [];
      tileCache.set(url, systems);
      loaded.add(url);
      return systems;
    }

    function dist(
      a: { x: number; y: number; z: number },
      b: { x: number; y: number; z: number },
    ): number {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dz = a.z - b.z;
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    function nearestCell(at: { x: number; y: number; z: number }): CatalogCell | undefined {
      let best: CatalogCell | undefined;
      let bestD = Infinity;
      for (const cell of cells) {
        if (!cell.tile) continue;
        const d = dist(at, { x: cell.cx, y: cell.cy, z: cell.cz });
        if (d < bestD) {
          bestD = d;
          best = cell;
        }
      }
      return best;
    }

    function wantedUrls(): Set<string> {
      const keep = new Set<string>();
      const add = (cell: CatalogCell | undefined) => {
        if (!cell?.tile) return;
        keep.add(tileUrl(catalog?.tileBaseUrl, cell.tile));
      };
      if (lod === "all") {
        for (const cell of cells) add(cell);
        return keep;
      }
      if (focusAt === undefined) return keep;
      if (lod === 0) {
        add(nearestCell(focusAt));
        return keep;
      }
      for (const cell of cells) {
        if (dist(focusAt, { x: cell.cx, y: cell.cy, z: cell.cz }) <= lod) {
          add(cell);
        }
      }
      return keep;
    }

    function unloadExcept(keep: Set<string>) {
      for (const url of [...tileCache.keys()]) {
        if (keep.has(url)) continue;
        tileCache.delete(url);
        loaded.delete(url);
      }
    }

    function detailResidencyAnchor(): { x: number; y: number; z: number } | undefined {
      return cameraResidencyAnchor(
        selected?.coords,
        focusAt,
        cameraView?.target.y,
      );
    }

    function detailViewRequestIdentity(): string | undefined {
      if (!cameraView) return undefined;
      if (cameraView.distanceLy >= LOCAL_DETAIL_MAX_DISTANCE_LY) return "far";
      const anchor = detailResidencyAnchor();
      if (!anchor) return undefined;
      const roundedAnchor = [anchor.x, anchor.y, anchor.z]
        .map((value) => Math.round(value / 10) * 10)
        .join(":");
      const zoomPercent = cameraZoomPercent(cameraView.distanceLy);
      const shells = radialSpatialShellPlan(anchor);
      const pointBudget = pegeTilePointBudget(
        cameraView.distanceLy,
        lod,
        shells.reduce((sum, shell) => sum + shell.keys.length, 0),
      );
      return [
        roundedAnchor,
        Math.floor(zoomPercent / 5),
        pointBudget,
        lod,
        canonicalStellarFilter(stellarTypeFilter),
        canonicalMassCodeFilter(massCodeFilter),
      ].join("|");
    }

    async function ensureSourceLocal(
      exactPreview = false,
      exhaustiveSelectedCore = false,
    ): Promise<boolean> {
      if (!source) return false;
      const anchor = detailResidencyAnchor();
      if (!anchor) return false;
      // Use the same whole-percent boundary the UI displays. A camera value
      // rendered as 70% must enter the 70% factual-detail policy.
      const zoomPercent = Math.round(cameraZoomPercent(cameraDistanceLy));
      const previewCenter = selected?.coords ?? {
        x: Math.round(anchor.x / 10) * 10,
        y: Math.round(anchor.y / 10) * 10,
        z: Math.round(anchor.z / 10) * 10,
      };
      const previewSizes = exhaustiveSelectedCore
        ? [10]
        : zoomPercent >= 70
          ? [10, 40, 160]
          : zoomPercent >= 50
            ? [10, 40]
            : [10];
      const residencies = exactPreview
        ? previewSizes.map((size) => {
            const half = size / 2;
            return {
              center: previewCenter,
              radiusLy: half,
              minimum: {
                x: previewCenter.x - half,
                y: previewCenter.y - half,
                z: previewCenter.z - half,
              },
              maximum: {
                x: previewCenter.x + half,
                y: previewCenter.y + half,
                z: previewCenter.z + half,
              },
              key: `${size}:${previewCenter.x}:${previewCenter.y}:${previewCenter.z}`,
            };
          })
        : [focusedResidencyRegion(anchor, cameraDistanceLy)];
      const residency = residencies.at(-1)!;
      const requestDistanceLy = cameraDistanceLy;
      const stellarFilterKey = canonicalStellarFilter(stellarTypeFilter);
      const massFilterKey = canonicalMassCodeFilter(massCodeFilter);
      const previewZoomBand = exactPreview
        ? Math.floor(zoomPercent / 5)
        : "fixed";
      const requestKind = exhaustiveSelectedCore
        ? "selected-core"
        : exactPreview
          ? "preview"
          : "resident";
      const boundedSpatialPreview = Boolean(source.loadSpatialTiles) &&
        exactPreview && zoomPercent < 70;
      const requestKey = `region:${requestKind}:${residency.key}:${previewZoomBand}:${lod}:${stellarFilterKey}:${massFilterKey}:${showNames ? "names" : "points"}`;
      if (requestKey === sourceLocalRequestKey) return false;
      if (requestKey === committedLocalRequestKey) {
        sourceLocalRequest?.abort();
        return true;
      }
      sourceLocalRequest?.abort();
      const controller = new AbortController();
      const partialSystems = new Map<string, System>();
      const activityRevision = ++detailActivityRevision;
      detailActivity += 1;
      sourceLocalRequest = controller;
      sourceLocalRequestKey = requestKey;
      try {
        const localProgressEnd = source.loadSpatialTiles ? 0.08 : 1;
        for (const [index, stage] of residencies.entries()) {
          const partialSystems = new Map(
            sourceLocalSystems.map((system) => [systemKey(system), system]),
          );
          const systems = await source.loadRegion(
            {
              center: stage.center,
              radiusLy: stage.radiusLy,
              bounds: {
                minimum: stage.minimum,
                maximum: stage.maximum,
              },
              // Every transitional preview is deliberately bounded so it can
              // yield to the canonical H-area residency promptly. Once that
              // residency is visible, the immediate 10 ly neighbourhood becomes
              // exhaustive only in the 70%+ full-detail range. Running an
              // unbounded core replay at lower zoom was able to pin the worker
              // behind a misleading single-digit progress value.
              cameraDistanceLy:
                boundedSpatialPreview
                  ? Math.max(requestDistanceLy, 500)
                  : exhaustiveSelectedCore
                  ? FULL_DETAIL_CAMERA_DISTANCE_LY
                  : requestDistanceLy,
              lod:
                boundedSpatialPreview
                  ? lod
                  : exhaustiveSelectedCore
                  ? "all"
                  : lod,
              ...(massCodeFilter?.length ? { massCodes: massCodeFilter } : {}),
              ...(stellarTypeFilter?.length
                ? { stellarTypes: stellarTypeFilter }
                : {}),
              detailProgressRange: {
                start: (localProgressEnd * index) / residencies.length,
                end: (localProgressEnd * (index + 1)) / residencies.length,
              },
              includeNames: showNames,
              ...(exactPreview
                ? {
                    onPartialSystems: (batch: readonly System[]) => {
                      if (controller.signal.aborted) return;
                      for (const system of batch) {
                        partialSystems.set(systemKey(system), system);
                      }
                      sourceLocalSystems = [...partialSystems.values()];
                      paint();
                    },
                  }
                : {}),
            },
            controller.signal,
          );
          if (controller.signal.aborted) return false;
          sourceLocalSystems = systems;
          paint();
        }
        committedLocalRequestKey = requestKey;
        return true;
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          throw error;
        }
        return false;
      } finally {
        detailActivity -= 1;
        void notifyDetailRenderedWhenIdle(activityRevision);
        if (sourceLocalRequest === controller) {
          sourceLocalRequest = undefined;
          sourceLocalRequestKey = undefined;
        }
      }
    }

    async function ensureSourceSpatial(): Promise<boolean> {
      if (!source?.loadSpatialTiles) return false;
      const anchor = detailResidencyAnchor();
      if (!anchor) return false;
      const shells = radialSpatialShellPlan(anchor);
      const stellarFilterKey = canonicalStellarFilter(stellarTypeFilter);
      const massFilterKey = canonicalMassCodeFilter(massCodeFilter);
      const cacheScope = `${cameraResidencyCacheScope(anchor)}:${stellarFilterKey}:${massFilterKey}`;
      const totalTargetSystems = pegeTilePointBudget(
        cameraDistanceLy,
        lod,
        shells.reduce((sum, shell) => sum + shell.keys.length, 0),
      );
      if (totalTargetSystems === 0) return false;
      const shellTargets = radialSpatialShellTargets(shells, totalTargetSystems);
      const requestKey = `tiles:${stellarFilterKey}:${massFilterKey}:${showNames ? "names" : "points"}:${shells
        .map((shell, index) => {
          const { minimum, maximum } = shell.outerBounds;
          const bounds = [
            minimum.x,
            minimum.y,
            minimum.z,
            maximum.x,
            maximum.y,
            maximum.z,
          ].join(",");
          const keys = shell.keys.map(pegeTileKeyString).join(",");
          return `${shell.tier}:${bounds}:${keys}@${shellTargets[index]}`;
        })
        .join("|")}`;
      if (requestKey === sourceSpatialRequestKey) return false;
      if (requestKey === committedSpatialRequestKey) {
        sourceSpatialRequest?.abort();
        activeSpatialCompletionKey = requestKey;
        completedSpatialTiers = new Set(["h", "g", "f", "e"]);
        return true;
      }
      sourceSpatialRequest?.abort();
      const controller = new AbortController();
      const activityRevision = ++detailActivityRevision;
      detailActivity += 1;
      sourceSpatialRequest = controller;
      sourceSpatialRequestKey = requestKey;
      activeSpatialCompletionKey = requestKey;
      completedSpatialTiers = new Set();
      try {
        const previousSpatialTiles = sourceSpatialTiles;
        const progressiveTiles: GalaxySpatialTile[] = [];
        const spatialStart = 0.08;
        for (const [index, shell] of shells.entries()) {
          const shellStart =
            spatialStart + ((1 - spatialStart) * index) / shells.length;
          const shellEnd =
            spatialStart + ((1 - spatialStart) * (index + 1)) / shells.length;
          const clipTiles = (tiles: readonly GalaxySpatialTile[]) => tiles.map((tile) => ({
            ...tile,
            key: `${tile.key}@${shell.tier}`,
            systems: tile.systems.filter(({ coords }) =>
              radialSpatialShellContains(shell, coords),
            ),
            densityCells: tile.densityCells?.filter(({ coords }) =>
              radialSpatialShellContains(shell, coords),
            ),
          }));
          const fullTarget = shellTargets[index]!;
          let completedShellTiles: GalaxySpatialTile[] = [];
          const targets = shell.tier === "h" && fullTarget > 64
            ? [Math.max(shell.keys.length, 64), fullTarget]
            : [fullTarget];
          for (const [phaseIndex, targetSystems] of targets.entries()) {
            const phaseStart =
              shellStart +
              ((shellEnd - shellStart) * phaseIndex) / targets.length;
            const phaseEnd =
              shellStart +
              ((shellEnd - shellStart) * (phaseIndex + 1)) / targets.length;
            const tiles = await source.loadSpatialTiles(
              {
                keys: shell.keys,
                totalTargetSystems: targetSystems,
                ...(massCodeFilter?.length ? { massCodes: massCodeFilter } : {}),
                ...(stellarTypeFilter?.length
                  ? { stellarTypes: stellarTypeFilter }
                  : {}),
                cacheScope,
                detailProgressRange: { start: phaseStart, end: phaseEnd },
                includeNames: showNames,
                onPartialTiles: (partialTiles) => {
                  if (controller.signal.aborted) return;
                  sourceSpatialTiles = mergeSpatialTiles(
                    previousSpatialTiles,
                    progressiveTiles,
                    clipTiles(partialTiles),
                  );
                  paint();
                },
              },
              controller.signal,
            );
            if (controller.signal.aborted) return false;
            completedShellTiles = clipTiles(tiles);
            progressiveTiles.push(...completedShellTiles);
            sourceSpatialTiles = mergeSpatialTiles(
              previousSpatialTiles,
              progressiveTiles,
            );
            paint();
          }
          if (
            activeSpatialCompletionKey === requestKey &&
            hasResidentReplacementCoverage(completedShellTiles, fullTarget)
          ) {
            completedSpatialTiers.add(shell.tier);
          }
        }
        sourceSpatialTiles = mergeSpatialTiles(progressiveTiles);
        committedSpatialRequestKey = requestKey;
        paint();
        return true;
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          throw error;
        }
        return false;
      } finally {
        detailActivity -= 1;
        void notifyDetailRenderedWhenIdle(activityRevision);
        if (sourceSpatialRequest === controller) {
          sourceSpatialRequest = undefined;
          sourceSpatialRequestKey = undefined;
        }
      }
    }

    async function applyLod(): Promise<void> {
      activeDetailViewIdentity = detailViewRequestIdentity();
      if (source) {
        if (!focusAt) return;

        if (cameraDistanceLy >= LOCAL_DETAIL_MAX_DISTANCE_LY) {
          abortSourceDetailRequests();
          sourceLocalSystems = [];
          sourceSpatialTiles = [];
          completedSpatialTiers = new Set();
          activeSpatialCompletionKey = undefined;
          committedLocalRequestKey = undefined;
          committedSpatialRequestKey = undefined;
          paint();
          return;
        }

        // The selected System, or the camera focus on the current height plane,
        // anchors one complete 3D H/G/F/E residency stack. Each spatial tier
        // is published as a coherent shell around that exact focus.
        if (source.loadSpatialTiles) {
          // The canonical residency publishes factual H-area tile batches as
          // they stream. Do not block it behind a redundant fine-boxel region
          // replay; that bridge can take longer than the residency itself.
          if (await ensureSourceSpatial()) {
            sourceLocalSystems = [];
            committedLocalRequestKey = undefined;
            paint();
          }
          if (
            selected &&
            Math.round(cameraZoomPercent(cameraDistanceLy)) >= 70
          ) {
            await ensureSourceLocal(true, true);
          }
          return;
        }
        await ensureSourceLocal(Boolean(selected), Boolean(selected));
        return;
      }
      const keep = wantedUrls();
      if (lod === "all") {
        for (const cell of cells) await ensureTile(cell);
      } else if (focusAt !== undefined) {
        if (lod === 0) {
          const cell = nearestCell(focusAt);
          if (cell) await ensureTile(cell);
        } else {
          for (const cell of cells) {
            if (dist(focusAt, { x: cell.cx, y: cell.cy, z: cell.cz }) <= lod) {
              await ensureTile(cell);
            }
          }
        }
      }
      unloadExcept(keep);
    }

    async function ensureSelectionNeighbors(
      system: System,
      revision: number,
    ): Promise<boolean> {
      if (!source) return false;
      const selectedKey = systemKey(system);
      const requestKey = `${selectedKey}:${canonicalMassCodeFilter(massCodeFilter)}`;
      if (committedSelectionRequestKey === requestKey) return true;
      sourceSelectionRequest?.abort();
      const controller = new AbortController();
      const activityRevision = ++detailActivityRevision;
      detailActivity += 1;
      sourceSelectionRequest = controller;
      try {
        for (const halfExtent of [10, 40, 80, 200]) {
          const { x, y, z } = system.coords;
          const loaded = await source.loadRegion(
            {
              center: system.coords,
              radiusLy: halfExtent * Math.sqrt(3),
              bounds: {
                minimum: {
                  x: x - halfExtent,
                  y: y - halfExtent,
                  z: z - halfExtent,
                },
                maximum: {
                  x: x + halfExtent,
                  y: y + halfExtent,
                  z: z + halfExtent,
                },
              },
              cameraDistanceLy: Math.min(50, FULL_DETAIL_CAMERA_DISTANCE_LY),
              lod: "all",
              ...(massCodeFilter?.length ? { massCodes: massCodeFilter } : {}),
              detailProgressRange: { start: 0, end: 1 },
              suppressProgress: true,
            },
            controller.signal,
          );
          if (
            controller.signal.aborted ||
            revision !== flyRevision ||
            systemKey(selected ?? system) !== selectedKey
          ) return false;
          const neighbors = selectionNeighborCandidates(loaded, system);
          sourceSelectionSystems = [system, ...neighbors];
          paint();
          if (neighbors.length >= 5) break;
        }
        committedSelectionRequestKey = requestKey;
        return true;
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          throw error;
        }
        return false;
      } finally {
        detailActivity -= 1;
        void notifyDetailRenderedWhenIdle(activityRevision);
        if (sourceSelectionRequest === controller) {
          sourceSelectionRequest = undefined;
        }
      }
    }

    function clearSelectionNeighbors() {
      sourceSelectionRequest?.abort();
      sourceSelectionRequest = undefined;
      sourceSelectionSystems = [];
      committedSelectionRequestKey = undefined;
    }

    async function reloadSourceOverview(
      requestedStellarTypes: readonly string[] | undefined,
    ): Promise<void> {
      if (!source?.loadOverview) return;
      sourceOverviewRequest?.abort();
      sourceOverviewRequest = new AbortController();
      const controller = sourceOverviewRequest;
      try {
        const loadedOverview = await source.loadOverview(
          {
            lod,
            ...(requestedStellarTypes?.length
              ? { stellarTypes: [...requestedStellarTypes] }
              : {}),
          },
          controller.signal,
        );
        if (!controller.signal.aborted) {
          sourceOverviewSystems = loadedOverview.systems;
        }
      } finally {
        if (sourceOverviewRequest === controller) sourceOverviewRequest = undefined;
      }
    }
    await reloadSourceOverview(undefined);
    await applyLod();

    function overviewCount(): number {
      // The coverage-first overview is the far-field floor. Numeric LOD only
      // changes the additional camera-resident detail; it must not thin the
      // galaxy envelope below the complete 50k overview.
      return sourceOverviewSystems.length;
    }

    function systemKey(system: System): string {
      return system.id64 === undefined
        ? `${system.name}\0${system.coords.x}\0${system.coords.y}\0${system.coords.z}`
        : String(system.id64);
    }

    function selectionNeighborCandidates(
      systems: readonly System[],
      system: System,
      maximum = 5,
      maximumDistanceLy = 200,
    ): System[] {
      const identity = systemKey(system);
      const maximumDistanceSquared = maximumDistanceLy * maximumDistanceLy;
      const candidates = new Map<
        string,
        { system: System; distanceSquared: number }
      >();
      for (const candidate of systems) {
        const key = systemKey(candidate);
        if (key === identity) continue;
        const distanceSquared =
          (candidate.coords.x - system.coords.x) ** 2 +
          (candidate.coords.y - system.coords.y) ** 2 +
          (candidate.coords.z - system.coords.z) ** 2;
        if (distanceSquared <= 0 || distanceSquared > maximumDistanceSquared) {
          continue;
        }
        const current = candidates.get(key);
        if (!current || distanceSquared < current.distanceSquared) {
          candidates.set(key, { system: candidate, distanceSquared });
        }
      }
      return [...candidates.values()]
        .sort(
          (left, right) =>
            left.distanceSquared - right.distanceSquared ||
            systemKey(left.system).localeCompare(systemKey(right.system)),
        )
        .slice(0, maximum)
        .map(({ system: candidate }) => candidate);
    }

    function mergeSpatialTiles(
      ...groups: readonly GalaxySpatialTile[][]
    ): GalaxySpatialTile[] {
      const merged = new Map<string, GalaxySpatialTile>();
      for (const group of groups) {
        for (const tile of group) {
          const current = merged.get(tile.key);
          const tileContent = tile.systems.length + (tile.densityCells?.length ?? 0);
          const currentContent = current
            ? current.systems.length + (current.densityCells?.length ?? 0)
            : -1;
          if (
            !current ||
            tileContent > currentContent ||
            (tileContent === currentContent &&
              tile.targetSystems >= current.targetSystems)
          ) {
            merged.set(tile.key, tile);
          }
        }
      }
      return [...merged.values()];
    }

    function allSystems(): System[] {
      if (!source) return [...tileCache.values()].flat();
      const merged = new Map<string, System>();
      for (const system of sourceOverviewSystems.slice(0, overviewCount())) {
        merged.set(systemKey(system), system);
      }
      for (const tile of sourceSpatialTiles) {
        for (const system of tile.systems) {
          merged.set(systemKey(system), system);
        }
      }
      for (const system of sourceLocalSystems) {
        merged.set(systemKey(system), system);
      }
      for (const system of sourceSelectionSystems) {
        merged.set(systemKey(system), system);
      }
      if (selected) merged.set(systemKey(selected), selected);
      return [...merged.values()];
    }

    function refreshSelectionRailsFromResidency() {
      if (!selected) return;
      const resident = [
        ...sourceSelectionSystems,
        ...sourceLocalSystems,
        ...sourceSpatialTiles.flatMap((tile) => tile.systems),
      ];
      sourceSelectionSystems = [
        selected,
        ...selectionNeighborCandidates(resident, selected),
      ];
    }

    function visible(): System[] {
      const all = allSystems();
      return all.filter((s) => {
        const categoryMatch =
          !categoryFilter?.length ||
          !s.cat?.length ||
          s.cat.some((c) => categoryFilter!.includes(c));
        const generationMatch =
          !generationFilter?.length ||
          (s.generation !== undefined && generationFilter.includes(s.generation));
        const stellarTypeMatch =
          !stellarTypeFilter?.length ||
          (s.stellarType !== undefined && stellarTypeFilter.includes(s.stellarType));
        const stellarTypeExcluded =
          s.stellarType !== undefined &&
          Boolean(excludedStellarTypeFilter?.includes(s.stellarType));
        const nonRenderedStellarObject =
          s.stellarType === "Nebula" ||
          s.stellarType === "StellarRemnantNebula";
        const massCodeMatch =
          !massCodeFilter?.length ||
          (s.massCode !== undefined && massCodeFilter.includes(s.massCode));
        return (
          categoryMatch &&
          generationMatch &&
          stellarTypeMatch &&
          !stellarTypeExcluded &&
          !nonRenderedStellarObject &&
          massCodeMatch
        );
      });
    }

    let scene: SceneHandle | undefined;
    let lastVisibleCount = -1;
    let lastVisibleDetailCount = -1;
    let detailActivity = 0;
    let detailActivityRevision = 0;

    async function waitForDetailFrame(): Promise<void> {
      if (!scene || typeof requestAnimationFrame !== "function") return;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    async function notifyDetailRenderedWhenIdle(revision: number): Promise<void> {
      // Let an awaiting applyLod continuation start its next stage before
      // declaring the whole exact-plus-spatial residency complete.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (detailActivity !== 0 || revision !== detailActivityRevision) return;
      paint();
      await waitForDetailFrame();
      if (detailActivity !== 0 || revision !== detailActivityRevision) return;
      options.onDetailRendered?.();
    }

    function paint() {
      refreshSelectionRailsFromResidency();
      const shown = visible();
      const detailKeys = new Set<string>();
      const densityWeights = new Map<string, number>();
      const overviewDensityCells = filterOverviewDensityCells(
        sourceOverviewSystems,
        stellarTypeFilter,
        excludedStellarTypeFilter,
        categoryFilter,
        generationFilter,
        massCodeFilter,
      );
      const spatialDensityCells = sourceSpatialTiles.flatMap(
        (tile) => tile.densityCells ?? [],
      );
      const maximumDensityCellCount = Math.max(
        1,
        ...spatialDensityCells.map(({ genuineSystemCount }) => genuineSystemCount),
      );
      for (const tile of sourceSpatialTiles) {
        for (const system of tile.systems) {
          const key = systemKey(system);
          detailKeys.add(key);
          densityWeights.set(key, 0);
        }
      }
      for (const system of sourceLocalSystems) {
        const key = systemKey(system);
        detailKeys.add(key);
        densityWeights.set(key, 0);
      }
      for (const system of sourceSelectionSystems) {
        const key = systemKey(system);
        detailKeys.add(key);
        densityWeights.set(key, 0);
      }
      if (selected) {
        const key = systemKey(selected);
        detailKeys.add(key);
        densityWeights.set(key, 0);
      }
      const shownDetailCount = shown.reduce(
        (count, system) => count + Number(detailKeys.has(systemKey(system))),
        0,
      );
      if (
        shown.length !== lastVisibleCount ||
        shownDetailCount !== lastVisibleDetailCount
      ) {
        lastVisibleCount = shown.length;
        lastVisibleDetailCount = shownDetailCount;
        options.onVisibleSystemsChange?.(shown.length, shownDetailCount);
      }
      scene?.sync({
        systems: shown,
        colors: shown.map((s) =>
          theme === "realistic" && colorBy === "none"
            ? (s.stellarColor ?? "#fff4ea")
            : theme === "charcoal" && colorBy === "none"
              ? "#eceae4"
            : colorFor(s, colorBy),
        ),
        details: shown.map((system) => detailKeys.has(systemKey(system))),
        densityWeights: shown.map(
          (system) => densityWeights.get(systemKey(system)) ?? 0,
        ),
        densityCells: [
          ...overviewDensityCells.map((cell) => ({
            coords: cell.coords,
            weight: cell.presentationWeight,
            identity: cell.sourceKey,
            color: cell.color,
          })),
          ...spatialDensityCells.map((cell) => ({
            coords: cell.coords,
            weight: Math.max(
              0.08,
              Math.sqrt(cell.genuineSystemCount / maximumDensityCellCount),
            ),
          })),
        ],
        selected,
        routes,
        grid: showGrid,
        regionGrid: showRegionGrid,
        names: showNames,
        theme,
      });
    }

    function acceptView(view: GalaxyCameraView) {
      cameraView = view;
      cameraDistanceLy = view.distanceLy;
      focusAt = view.target;
    }

    async function drainViewLod() {
      if (viewLoadRunning) return;
      viewLoadRunning = true;
      try {
        do {
          viewLoadQueued = false;
          try {
            await applyLod();
          } catch (error) {
            reportDetailLoadError(error);
          }
          if (!viewLoadQueued) paint();
        } while (viewLoadQueued);
      } finally {
        viewLoadRunning = false;
      }
    }

    function scheduleViewLod(view: GalaxyCameraView, delayMs: number) {
      acceptView(view);
      const nextIdentity = detailViewRequestIdentity();
      if (nextIdentity === activeDetailViewIdentity) return;
      viewLoadQueued = true;
      if (viewIdleTimer !== undefined) clearTimeout(viewIdleTimer);
      viewIdleTimer = setTimeout(() => {
        viewIdleTimer = undefined;
        // OrbitControls can emit a new camera pose every ~90 ms during a
        // wheel gesture or a scripted flight. Keep the last complete shell on
        // screen while that pose is still moving, then cancel/replace the old
        // request only when the debounced destination is ready to load.
        abortSourceDetailRequests();
        void drainViewLod();
      }, delayMs);
    }

    const map: Ed3dmMap = {
      async setLod(next) {
        lod = next;
        paint();
        abortSourceDetailRequests();
        await applyLod();
        paint();
      },
      async focus(coords) {
        flyRevision += 1;
        focusAt = coords;
        abortSourceDetailRequests();
        await applyLod();
        paint();
      },
      async flyTo(name) {
        if (source) {
          const revision = ++flyRevision;
          if (viewIdleTimer !== undefined) {
            clearTimeout(viewIdleTimer);
            viewIdleTimer = undefined;
          }
          abortSourceDetailRequests();
          const previews = await source.preview?.(name);
          if (revision !== flyRevision) return undefined;
          const preview = previews?.[0];
          if (preview) {
            focusAt = preview.coords;
            cameraDistanceLy = Math.min(
              cameraDistanceLy,
              Math.hypot(22, 14, 52),
            );
            scene?.setPlaneHeight(preview.coords.y);
            scene?.flyCamera(preview.coords);
            paint();
            void ensureSourceLocal(true)
              .then(() => {
                if (revision === flyRevision) paint();
              })
              .catch(reportDetailLoadError);
          }
          const sys = await source.resolve(name);
          if (revision !== flyRevision) return undefined;
          if (!sys) return undefined;
          focusAt = sys.coords;
          cameraDistanceLy = Math.min(
            cameraDistanceLy,
            Math.hypot(22, 14, 52),
          );
          selected = sys;
          sourceSelectionSystems = [sys];
          options.onSystemClick?.(sys);
          scene?.flyCamera(sys.coords);
          paint();
          abortSourceDetailRequests();
          void applyLod()
            .then(() => {
              if (revision === flyRevision) paint();
            })
            .catch(reportDetailLoadError);
          return sys;
        }
        if (!searchIndex && catalog?.searchIndexUrl) {
          searchIndex = await loadJson(catalog.searchIndexUrl);
        }
        const hit = searchIndex?.[name];
        const cell =
          cells.find((c) => c.id === hit?.tile) ??
          cells.find((c) => c.tile?.includes(hit?.tile ?? "\0")) ??
          cells.find((c) =>
            c.id.toLowerCase().includes(name.toLowerCase()),
          );
        if (!cell || !cell.tile) return undefined;
        focusAt = hit
          ? { x: hit.x, y: hit.y, z: hit.z }
          : { x: cell.cx, y: cell.cy, z: cell.cz };
        await applyLod();
        const systems = tileCache.get(
          tileUrl(catalog?.tileBaseUrl, cell.tile),
        ) ?? (await ensureTile(cell));
        const sys = systems.find((s) => s.name === name);
        selected = sys;
        if (sys) {
          options.onSystemClick?.(sys);
          scene?.flyCamera(sys.coords);
        }
        paint();
        return sys;
      },
      async setFilter(filter) {
        const nextTypes = filter.stellarTypes;
        const nextExcluded = filter.excludedStellarTypes ??
          (nextTypes?.length ? undefined : ["RoguePlanet"]);
        abortSourceDetailRequests();
        categoryFilter = filter.categories;
        generationFilter = filter.generations;
        stellarTypeFilter = nextTypes;
        massCodeFilter = filter.massCodes;
        excludedStellarTypeFilter = nextExcluded;
        await reloadSourceOverview(nextTypes);
        sourceLocalSystems = [];
        sourceSpatialTiles = [];
        completedSpatialTiers = new Set();
        activeSpatialCompletionKey = undefined;
        committedLocalRequestKey = undefined;
        committedSpatialRequestKey = undefined;
        paint();
        await applyLod();
        paint();
      },
      setColorBy(mode) {
        colorBy = mode;
        paint();
      },
      setGrid(on) {
        showGrid = on;
        paint();
      },
      setRegionGrid(on) {
        showRegionGrid = on;
        paint();
      },
      setNames(on) {
        showNames = on;
        paint();
        if (on && source && cameraView) {
          committedLocalRequestKey = undefined;
          committedSpatialRequestKey = undefined;
          scheduleViewLod(cameraView, 0);
        }
      },
      setTheme(next) {
        theme = next;
        // Theme buttons can be clicked much faster than WebGPU can retire old
        // render resources. Coalesce a burst into one scene repaint so browser
        // GPU processes are not flooded with dispose/recreate work.
        if (themePaintTimer !== undefined) clearTimeout(themePaintTimer);
        themePaintTimer = setTimeout(() => {
          themePaintTimer = undefined;
          paint();
        }, 80);
      },
      setPlaneHeight(y) {
        scene?.setPlaneHeight(y);
      },
      planeHeight() {
        return scene?.planeHeight() ?? 0;
      },
      setGridSize(code) {
        scene?.setGridSize(code);
      },
      setMassCode(code) {
        scene?.setGridSize(code);
      },
      resetTopView() {
        scene?.resetTopView();
      },
      clearSelection() {
        flyRevision += 1;
        clearSelectionNeighbors();
        selected = undefined;
        options.onSystemClick?.(undefined);
        paint();
      },
      destroy() {
        if (themePaintTimer !== undefined) clearTimeout(themePaintTimer);
        if (viewIdleTimer !== undefined) clearTimeout(viewIdleTimer);
        sourceOverviewRequest?.abort();
        abortSourceDetailRequests();
        clearSelectionNeighbors();
        source?.destroy();
        scene?.destroy();
        scene = undefined;
        el.replaceChildren();
        loaded.clear();
        tileCache.clear();
        sourceSpatialTiles = [];
        completedSpatialTiers = new Set();
        activeSpatialCompletionKey = undefined;
        sourceSelectionSystems = [];
        selected = undefined;
      },
      loadedTiles() {
        return [...loaded];
      },
      cells() {
        return cells;
      },
      selected() {
        return selected;
      },
      visibleSystems() {
        return visible();
      },
      orbColor(name) {
        const sys = visible().find((s) => s.name === name);
        if (!sys) return undefined;
        if (theme === "realistic" && colorBy === "none") {
          return sys.stellarColor ?? "#fff4ea";
        }
        if (theme === "charcoal" && colorBy === "none") return "#eceae4";
        return colorFor(sys, colorBy);
      },
      suggest(query, limit) {
        return source?.suggest(query, limit) ?? Promise.resolve([]);
      },
    };

    const inTest =
      typeof navigator !== "undefined" &&
      /jsdom/i.test(navigator.userAgent);
    let hasGpu = false;
    if (!inTest) {
      try {
        const probe = document.createElement("canvas");
        hasGpu = Boolean(
          (typeof navigator !== "undefined" && "gpu" in navigator) ||
            probe.getContext("webgl2") ||
            probe.getContext("webgl"),
        );
      } catch {
        hasGpu = false;
      }
    }
    if (catalog?.routesUrl) {
      try {
        const data = await loadJson<{ routes?: Route[] }>(catalog.routesUrl);
        routes = data.routes ?? [];
      } catch {
        routes = [];
      }
    }

    if (hasGpu) {
      try {
        scene = await attachScene(el, {
          initialTheme: theme,
          onSelectSystem(index) {
            const sys = visible()[index];
            if (!sys) return;
            const revision = ++flyRevision;
            selected = sys;
            sourceSelectionSystems = [sys];
            options.onSystemClick?.(sys);
            scene?.flyCamera(sys.coords);
            paint();
            if (source) {
              abortSourceDetailRequests();
              void applyLod().catch(reportDetailLoadError);
            }
            if (!source || sys.id64 === undefined) return;
            const id64 = String(sys.id64);
            void source.resolve(id64)
              .then(async (resolved) => {
                if (revision !== flyRevision || String(selected?.id64) !== id64) return;
                if (resolved) {
                  selected = resolved;
                  options.onSystemClick?.(resolved);
                  paint();
                  return;
                }
                if (!sys.name.startsWith("ID64 ")) return;
                const name = await source.resolveDisplayName(id64);
                if (
                  !name ||
                  revision !== flyRevision ||
                  String(selected?.id64) !== id64
                ) return;
                sys.name = name;
                options.onSystemClick?.(sys);
                paint();
              })
              .catch(reportDetailLoadError);
          },
          onPickCell(coords) {
            if (selected) {
              clearSelectionNeighbors();
              selected = undefined;
              options.onSystemClick?.(undefined);
              paint();
            }
            void map.focus(coords);
          },
          onViewChange(view) {
            options.onZoom?.(cameraZoomPercent(view.distanceLy));
            if (!source) return;
            scheduleViewLod(view, 140);
          },
          onViewIdle(view) {
            options.onZoom?.(cameraZoomPercent(view.distanceLy));
            if (!source) {
              acceptView(view);
              if (view.distanceLy < LOCAL_DETAIL_MAX_DISTANCE_LY) {
                void map.focus(view.target);
              }
              return;
            }
            acceptView(view);
            scheduleViewLod(view, 0);
          },
          onPlaneHeight(y) {
            options.onPlaneHeight?.(y);
          },
          onGridSize(code, finest) {
            options.onGridSize?.(code, finest);
            options.onMassCode?.(code, finest);
          },
          viewCompass: options.viewCompass,
        });
        cameraView = scene.viewState();
        cameraDistanceLy = cameraView.distanceLy;
        focusAt = cameraView.target;
        options.onZoom?.(cameraZoomPercent(cameraDistanceLy));
        paint();
        if (source?.loadSpatialTiles) {
          void applyLod().then(paint).catch(reportDetailLoadError);
        }
      } catch {
        // The data interface still works without a GPU.
      }
    }

    return map;
  },
};

export default ED3DM;
