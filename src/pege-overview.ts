import { GALAXY_SPATIAL_SELECTION_VERSION } from "pege";

export const PEGE_OVERVIEW_CONFIG = {
  minimumFixedXyz: [-40_000 * 32, -5_000 * 32, -14_100 * 32],
  maximumExclusiveFixedXyz: [40_100 * 32, 5_000 * 32, 66_000 * 32],
  targetSystems: 50_000,
  selectionSeed: "42",
  stellarLod: {
    mode: "presentation-balanced",
    strength: 1,
  },
  compositionVersion: "pege-final-systems-v2-display-names",
} as const;

const PEGE_OVERVIEW_CACHE_VERSION =
  `pege-1.6-spatial-v${GALAXY_SPATIAL_SELECTION_VERSION}`;

export function pegeOverviewCacheId(
  runtimeUrl: string,
  baseUrl = location.href,
): string {
  const config = PEGE_OVERVIEW_CONFIG;
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
