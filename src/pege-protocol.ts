import type {
  GalaxyLoadPhase,
  GenerationKind,
  PegeSpatialTileKey,
  StellarComponentDetails,
  SystemLocationPreview,
  SystemSuggestion,
} from "./types";
import type { StellarLodPolicy } from "pege";

export type PackedSystemBatch = {
  records: ArrayBuffer;
  names: readonly { systemIndex: number; name: string }[];
  stellarRecords?: ArrayBuffer;
  stellarRadii?: ArrayBuffer;
};

export type PackedDensityBatch = {
  densityVersion: number;
  voxelResolution: number;
  sourceSystemCount: number;
  centroidFixedXyz: ArrayBuffer;
  voxelSystemCounts: ArrayBuffer;
};

export type PegeWorkerRequest =
  | {
      type: "initialize";
      requestId: 0;
      runtimeUrl: string;
      role?: "galaxy" | "query";
      prewarm?: boolean;
    }
  | {
      type: "generate";
      requestId: number;
      minimumFixedXyz: readonly [number, number, number];
      maximumExclusiveFixedXyz: readonly [number, number, number];
      massCodes: readonly number[];
      threshold: number;
      maximumBoxels?: number;
      yieldEveryBoxels?: number;
      includeNames?: boolean;
    }
  | {
      type: "overview";
      requestId: number;
      minimumFixedXyz: readonly [number, number, number];
      maximumExclusiveFixedXyz: readonly [number, number, number];
      targetSystems: number;
      massCodes?: readonly number[];
      maximumBoxelsVisited?: number;
      selectionSeed: string;
      stellarLod: StellarLodPolicy;
      includeNames?: boolean;
    }
  | {
      type: "plan-tiles";
      requestId: number;
      keys: readonly PegeSpatialTileKey[];
      totalTargetSystems: number;
      keyWeights?: readonly number[];
    }
  | {
      type: "tiles";
      requestId: number;
      attributes: "spatial-primary-render" | "spatial-overview-estimate";
      tiles: readonly {
        key: PegeSpatialTileKey;
        targetSystems: number;
        sampleTargetSystems?: number;
        voxelResolution?: number;
        maximumBoxelsVisited?: number;
      }[];
      massCodes?: readonly number[];
      selectionSeed: string;
      stellarLod: StellarLodPolicy;
      includeNames?: boolean;
    }
  | { type: "warm"; requestId: number }
  | { type: "cancel"; requestId: number }
  | { type: "preview"; requestId: number; query: string }
  | { type: "resolve"; requestId: number; query: string }
  | { type: "suggest"; requestId: number; query: string; limit: number }
  | { type: "display-name"; requestId: number; id64: string };

export type ResolvedPegeSystem = {
  name?: string;
  id64: string;
  coords: { x: number; y: number; z: number };
  generation: GenerationKind;
  massCode: number;
  exactPosition: boolean;
  stellarColor?: string;
  stellarRadiusMeters?: number;
  stellarType?: string;
  stellarSubclass?: number;
  stellarLuminosityClass?: string;
  stellarMassSolar?: number;
  stellarTemperatureKelvin?: number;
  stellarLuminositySolar?: number;
  stellarProfileSource?:
    | "compiled-catalogue"
    | "procedural-primary-model";
  stellarProfileValidation?: "exact" | "observed" | "estimated";
  stellarValidation?: {
    starType?: "exact" | "observed" | "estimated";
    mass?: "exact" | "observed" | "estimated";
    temperature?: "exact" | "observed" | "estimated";
    radius?: "exact" | "observed" | "estimated";
    luminosity?: "exact" | "observed" | "estimated";
    displayColor?: "exact" | "observed" | "estimated";
  };
  stellarProfileComposition?: "complete" | "partial";
  stellarPrimaryBodyId?: number;
  stellarComponents?: StellarComponentDetails[];
};

export type PegeWorkerResponse =
  | {
      type: "batch";
      requestId: number;
      batch: PackedSystemBatch;
    }
  | {
      type: "tile-plan";
      requestId: number;
      tiles: readonly {
        key: PegeSpatialTileKey;
        keyString: string;
        targetSystems: number;
        populationWeight: number;
      }[];
    }
  | {
      type: "tile-batch";
      requestId: number;
      tileKey: PegeSpatialTileKey;
      tileKeyString: string;
      selectionOffset: number;
      batch: PackedSystemBatch;
    }
  | {
      type: "tile-density";
      requestId: number;
      tileKey: PegeSpatialTileKey;
      tileKeyString: string;
      density: PackedDensityBatch;
    }
  | {
      type: "progress";
      requestId: number;
      phase: GalaxyLoadPhase;
      completed: number;
      total?: number;
    }
  | { type: "complete"; requestId: number }
  | { type: "cancelled"; requestId: number }
  | {
      type: "resolved";
      requestId: number;
      system?: ResolvedPegeSystem;
    }
  | {
      type: "suggestions";
      requestId: number;
      suggestions: SystemSuggestion[];
    }
  | {
      type: "previews";
      requestId: number;
      previews: SystemLocationPreview[];
    }
  | { type: "display-name"; requestId: number; name?: string }
  | { type: "error"; requestId: number; message: string };
