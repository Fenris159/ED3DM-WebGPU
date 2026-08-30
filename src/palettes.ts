export const colorPalette = [
  "#666666",
  "#fe0000",
  "#ff7f00",
  "#ffff00",
  "#bfff00",
  "#7fff00",
  "#00ff15",
  "#009901",
  "#00ff80",
  "#01ffff",
  "#337eff",
  "#0145ff",
  "#6601e5",
  "#e600e6",
] as const;

export const mapEconomy = [
  "None",
  "Extraction",
  "Refinery",
  "Industrial",
  "UNUSED",
  "Agriculture",
  "UNUSED",
  "Terraforming",
  "UNUSED",
  "High Tech",
  "Colony",
  "Service",
  "Tourism",
  "Military",
] as const;

export const mapAllegiance = [
  "None",
  "Federation",
  "UNUSED",
  "Independent",
  "UNUSED",
  "UNUSED",
  "Alliance",
  "UNUSED",
  "UNUSED",
  "Empire",
  "UNUSED",
  "UNUSED",
  "UNUSED",
  "UNUSED",
] as const;

export const mapGovernment = [
  "None",
  "Confederacy",
  "Prison Colony",
  "Anarchy",
  "Colony",
  "Democracy",
  "Imperial",
  "Corporate",
  "Communism",
  "Feudal",
  "Dictatorship",
  "Theocracy",
  "Cooperative",
  "Patronage",
] as const;

export type ColorByMode =
  | "category"
  | "economy"
  | "allegiance"
  | "government"
  | "none";

const DEFAULT_ORB = "#2e2e2c";
const GRAYS = ["#080808", "#151514", "#242422", "#333330", "#444440"] as const;
function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function indexColor(list: readonly string[], value: string | undefined): string {
  if (!value) return colorPalette[0];
  const i = list.indexOf(value);
  if (i < 0) return colorPalette[0];
  if (list[i] === "UNUSED") return colorPalette[0];
  return colorPalette[Math.min(i, colorPalette.length - 1)] ?? colorPalette[0];
}

function hashCat(cat: string): string {
  let h = 0;
  for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) | 0;
  const i = Math.abs(h) % colorPalette.length;
  return colorPalette[i] ?? colorPalette[0];
}

export function colorFor(
  system: {
    name?: string;
    primary_economy?: string;
    allegiance?: string;
    government?: string;
    cat?: string[];
  },
  mode: ColorByMode,
): string {
  if (mode === "none") {
    if (!system.name) return DEFAULT_ORB;
    return GRAYS[hashName(system.name) % GRAYS.length] ?? DEFAULT_ORB;
  }
  if (mode === "economy") return indexColor(mapEconomy, system.primary_economy);
  if (mode === "allegiance") return indexColor(mapAllegiance, system.allegiance);
  if (mode === "government") return indexColor(mapGovernment, system.government);
  const cat = system.cat?.[0];
  if (!cat) return DEFAULT_ORB;
  return hashCat(cat);
}

export function orbScale(radiusMeters: number | undefined): number {
  const DEFAULT = 90;
  const SOLAR_RADIUS_METERS = 695_700_000;
  if (!radiusMeters || !Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    return DEFAULT;
  }
  const relative = radiusMeters / SOLAR_RADIUS_METERS;
  return Math.min(260, Math.max(48, DEFAULT * Math.pow(relative, 0.25)));
}
