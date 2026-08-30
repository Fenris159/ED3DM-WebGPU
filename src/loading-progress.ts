import type { GalaxyLoadProgress } from "./types";

const PHASES = {
  download: { start: 0, end: 55, label: "Downloading PEGE 1.5 engine data" },
  decode: { start: 55, end: 68, label: "Decoding the galaxy engine" },
  overview: { start: 68, end: 94, label: "Generating the galaxy overview" },
  prepare: { start: 94, end: 98, label: "Preparing the map" },
  detail: { start: 0, end: 100, label: "Generating local detail" },
} as const;

function progressRatio(progress: GalaxyLoadProgress): number {
  return progress.total && progress.total > 0
    ? Math.min(1, Math.max(0, progress.completed / progress.total))
    : progress.completed > 0
      ? 1
      : 0;
}

export function galaxyLoadPresentation(progress: GalaxyLoadProgress): {
  percent: number;
  label: string;
} {
  const phase = PHASES[progress.phase];
  const ratio = progressRatio(progress);
  return {
    percent: Math.round(phase.start + (phase.end - phase.start) * ratio),
    label: phase.label,
  };
}

export function detailLoadPresentation(progress: GalaxyLoadProgress): {
  percent: number;
  label: string;
} {
  return {
    percent: Math.round(progressRatio(progress) * 100),
    label: "Loaded... Please Wait",
  };
}
