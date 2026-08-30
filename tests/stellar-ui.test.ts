import { describe, expect, it } from "vitest";
import { STELLAR_TYPES } from "pege";
import {
  STELLAR_FILTER_GROUPS,
  detailedStellarClass,
  renderSystemDetails,
  stellarFilterForKeys,
  stellarTypesForFilterKeys,
} from "../demo/stellar-ui";
import type { System } from "../src/types";

describe("stellar details and filters", () => {
  it("maps Elite galaxy-map filter choices to detailed PEGE primary classes", () => {
    expect(STELLAR_FILTER_GROUPS.map(({ label }) => label)).toEqual([
      "Scoopable",
      "Not scoopable",
      "Extras",
    ]);
    expect(stellarTypesForFilterKeys(["O", "white-dwarf"])).toEqual(
      expect.arrayContaining(["O", "D", "DA", "DB", "DC", "DQ", "DX"]),
    );
    expect(stellarTypesForFilterKeys(["proto", "wolf-rayet", "carbon"])).toEqual(
      expect.arrayContaining(["TTS", "AeBe", "W", "WN", "WC", "WO", "C", "CN", "S"]),
    );
    const mapped = new Set(
      STELLAR_FILTER_GROUPS.flatMap(({ choices }) =>
        choices.flatMap(({ types }) => types),
      ),
    );
    const supported = new Set<string>(STELLAR_TYPES);
    expect(stellarTypesForFilterKeys(["rogue-planet"])).toEqual(["RoguePlanet"]);
    expect(stellarFilterForKeys([])).toEqual({
      excludedStellarTypes: ["RoguePlanet"],
    });
    expect(stellarFilterForKeys(["G", "rogue-planet"])).toEqual({
      stellarTypes: ["G", "RoguePlanet"],
    });
    expect(STELLAR_TYPES.filter((type) => !mapped.has(type))).toEqual([
      "Nebula",
      "StellarRemnantNebula",
    ]);
    expect([...mapped].filter((type) => !supported.has(type))).toEqual([]);
    expect(detailedStellarClass({
      bodyId: 0,
      starType: "M_RedGiant",
      subclass: 3,
      luminosityClass: "III",
      validation: "exact",
    })).toBe("M red giant · M3 III");
    expect(detailedStellarClass({
      bodyId: 0,
      starType: "RoguePlanet",
      validation: "exact",
    })).toBe("Rogue planet");
  });

  it("renders present primary and secondary details without missing-value or provenance noise", () => {
    const system: System = {
      name: "Test System",
      id64: "42",
      coords: { x: 1, y: 2, z: 3 },
      generation: "ordinary",
      exactPosition: true,
      stellarProfileSource: "procedural-primary-model",
      stellarProfileValidation: "estimated",
      stellarComponents: [
        {
          bodyId: 0,
          starType: "G",
          subclass: 2,
          luminosityClass: "V",
          stellarMassSolar: 1,
          surfaceTemperatureKelvin: 5778,
          luminositySolar: 1.25,
          absoluteMagnitude: 4.83,
          validation: "exact",
        },
        {
          bodyId: 1,
          name: "Test System B",
          starType: "M",
          subclass: 4,
          luminosityClass: "V",
          stellarMassSolar: 0.3,
          validation: "exact",
        },
      ],
      stellarPrimaryBodyId: 0,
    };

    const html = renderSystemDetails(system);
    expect(html).toContain("Primary star");
    expect(html).toContain("G2 V");
    expect(html).toContain("Secondary star");
    expect(html).toContain("Test System B");
    expect(html).toContain("M4 V");
    expect(html).toContain("5,778 K");
    expect(html).toContain("Absolute magnitude");
    expect(html).toContain("Luminosity");
    expect(html).toContain("1.25 L☉");
    expect(html).not.toContain("Generation");
    expect(html).not.toContain("Profile");
    expect(html).not.toContain("not supplied");
    expect(html).not.toContain("Radius");
  });
});
