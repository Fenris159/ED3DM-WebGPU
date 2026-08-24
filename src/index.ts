import type {
  CatalogCell,
  CreateOptions,
  DensityOverview,
  LodSetting,
  System,
  TileFile,
} from "./types";
import { attachScene, type SceneHandle } from "./scene";

export type { CreateOptions, LodSetting, System } from "./types";

export type Ed3dmMap = {
  setLod: (lod: LodSetting) => Promise<void>;
  focus: (coords: { x: number; y: number; z: number }) => Promise<void>;
  flyTo: (name: string) => Promise<System | undefined>;
  setFilter: (filter: { categories?: string[] }) => void;
  setColorBy: (
    mode: "category" | "economy" | "allegiance" | "government" | "none",
  ) => void;
  destroy: () => void;
  loadedTiles: () => string[];
  cells: () => CatalogCell[];
  selected: () => System | undefined;
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
    const overview = await loadJson<DensityOverview>(
      options.catalog.overviewUrl,
    );
    const cells = overview.cells ?? [];
    const loaded = new Set<string>();
    const tileCache = new Map<string, System[]>();
    let lod: LodSetting = options.lod ?? 0;
    let focusAt: { x: number; y: number; z: number } | undefined;
    let selected: System | undefined;
    let colorBy: "category" | "economy" | "allegiance" | "government" | "none" =
      "none";
    let categoryFilter: string[] | undefined;
    let searchIndex: Record<string, { x: number; y: number; z: number; tile?: string }> | null =
      null;

    async function ensureTile(cell: CatalogCell): Promise<System[]> {
      if (!cell.tile) return [];
      const url = tileUrl(options.catalog.tileBaseUrl, cell.tile);
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

    async function applyLod(): Promise<void> {
      if (lod === "all") {
        for (const cell of cells) await ensureTile(cell);
        return;
      }
      if (focusAt === undefined) return;
      if (lod === 0) {
        const cell = nearestCell(focusAt);
        if (cell) await ensureTile(cell);
        return;
      }
      const radius = lod;
      for (const cell of cells) {
        if (dist(focusAt, { x: cell.cx, y: cell.cy, z: cell.cz }) <= radius) {
          await ensureTile(cell);
        }
      }
    }

    await applyLod();

    function allSystems(): System[] {
      return [...tileCache.values()].flat();
    }

    let scene: SceneHandle | undefined;
    function paint() {
      scene?.sync({
        cells,
        systems: allSystems(),
        selected,
        hideImpostors: lod === "all",
      });
    }

    const map: Ed3dmMap = {
      async setLod(next) {
        lod = next;
        await applyLod();
        paint();
      },
      async focus(coords) {
        focusAt = coords;
        await applyLod();
        paint();
      },
      async flyTo(name) {
        if (!searchIndex && options.catalog.searchIndexUrl) {
          searchIndex = await loadJson(options.catalog.searchIndexUrl);
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
          tileUrl(options.catalog.tileBaseUrl, cell.tile),
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
      setFilter(filter) {
        categoryFilter = filter.categories;
        void categoryFilter;
      },
      setColorBy(mode) {
        colorBy = mode;
        void colorBy;
      },
      destroy() {
        scene?.destroy();
        scene = undefined;
        el.replaceChildren();
        loaded.clear();
        tileCache.clear();
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
    };

    const inTest =
      typeof navigator !== "undefined" &&
      /jsdom/i.test(navigator.userAgent);
    let hasGpu = false;
    if (!inTest) {
      try {
        const probe = document.createElement("canvas");
        hasGpu = Boolean(
          probe.getContext("webgl2") || probe.getContext("webgl"),
        );
      } catch {
        hasGpu = false;
      }
    }
    if (hasGpu) {
      try {
        scene = await attachScene(el, {
          onSelectSystem(index) {
            const sys = allSystems()[index];
            if (!sys) return;
            selected = sys;
            options.onSystemClick?.(sys);
            scene?.flyCamera(sys.coords);
            paint();
          },
          onPickCell(coords) {
            void map.focus(coords);
          },
          onViewIdle(coords, distance) {
            if (distance < 8000) void map.focus(coords);
          },
        });
        paint();
      } catch {
        // catalog API still works without a GPU
      }
    }

    return map;
  },
};
