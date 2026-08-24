export type Coords = { x: number; y: number; z: number };

export type System = {
  name: string;
  coords: Coords;
  id64?: string | number;
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

export type ColorByMode =
  | "category"
  | "economy"
  | "allegiance"
  | "government"
  | "none";

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
  catalog: CatalogOptions;
  lod?: LodSetting;
  onSystemClick?: (system: System | undefined) => void;
  onPlaneHeight?: (y: number) => void;
  onMassCode?: (code: MassCode, finest: MassCode) => void;
  viewCompass?: HTMLCanvasElement;
};
