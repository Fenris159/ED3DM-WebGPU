export type StellarOverviewLayerDefinition = {
  key: string;
  label: string;
  description?: string;
  types: readonly string[];
  includeInAll: boolean;
};

export const STELLAR_OVERVIEW_LAYERS: readonly StellarOverviewLayerDefinition[] = [
  { key: "O", label: "O", types: ["O"], includeInAll: true },
  { key: "B", label: "B", types: ["B"], includeInAll: true },
  { key: "A", label: "A", types: ["A", "A_BlueWhiteSuperGiant"], includeInAll: true },
  { key: "F", label: "F", types: ["F", "F_WhiteSuperGiant"], includeInAll: true },
  { key: "G", label: "G", types: ["G"], includeInAll: true },
  { key: "K", label: "K", types: ["K", "K_OrangeGiant"], includeInAll: true },
  { key: "M", label: "M", types: ["M", "M_RedGiant", "M_RedSuperGiant"], includeInAll: true },
  { key: "L", label: "L", types: ["L"], includeInAll: true },
  { key: "T", label: "T", types: ["T"], includeInAll: true },
  { key: "Y", label: "Y", types: ["Y"], includeInAll: true },
  {
    key: "proto",
    label: "Proto",
    description: "T Tauri + Herbig Ae/Be",
    types: ["TTS", "AeBe"],
    includeInAll: true,
  },
  {
    key: "carbon",
    label: "Carbon / S-type",
    types: ["CS", "C", "CN", "CJ", "CH", "CHd", "MS", "S"],
    includeInAll: true,
  },
  {
    key: "wolf-rayet",
    label: "Wolf-Rayet",
    types: ["W", "WN", "WNC", "WC", "WO"],
    includeInAll: true,
  },
  {
    key: "white-dwarf",
    label: "White dwarf",
    types: [
      "D", "DA", "DAB", "DAO", "DAZ", "DAV", "DB", "DBZ", "DBV",
      "DO", "DOV", "DQ", "DC", "DCV", "DX",
    ],
    includeInAll: true,
  },
  { key: "neutron-star", label: "Neutron star", types: ["N"], includeInAll: true },
  {
    key: "black-hole",
    label: "Black hole",
    types: ["H", "SupermassiveBlackHole"],
    includeInAll: true,
  },
  {
    key: "exotic-remnant",
    label: "Exotic (X)",
    description: "Frontier's X stellar classification",
    types: ["X"],
    includeInAll: true,
  },
  {
    key: "rogue-planet",
    label: "Rogue planets",
    description: "Unbound planetary-mass objects",
    types: ["RoguePlanet"],
    includeInAll: false,
  },
] as const;

export const STELLAR_OVERVIEW_LAYER_BY_KEY = new Map(
  STELLAR_OVERVIEW_LAYERS.map((layer) => [layer.key, layer]),
);
