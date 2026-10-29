export const DEFAULT_MAX_GPS_ACCURACY_METERS = 500;

export function effectiveGpsAccuracyMeters(configuredMeters: number | null | undefined): number {
  return configuredMeters ?? DEFAULT_MAX_GPS_ACCURACY_METERS;
}
