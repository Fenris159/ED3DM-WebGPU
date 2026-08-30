const SOLAR_RADIUS_METERS = 695_700_000;
const SOLAR_EFFECTIVE_TEMPERATURE_KELVIN = 5_772;
const SOLAR_ABSOLUTE_VISUAL_MAGNITUDE = 4.83;

export function stellarLuminositySolar(
  radiusMeters: number | undefined,
  surfaceTemperatureKelvin: number | undefined,
  absoluteMagnitude?: number,
): number | undefined {
  if (
    radiusMeters !== undefined &&
    surfaceTemperatureKelvin !== undefined &&
    Number.isFinite(radiusMeters) &&
    Number.isFinite(surfaceTemperatureKelvin) &&
    radiusMeters > 0 &&
    surfaceTemperatureKelvin > 0
  ) {
    const radiusRatio = radiusMeters / SOLAR_RADIUS_METERS;
    const temperatureRatio =
      surfaceTemperatureKelvin / SOLAR_EFFECTIVE_TEMPERATURE_KELVIN;
    return radiusRatio ** 2 * temperatureRatio ** 4;
  }
  if (absoluteMagnitude !== undefined && Number.isFinite(absoluteMagnitude)) {
    return 10 ** ((SOLAR_ABSOLUTE_VISUAL_MAGNITUDE - absoluteMagnitude) / 2.5);
  }
  return undefined;
}

export function stellarBrightnessScale(
  luminositySolar: number | undefined,
): number {
  if (
    luminositySolar === undefined ||
    !Number.isFinite(luminositySolar) ||
    luminositySolar <= 0
  ) {
    return 1;
  }
  const logarithmic =
    1 + Math.log10(Math.max(0.0001, luminositySolar)) * 0.16;
  return Math.min(1.7, Math.max(0.7, logarithmic));
}

