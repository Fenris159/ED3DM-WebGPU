import { describe, expect, it } from "vitest";
import { heightRailLayout } from "../demo/hud-layout";

describe("responsive height controls", () => {
  it("keeps the rail between wrapped filters and the compass", () => {
    const layout = heightRailLayout({
      viewportHeight: 474,
      hudBottom: 211,
      compassTop: 386,
    });
    expect(layout.top).toBeGreaterThan(211);
    expect(474 - layout.bottom).toBeLessThan(386);
    expect(layout.compact).toBe(true);
    expect(layout.hidden).toBe(false);

    expect(
      heightRailLayout({ viewportHeight: 220, hudBottom: 150, compassTop: 132 }).hidden,
    ).toBe(true);
  });
});
