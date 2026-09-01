import type {
  GalaxyDensityCell,
  GalaxySpatialTile,
  GenerationKind,
  System,
} from "./types";

export type FilterOverviewDensityCell = GalaxyDensityCell & {
  sourceKey: string;
  stellarType?: string;
  layerKey?: string;
  massCode?: number;
  color?: string;
  presentationWeight: number;
  approximate: boolean;
};

function systemKey(system: System): string {
  return system.id64 === undefined
    ? `${system.name}\0${system.coords.x}\0${system.coords.y}\0${system.coords.z}`
    : String(system.id64);
}

/**
 * A completed request is not automatically a resident replacement. Sparse or
 * heavily filtered requests can finish after finding only a few points; using
 * that as permission to erase an entire geometric shell produces a black void.
 */
export function hasResidentReplacementCoverage(
  tiles: readonly GalaxySpatialTile[],
  targetSystems: number,
  minimumFraction = 0.05,
): boolean {
  const represented = tiles.reduce((total, tile) => {
    const densityCount = (tile.densityCells ?? []).reduce(
      (sum, cell) => sum + cell.genuineSystemCount,
      0,
    );
    return total + Math.max(tile.systems.length, densityCount);
  }, 0);
  const required = Math.min(
    targetSystems,
    Math.max(64, Math.ceil(targetSystems * minimumFraction)),
  );
  return required > 0 && represented >= required;
}

/** Exact-system fallback used when a host does not provide permanent masks. */
export function filterOverviewDensityCells(
  systems: readonly System[],
  stellarTypes: readonly string[] | undefined,
  excludedStellarTypes: readonly string[] | undefined,
  categories?: readonly string[],
  generations?: readonly GenerationKind[],
  massCodes?: readonly number[],
): FilterOverviewDensityCell[] {
  const selected = stellarTypes?.length ? new Set(stellarTypes) : undefined;
  const excluded = excludedStellarTypes?.length ? new Set(excludedStellarTypes) : undefined;
  const selectedCategories = categories?.length ? new Set(categories) : undefined;
  const selectedGenerations = generations?.length ? new Set(generations) : undefined;
  const selectedMassCodes = massCodes?.length ? new Set(massCodes) : undefined;
  return systems.flatMap((system) => {
    if (system.stellarType === "Nebula" || system.stellarType === "StellarRemnantNebula") return [];
    if (system.stellarType !== undefined && excluded?.has(system.stellarType)) return [];
    if (selected && (system.stellarType === undefined || !selected.has(system.stellarType))) return [];
    if (
      selectedCategories && system.cat?.length &&
      !system.cat.some((category) => selectedCategories.has(category))
    ) return [];
    if (
      selectedGenerations &&
      (system.generation === undefined || !selectedGenerations.has(system.generation))
    ) return [];
    if (
      selectedMassCodes &&
      (system.massCode === undefined || !selectedMassCodes.has(system.massCode))
    ) return [];
    return [{
      coords: system.coords,
      genuineSystemCount: 1,
      sourceKey: systemKey(system),
      ...(system.stellarType === undefined ? {} : { stellarType: system.stellarType }),
      ...(system.massCode === undefined ? {} : { massCode: system.massCode }),
      ...(system.stellarColor === undefined ? {} : { color: system.stellarColor }),
      presentationWeight: 1,
      approximate: false,
    }];
  });
}
