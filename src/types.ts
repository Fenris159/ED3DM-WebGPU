export type Coords = { x: number; y: number; z: number };

export type GenerationKind = "authored" | "ordinary" | "constrained";

export type StellarFieldValidation = "exact" | "observed" | "estimated";

export type StellarValidation = {
  starType?: StellarFieldValidation;
  mass?: StellarFieldValidation;
  temperature?: StellarFieldValidation;
  radius?: StellarFieldValidation;
  displayColor?: StellarFieldValidation;
};

export type System = {
  name: string;
  coords: Coords;
  id64?: string | number;
  generation?: GenerationKind;
  massCode?: number;
  exactPosition?: boolean;
  stellarColor?: string;
  stellarRadiusMeters?: number;
  stellarType?: string;
  stellarSubclass?: number;
  stellarLuminosityClass?: string;
  stellarMassSolar?: number;
  stellarTemperatureKelvin?: number;
  stellarProfileSource?: "compiled-catalogue" | "procedural-primary-model";
  stellarProfileValidation?: StellarFieldValidation;
  stellarValidation?: StellarValidation;
  stellarProfileComposition?: "complete" | "partial";
  population?: number;
  primary_economy?: string;
  allegiance?: string;
  government?: string;
  cat?: string[];
};

export type CatalogCell = {
  id: string;
  cx: number;
  cy: number;
  cz: number;
  size: number;
  count: number;
  tile?: string;
};

export type DensityOverview = {
  cells: CatalogCell[];
};

export type TileFile = {
  systems: System[];
};

export type SearchIndex = Record<string, Coords & { tile?: string }>;

export type Route = {
  name?: string;
  points: Coords[];
};

export type LodSetting = number | "all";

export type GalaxyDetailProgressRange = {
  start: number;
  end: number;
};

export type GalaxyRegionRequest = {
  center: Coords;
  radiusLy: number;
  /** Optional exact camera-residency cube. PEGE clips to it instead of expanding a sphere AABB. */
  bounds?: GalaxyViewBounds;
  cameraDistanceLy: number;
  lod: LodSetting;
  /** Optional share of the current local-detail loading operation, from 0 to 1. */
  detailProgressRange?: GalaxyDetailProgressRange;
};

export type GalaxyOverviewRequest = {
  lod: LodSetting;
};

export type GalaxyOverview = {
  systems: System[];
};

export type GalaxyViewBounds = {
  minimum: Coords;
  maximum: Coords;
};

export type GalaxyCameraView = {
  target: Coords;
  position: Coords;
  direction: Coords;
  distanceLy: number;
  verticalFovDegrees: number;
  aspect: number;
  visibleBounds: GalaxyViewBounds;
};

export type PegeSpatialTileKey = {
  level: number;
  x: number;
  y: number;
  z: number;
};

export type GalaxySpatialTileRequest = {
  keys: readonly PegeSpatialTileKey[];
  totalTargetSystems: number;
  keyWeights?: readonly {
    key: PegeSpatialTileKey;
    weight: number;
  }[];
  /** Optional share of the current local-detail loading operation, from 0 to 1. */
  detailProgressRange?: GalaxyDetailProgressRange;
};

export type GalaxySpatialTile = {
  key: string;
  tileKey: PegeSpatialTileKey;
  targetSystems: number;
  populationWeight: number;
  systems: System[];
};

export type GalaxyLoadPhase =
  | "download"
  | "decode"
  | "overview"
  | "prepare"
  | "detail";

export type GalaxyLoadProgress = {
  phase: GalaxyLoadPhase;
  completed: number;
  total?: number;
};

export type SystemSuggestion = {
  name: string;
  id64: string;
  coords: Coords;
  exactPosition?: boolean;
};

export type SystemLocationPreview = SystemSuggestion & {
  exactPosition: boolean;
};

export interface GalaxySource {
  loadOverview?(
    request: GalaxyOverviewRequest,
    signal?: AbortSignal,
  ): Promise<GalaxyOverview>;
  loadRegion(request: GalaxyRegionRequest, signal?: AbortSignal): Promise<System[]>;
  loadSpatialTiles?(
    request: GalaxySpatialTileRequest,
    signal?: AbortSignal,
  ): Promise<GalaxySpatialTile[]>;
  preview?(query: string): Promise<SystemLocationPreview[]>;
  resolve(query: string): Promise<System | undefined>;
  suggest(query: string, limit?: number): Promise<SystemSuggestion[]>;
  resolveDisplayName(id64: string): Promise<string | undefined>;
  destroy(): void;
}

export type ColorByMode =
  | "category"
  | "economy"
  | "allegiance"
  | "government"
  | "none";

export type SystemFilter = {
  categories?: string[];
  generations?: GenerationKind[];
  stellarTypes?: string[];
};

export type VisualTheme = "paper" | "charcoal" | "realistic";

import type { MassCode } from "./boxel";
export type { MassCode };

export type CatalogOptions = {
  overviewUrl: string;
  tileBaseUrl?: string;
  searchIndexUrl?: string;
  routesUrl?: string;
};

export type CreateOptions = {
  container: HTMLElement | string;
  catalog?: CatalogOptions;
  source?: GalaxySource;
  lod?: LodSetting;
  theme?: VisualTheme;
  onSystemClick?: (system: System | undefined) => void;
  onPlaneHeight?: (y: number) => void;
  onZoom?: (percent: number) => void;
  onMassCode?: (code: MassCode, finest: MassCode) => void;
  onVisibleSystemsChange?: (count: number, detailCount: number) => void;
  viewCompass?: HTMLCanvasElement;
};
