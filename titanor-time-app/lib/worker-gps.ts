// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §5.1/§9 (GPS UX) — browser-only helper used by
// app/worker/WorkerClockPanel.tsx. Never calls watchPosition, never persists a reading anywhere
// (localStorage/sessionStorage/IndexedDB), never logs a coordinate. Coordinates are rounded to the
// same decimal precision lib/attendance-clock.ts's roundTripDecimal enforces server-side
// (numeric(8,6)/numeric(9,6) lat/lon, numeric(6,1) accuracy) so a genuine reading is never bounced
// back as VALIDATION_ERROR by an extra float digit picked up from the device.

export type ClientGpsUnavailableReason = 'PERMISSION_DENIED' | 'TIMEOUT' | 'POSITION_UNAVAILABLE';

// Mirrors lib/attendance-clock.ts's evaluateGpsReading tolerance rule (radius + accuracy, same
// MAX_ACCEPTABLE_ACCURACY_METERS gate) so the client-side "in zone" badge below never disagrees
// with what the server will actually decide at Check In/Out — purely informational here, never
// itself enforced or sent to the server.
const EARTH_RADIUS_METERS = 6371000;
const MAX_ACCEPTABLE_ACCURACY_METERS = 75;

export function haversineDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

export type ZoneProximity = 'INSIDE' | 'OUTSIDE' | 'LOW_ACCURACY';

export function evaluateZoneProximity(
  location: { latitude: number; longitude: number; accuracyMeters: number },
  geofence: { latitude: number; longitude: number; radiusMeters: number }
): ZoneProximity {
  if (location.accuracyMeters > MAX_ACCEPTABLE_ACCURACY_METERS) {
    return 'LOW_ACCURACY';
  }
  const distanceMeters = haversineDistanceMeters(location.latitude, location.longitude, geofence.latitude, geofence.longitude);
  return distanceMeters <= geofence.radiusMeters + location.accuracyMeters ? 'INSIDE' : 'OUTSIDE';
}

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
