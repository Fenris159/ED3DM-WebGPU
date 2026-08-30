export type HeightRailLayoutInput = {
  viewportHeight: number;
  hudBottom: number;
  compassTop: number;
  gap?: number;
};

export type HeightRailLayout = {
  top: number;
  bottom: number;
  compact: boolean;
  hidden: boolean;
};

const MIN_RAIL_HEIGHT = 96;
const COMPACT_RAIL_HEIGHT = 210;

export function heightRailLayout({
  viewportHeight,
  hudBottom,
  compassTop,
  gap = 12,
}: HeightRailLayoutInput): HeightRailLayout {
  const top = Math.max(0, Math.ceil(hudBottom + gap));
  const bottom = Math.max(0, Math.ceil(viewportHeight - compassTop + gap));
  const available = viewportHeight - top - bottom;
  return {
    top,
    bottom,
    compact: available < COMPACT_RAIL_HEIGHT,
    hidden: available < MIN_RAIL_HEIGHT,
  };
}
