import { distanceFromSol } from "../src/boxel";
import { stellarLuminositySolar } from "../src/stellar-presentation";
import type { StellarComponentDetails, System } from "../src/types";

export type StellarFilterChoice = {
  key: string;
  label: string;
  description?: string;
  types: readonly string[];
};

export type StellarFilterGroup = {
  label: "Scoopable" | "Not scoopable";
  choices: readonly StellarFilterChoice[];
};

export const STELLAR_FILTER_GROUPS: readonly StellarFilterGroup[] = [
  {
    label: "Scoopable",
    choices: [
      { key: "O", label: "O", types: ["O"] },
      { key: "B", label: "B", types: ["B"] },
      { key: "A", label: "A", types: ["A", "A_BlueWhiteSuperGiant"] },
      { key: "F", label: "F", types: ["F", "F_WhiteSuperGiant"] },
      { key: "G", label: "G", types: ["G"] },
      { key: "K", label: "K", types: ["K", "K_OrangeGiant"] },
      { key: "M", label: "M", types: ["M", "M_RedGiant", "M_RedSuperGiant"] },
    ],
  },
  {
    label: "Not scoopable",
    choices: [
      { key: "L", label: "L", types: ["L"] },
      { key: "T", label: "T", types: ["T"] },
      { key: "Y", label: "Y", types: ["Y"] },
      {
        key: "proto",
        label: "Proto",
        description: "T Tauri + Herbig Ae/Be",
        types: ["TTS", "AeBe"],
      },
      {
        key: "carbon",
        label: "Carbon / S-type",
        types: ["CS", "C", "CN", "CJ", "CH", "CHd", "MS", "S"],
      },
      {
        key: "wolf-rayet",
        label: "Wolf-Rayet",
        types: ["W", "WN", "WNC", "WC", "WO"],
      },
      {
        key: "white-dwarf",
        label: "White dwarf",
        types: [
          "D", "DA", "DAB", "DAO", "DAZ", "DAV", "DB", "DBZ", "DBV",
          "DO", "DOV", "DQ", "DC", "DCV", "DX",
        ],
      },
      {
        key: "non-sequence",
        label: "Non-sequence",
        description: "Neutron stars + black holes",
        types: ["N", "H", "X", "SupermassiveBlackHole"],
      },
    ],
  },
] as const;

const CHOICE_BY_KEY = new Map(
  STELLAR_FILTER_GROUPS.flatMap(({ choices }) => choices).map((choice) => [
    choice.key,
    choice,
  ]),
);

export function stellarTypesForFilterKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.flatMap((key) => CHOICE_BY_KEY.get(key)?.types ?? []))];
}

export function stellarFilterLabel(keys: readonly string[]): string {
  if (keys.length === 0) return "all";
  return keys.map((key) => CHOICE_BY_KEY.get(key)?.label ?? key).join(", ");
}

const DETAILED_CLASS_NAMES: Readonly<Record<string, string>> = {
  TTS: "T Tauri",
  AeBe: "Herbig Ae/Be",
  N: "Neutron star",
  H: "Black hole",
  X: "Exotic stellar remnant",
  SupermassiveBlackHole: "Supermassive black hole",
  A_BlueWhiteSuperGiant: "A blue-white supergiant",
  F_WhiteSuperGiant: "F white supergiant",
  M_RedSuperGiant: "M red supergiant",
  M_RedGiant: "M red giant",
  K_OrangeGiant: "K orange giant",
};

export function detailedStellarClass(component: StellarComponentDetails): string {
  const detailed = DETAILED_CLASS_NAMES[component.starType];
  const base = detailed ?? component.starType;
  const subclass = component.subclass === undefined ? "" : String(component.subclass);
  const luminosity = component.luminosityClass
    ? ` ${component.luminosityClass}`
    : "";
  if (detailed) {
    const spectralPrefix = component.starType.match(/^[OBAFGKM]/)?.[0];
    const classification = spectralPrefix
      ? `${spectralPrefix}${subclass}${luminosity}`.trim()
      : [
          component.subclass === undefined
            ? undefined
            : `subclass ${component.subclass}`,
          component.luminosityClass
            ? `luminosity ${component.luminosityClass}`
            : undefined,
        ].filter(Boolean).join(" · ");
    return classification ? `${base} · ${classification}` : base;
  }
  return `${base}${subclass}${luminosity}`;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function number(value: number, maximumFractionDigits = 3): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
}

function luminosity(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return `${new Intl.NumberFormat("en-US", {
    maximumSignificantDigits: 4,
  }).format(value)} L☉`;
}

function row(label: string, value: string | undefined): string {
  return value === undefined
    ? ""
    : `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`;
}

function primaryFallback(system: System): StellarComponentDetails[] {
  if (!system.stellarType) return [];
  return [{
    bodyId: system.stellarPrimaryBodyId ?? 0,
    starType: system.stellarType,
    ...(system.stellarSubclass === undefined ? {} : { subclass: system.stellarSubclass }),
    ...(system.stellarLuminosityClass === undefined ? {} : {
      luminosityClass: system.stellarLuminosityClass,
    }),
    ...(system.stellarMassSolar === undefined ? {} : {
      stellarMassSolar: system.stellarMassSolar,
    }),
    ...(system.stellarRadiusMeters === undefined ? {} : {
      radiusMeters: system.stellarRadiusMeters,
    }),
    ...(system.stellarTemperatureKelvin === undefined ? {} : {
      surfaceTemperatureKelvin: system.stellarTemperatureKelvin,
    }),
    ...(system.stellarColor === undefined ? {} : { stellarColor: system.stellarColor }),
    validation: system.stellarProfileValidation ?? "observed",
    ...(system.stellarValidation === undefined ? {} : {
      stellarValidation: system.stellarValidation,
    }),
  }];
}

function componentDetails(
  component: StellarComponentDetails,
  primaryBodyId: number,
  secondaryIndex: number,
): string {
  const primary = component.bodyId === primaryBodyId;
  const role = primary ? "Primary star" : `Secondary star ${secondaryIndex}`;
  const heading = component.name ? `${role} · ${component.name}` : role;
  const orbital = component.orbitalElements;
  const rows = [
    row("Class", detailedStellarClass(component)),
    row("Mass", component.stellarMassSolar === undefined
      ? undefined
      : `${number(component.stellarMassSolar, 4)} solar masses`),
    row("Radius", component.radiusMeters === undefined
      ? undefined
      : `${number(component.radiusMeters / 695_700_000, 4)} solar radii`),
    row("Temperature", component.surfaceTemperatureKelvin === undefined
      ? undefined
      : `${number(component.surfaceTemperatureKelvin, 0)} K`),
    row("Absolute magnitude", component.absoluteMagnitude === undefined
      ? undefined
      : number(component.absoluteMagnitude, 3)),
    row("Luminosity", luminosity(stellarLuminositySolar(
      component.radiusMeters,
      component.surfaceTemperatureKelvin,
      component.absoluteMagnitude,
    ))),
    row("Age", component.ageMyr === undefined
      ? undefined
      : `${number(component.ageMyr, 2)} Myr`),
    row("Rotation period", component.rotationPeriodSeconds === undefined
      ? undefined
      : `${number(component.rotationPeriodSeconds / 3_600, 2)} hours`),
    row("Arrival distance", component.distanceFromArrivalLightSeconds === undefined
      ? undefined
      : `${number(component.distanceFromArrivalLightSeconds, 2)} ls`),
    row("Semi-major axis", orbital?.semiMajorAxisMeters === undefined
      ? undefined
      : `${number(orbital.semiMajorAxisMeters / 149_597_870_700, 4)} AU`),
    row("Eccentricity", orbital?.eccentricity === undefined
      ? undefined
      : number(orbital.eccentricity, 5)),
    row("Orbital inclination", orbital?.orbitalInclinationDegrees === undefined
      ? undefined
      : `${number(orbital.orbitalInclinationDegrees, 3)}°`),
    row("Orbital period", orbital?.orbitalPeriodSeconds === undefined
      ? undefined
      : `${number(orbital.orbitalPeriodSeconds / 86_400, 3)} days`),
    row("Rings", component.rings?.length
      ? component.rings.map(({ name, ringClass }) => `${name} (${ringClass})`).join(", ")
      : undefined),
  ].join("");
  return `<section class="stellar-component"><h3>${escapeHtml(heading)}</h3><dl>${rows}</dl></section>`;
}

export function renderSystemDetails(system: System): string {
  const components = system.stellarComponents?.length
    ? system.stellarComponents
    : primaryFallback(system);
  const primaryBodyId = system.stellarPrimaryBodyId ?? components[0]?.bodyId ?? 0;
  let secondaryIndex = 0;
  const stellar = components.map((component) => {
    if (component.bodyId !== primaryBodyId) secondaryIndex += 1;
    return componentDetails(component, primaryBodyId, secondaryIndex);
  }).join("");
  const systemRows = [
    row("ID64", system.id64 === undefined ? undefined : String(system.id64)),
    row(
      "Elite space",
      `${system.coords.x.toFixed(2)}, ${system.coords.y.toFixed(2)}, ${system.coords.z.toFixed(2)}`,
    ),
    row("Distance from Sol", `${distanceFromSol(system.coords).toFixed(2)} ly`),
  ].join("");
  return `<button type="button" id="deselect">Close</button>
    <h2>${escapeHtml(system.name)}</h2>
    <dl class="system-summary">${systemRows}</dl>
    ${stellar}`;
}
