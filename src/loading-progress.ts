import type { GalaxyLoadProgress } from "./types";

const PHASES = {
  download: { start: 0, end: 55, label: "Downloading PEGE engine data" },
  decode: { start: 55, end: 68, label: "Decoding the galaxy engine" },
  overview: { start: 68, end: 94, label: "Generating the galaxy overview" },
  prepare: { start: 94, end: 98, label: "Preparing the map" },
  detail: { start: 0, end: 100, label: "Generating local detail" },
} as const;

const FILTER_PHASES = {
  download: { start: 0, end: 5, label: "Preparing PEGE filter" },
  decode: { start: 5, end: 10, label: "Preparing PEGE filter" },
  overview: { start: 0, end: 90, label: "Applying stellar filter... Please Wait" },
  prepare: { start: 90, end: 94, label: "Preparing filtered stars... Please Wait" },
  detail: { start: 94, end: 99, label: "Rendering filtered stars... Please Wait" },
} as const;

function progressRatio(progress: GalaxyLoadProgress): number {
  return progress.total && progress.total > 0
    ? Math.min(1, Math.max(0, progress.completed / progress.total))
    : progress.completed > 0
      ? 1
      : 0;
}

export function galaxyLoadProgressComplete(progress: GalaxyLoadProgress): boolean {
  return progress.total && progress.total > 0
    ? progress.completed >= progress.total
    : progress.completed > 0;
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

export function detailLoadPresentation(
  progress: GalaxyLoadProgress,
  rendered = false,
): {
  percent: number;
  label: string;
} {
  if (rendered) return { percent: 100, label: "Loaded" };
  const percent = Math.min(99, Math.round(progressRatio(progress) * 100));
  return {
    percent,
    label: percent >= 99
      ? "Rendering stars... Please Wait"
      : "Loaded... Please Wait",
  };
}

export function filterApplyPresentation(
  progress: GalaxyLoadProgress,
  rendered = false,
): {
  percent: number;
  label: string;
} {
  if (rendered) return { percent: 100, label: "Filter applied" };
  const phase = FILTER_PHASES[progress.phase];
  const ratio = progressRatio(progress);
  return {
    percent: Math.min(99, Math.round(phase.start + (phase.end - phase.start) * ratio)),
    label: phase.label,
  };
}

export function filteredDetailResultPresentation(
  matchingDetailCount: number,
  localDetailActive = true,
): {
  percent: number;
  label: string;
} {
  if (!localDetailActive) {
    return {
      percent: 100,
      label: "Overview ready · zoom in for factual stars",
    };
  }
  const count = Math.max(0, Math.floor(matchingDetailCount));
  if (count === 0) {
    return {
      percent: 100,
      label: "Loaded · no matching stars in this area",
    };
  }
  return {
    percent: 100,
    label: `Loaded · ${count.toLocaleString()} matching ${count === 1 ? "star" : "stars"}`,
  };
}
