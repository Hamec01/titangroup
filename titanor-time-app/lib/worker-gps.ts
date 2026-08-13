// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §5.1/§9 (GPS UX) — browser-only helper used by
// app/worker/WorkerClockPanel.tsx. Never calls watchPosition, never persists a reading anywhere
// (localStorage/sessionStorage/IndexedDB), never logs a coordinate. Coordinates are rounded to the
// same decimal precision lib/attendance-clock.ts's roundTripDecimal enforces server-side
// (numeric(8,6)/numeric(9,6) lat/lon, numeric(6,1) accuracy) so a genuine reading is never bounced
// back as VALIDATION_ERROR by an extra float digit picked up from the device.

export type ClientGpsUnavailableReason = 'PERMISSION_DENIED' | 'TIMEOUT' | 'POSITION_UNAVAILABLE';

export interface GpsSnapshot {
  location: { latitude: number; longitude: number; accuracyMeters: number } | null;
  gpsUnavailableReason: ClientGpsUnavailableReason | null;
}

const GEOLOCATION_TIMEOUT_MS = 12000;

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function mapGeolocationError(error: GeolocationPositionError): ClientGpsUnavailableReason {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return 'PERMISSION_DENIED';
    case error.TIMEOUT:
      return 'TIMEOUT';
    case error.POSITION_UNAVAILABLE:
    default:
      return 'POSITION_UNAVAILABLE';
  }
}

/** One-shot reading — never watchPosition (§6 client protocol is offline-outbox only, out of scope here; this UI only ever needs a single snapshot per attempt). */
export async function captureGpsSnapshot(): Promise<GpsSnapshot> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return { location: null, gpsUnavailableReason: 'POSITION_UNAVAILABLE' };
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          location: {
            latitude: round(position.coords.latitude, 6),
            longitude: round(position.coords.longitude, 6),
            accuracyMeters: round(position.coords.accuracy, 1)
          },
          gpsUnavailableReason: null
        });
      },
      (error) => {
        resolve({ location: null, gpsUnavailableReason: mapGeolocationError(error) });
      },
      { enableHighAccuracy: true, timeout: GEOLOCATION_TIMEOUT_MS, maximumAge: 0 }
    );
  });
}
