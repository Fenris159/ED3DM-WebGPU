import type { Coords } from "./types";

export type GalacticRegion = {
  name: string;
  coords: Coords;
};

/** Codex / EDSM galactic-mapping labels in Elite space (Sol at origin). */
export const GALACTIC_REGIONS: GalacticRegion[] = [
  { name: "Inner Orion Spur", coords: { x: 0, y: 80, z: 0 } },
  { name: "Galactic Centre", coords: { x: 25, y: 80, z: 25900 } },
  { name: "Colonia", coords: { x: -9530, y: 80, z: 19808 } },
  { name: "Empyrean Straits", coords: { x: 1200, y: 80, z: 21000 } },
  { name: "Ryker's Hope", coords: { x: -4200, y: 80, z: 22800 } },
  { name: "Odin's Hold", coords: { x: 6200, y: 80, z: 20500 } },
  { name: "Norma Arm", coords: { x: -1800, y: 80, z: 29200 } },
  { name: "Arcadian Stream", coords: { x: 9800, y: 80, z: 23800 } },
  { name: "Izanami", coords: { x: -11800, y: 80, z: 21400 } },
  { name: "Inner Scutum-Centaurus Arm", coords: { x: -7200, y: 80, z: 16800 } },
  { name: "Norma Expanse", coords: { x: -14200, y: 80, z: 14200 } },
  { name: "The Veils", coords: { x: -7400, y: 80, z: 10800 } },
  { name: "Hawking's Gap", coords: { x: -400, y: 80, z: -4800 } },
  { name: "Formidine Rift", coords: { x: -4200, y: 80, z: -8200 } },
  { name: "Elysian Shore", coords: { x: 16800, y: 80, z: 1800 } },
  { name: "Sanguineous Rim", coords: { x: 21400, y: 80, z: 7400 } },
  { name: "Outer Orion Spur", coords: { x: 4800, y: 80, z: -7800 } },
  { name: "Perseus Arm", coords: { x: 19800, y: 80, z: 4200 } },
  { name: "Sagittarius-Carina Arm", coords: { x: -16800, y: 80, z: 15800 } },
  { name: "Outer Arm", coords: { x: 1600, y: 80, z: 41800 } },
  { name: "Aquila's Halo", coords: { x: 14200, y: 80, z: 26200 } },
  { name: "The Abyss", coords: { x: 200, y: 80, z: 52000 } },
  { name: "Mare Somnia", coords: { x: 2400, y: 80, z: 34800 } },
  { name: "Acheron", coords: { x: -8200, y: 80, z: 34600 } },
];

export const GALAXY_CORE = { x: 25.2, y: 0, z: 25900 };
export const GALAXY_RADIUS = 40000;
