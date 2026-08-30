import type {
  GalaxyLoadPhase,
  GenerationKind,
  PegeSpatialTileKey,
  SystemLocationPreview,
  SystemSuggestion,
} from "./types";

export type PackedSystemBatch = {
  records: ArrayBuffer;
  names: readonly { systemIndex: number; name: string }[];
  stellarRecords?: ArrayBuffer;
  stellarRadii?: ArrayBuffer;
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
    }
  | {
      type: "overview";
      requestId: number;
      minimumFixedXyz: readonly [number, number, number];
      maximumExclusiveFixedXyz: readonly [number, number, number];
      targetSystems: number;
      selectionSeed: string;
      stellarLod: {
        mode: "presentation-balanced";
        strength: number;
      };
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
      tiles: readonly {
        key: PegeSpatialTileKey;
        targetSystems: number;
      }[];
      selectionSeed: string;
      stellarLod: {
        mode: "presentation-balanced";
        strength: number;
      };
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
  stellarProfileSource?: "compiled-catalogue" | "procedural-primary-model";
  stellarProfileValidation?: "exact" | "observed" | "estimated";
  stellarValidation?: {
    starType?: "exact" | "observed" | "estimated";
    mass?: "exact" | "observed" | "estimated";
    temperature?: "exact" | "observed" | "estimated";
    radius?: "exact" | "observed" | "estimated";
    displayColor?: "exact" | "observed" | "estimated";
  };
  stellarProfileComposition?: "complete" | "partial";
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
