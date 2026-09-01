import {
  GALAXY_SPATIAL_SELECTION_VERSION,
  STELLAR_TYPES,
  type StellarLodPolicy,
  type StellarType,
} from "pege";

export const PEGE_FILTERED_OVERVIEW_MAXIMUM_BOXELS = 20_000;
const PEGE_PROCEDURAL_BASE_STELLAR_TYPES = new Set([
  "O", "B", "A", "F", "G", "K", "M", "L", "T", "Y",
]);
export function pegeFilterUsesOnlyIndexedSpecialClasses(
  stellarTypes: readonly string[] | undefined,
): boolean {
  return Boolean(
    stellarTypes?.length &&
    stellarTypes.every((type) => !PEGE_PROCEDURAL_BASE_STELLAR_TYPES.has(type)),
  );
}

export function pegeStellarFilterKey(
  stellarTypes: readonly string[] | undefined,
): string {
  return stellarTypes?.length
    ? [...new Set(stellarTypes)].sort().join(",")
    : "all";
}

export function pegeStellarLodForTypes(
  stellarTypes: readonly string[] | undefined,
): StellarLodPolicy {
  if (!stellarTypes?.length) return PEGE_OVERVIEW_CONFIG.stellarLod;
  const selected = new Set(stellarTypes);
  return {
    mode: "class-weighted",
    retention: Object.fromEntries(
      STELLAR_TYPES.map((type) => [type, selected.has(type) ? 1 : 0]),
    ) as Partial<Record<StellarType, number>>,
    unknownRetention: 0,
    strength: 1,
  };
}

export const PEGE_OVERVIEW_CONFIG = {
  minimumFixedXyz: [-40_000 * 32, -5_000 * 32, -14_100 * 32],
  maximumExclusiveFixedXyz: [40_100 * 32, 5_000 * 32, 66_000 * 32],
  targetSystems: 50_000,
  selectionSeed: "42",
  stellarLod: {
    mode: "presentation-balanced",
    strength: 1,
  },
  compositionVersion: "pege-final-systems-v4-direct-classification",
} as const;

const PEGE_OVERVIEW_CACHE_VERSION =
  `pege-1.8-stellar-v2-direct-spatial-v${GALAXY_SPATIAL_SELECTION_VERSION}`;
const PEGE_FILTERED_OVERVIEW_CACHE_VERSION =
  `pege-1.8-stellar-v4-direct-filtered-spatial-v${GALAXY_SPATIAL_SELECTION_VERSION}`;

export function pegeOverviewCacheId(
  runtimeUrl: string,
  baseUrl = location.href,
  stellarTypes?: readonly string[],
): string {
  const config = PEGE_OVERVIEW_CONFIG;
  const filterKey = pegeStellarFilterKey(stellarTypes);
  if (filterKey === "all") {
    return [
      PEGE_OVERVIEW_CACHE_VERSION,
      new URL(runtimeUrl, baseUrl).href,
      GALAXY_SPATIAL_SELECTION_VERSION,
      config.targetSystems,
      config.selectionSeed,
      config.stellarLod.mode,
      config.stellarLod.strength,
      config.minimumFixedXyz.join(","),
      config.maximumExclusiveFixedXyz.join(","),
      config.compositionVersion,
    ].join(":");
  }
  return [
    PEGE_FILTERED_OVERVIEW_CACHE_VERSION,
    new URL(runtimeUrl, baseUrl).href,
    GALAXY_SPATIAL_SELECTION_VERSION,
    config.targetSystems,
    config.selectionSeed,
    config.stellarLod.mode,
    config.stellarLod.strength,
    filterKey,
    PEGE_FILTERED_OVERVIEW_MAXIMUM_BOXELS,
    config.minimumFixedXyz.join(","),
    config.maximumExclusiveFixedXyz.join(","),
    config.compositionVersion,
  ].join(":");
}
