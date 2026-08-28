// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §5.1/§9 (GPS UX) + T11_GPS_IMPROVEMENTS_DESIGN.md
// (2026-08-28, GPS steps 2+3). Browser-only helper used by app/worker/WorkerClockPanel.tsx.
//
// GPS steps 2+3 changed the capture model, at the owner's explicit request:
//   - one long-lived `watchPosition` (startGpsWatch/stopGpsWatch) owned by the clock panel while
//     it is mounted — the OS keeps ONE permission session for the lifetime of that watch, so the
//     worker is not re-prompted, and the GPS chip stays warm so accuracy improves over time;
//   - `captureGpsSnapshot()` returns the BEST recent fix (lowest accuracy value) rather than the
//     first instantaneous reading, and actively waits up to ~25 s for a usable fix before giving
//     up — instead of the previous single 12 s getCurrentPosition.
// Still never persists a reading anywhere (localStorage/sessionStorage/IndexedDB) and never logs
// a coordinate. Coordinates are rounded to the same decimal precision lib/attendance-clock.ts's
// roundTripDecimal enforces server-side (numeric(8,6)/numeric(9,6) lat/lon, numeric(6,1) accuracy).

export type ClientGpsUnavailableReason = 'PERMISSION_DENIED' | 'TIMEOUT' | 'POSITION_UNAVAILABLE';

const EARTH_RADIUS_METERS = 6371000;
// Mirrors lib/attendance-clock.ts's MAX_ACCEPTABLE_ACCURACY_METERS — a fix at or under this is
// "good enough" to stop waiting for a better one and to render the client "in zone" badge.
export const MAX_ACCEPTABLE_ACCURACY_METERS = 75;

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

export interface GpsLocation {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
}

export interface GpsSnapshot {
  location: GpsLocation | null;
  gpsUnavailableReason: ClientGpsUnavailableReason | null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function normalize(coords: GeolocationCoordinates): GpsLocation {
  return { latitude: round(coords.latitude, 6), longitude: round(coords.longitude, 6), accuracyMeters: round(coords.accuracy, 1) };
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

// ---------------------------------------------------------------------------------------------
// Permission state (GPS step 2)
// ---------------------------------------------------------------------------------------------

export type GeolocationPermissionState = 'granted' | 'prompt' | 'denied' | 'unsupported';

/** navigator.permissions is not everywhere (older iOS Safari); 'unsupported' means "just try". */
export async function getGeolocationPermissionState(): Promise<GeolocationPermissionState> {
  if (typeof navigator === 'undefined' || !navigator.permissions || typeof navigator.permissions.query !== 'function') {
    return 'unsupported';
  }
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    return status.state as GeolocationPermissionState;
  } catch {
    return 'unsupported';
  }
}

/** Triggers the OS permission prompt once (via a plain getCurrentPosition) and reports the outcome
 * so the onboarding screen can react. On success the caller should startGpsWatch(). */
export async function requestGeolocationPermission(): Promise<{ granted: boolean; reason: ClientGpsUnavailableReason | null }> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return { granted: false, reason: 'POSITION_UNAVAILABLE' };
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        pushFix(normalize(pos.coords));
        resolve({ granted: true, reason: null });
      },
      (err) => resolve({ granted: false, reason: mapGeolocationError(err) }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Long-lived watch + best-fix buffer (GPS steps 2+3)
// ---------------------------------------------------------------------------------------------

interface TimedFix extends GpsLocation {
  at: number;
}

const FIX_BUFFER_MS = 90_000;
const FIX_BUFFER_MAX = 24;
let recentFixes: TimedFix[] = [];
let watchId: number | null = null;

function pushFix(loc: GpsLocation): void {
  const now = Date.now();
  recentFixes.push({ ...loc, at: now });
  const cutoff = now - FIX_BUFFER_MS;
  recentFixes = recentFixes.filter((f) => f.at >= cutoff).slice(-FIX_BUFFER_MAX);
}

/** Pure — the "which of these recent fixes do we trust most" rule, extracted for testing.
 * Returns the freshest-window fix with the smallest accuracy value, or null. */
export function pickBestFix(fixes: { latitude: number; longitude: number; accuracyMeters: number; at: number }[], maxAgeMs: number, now: number): GpsLocation | null {
  const fresh = fixes.filter((f) => now - f.at <= maxAgeMs);
  if (fresh.length === 0) {
    return null;
  }
  const best = fresh.reduce((acc, f) => (f.accuracyMeters < acc.accuracyMeters ? f : acc));
  return { latitude: best.latitude, longitude: best.longitude, accuracyMeters: best.accuracyMeters };
}

function bestRecentFix(maxAgeMs = 60_000): GpsLocation | null {
  return pickBestFix(recentFixes, maxAgeMs, Date.now());
}

/** The best fix currently known without triggering any new request — for a passive "in zone"
 * badge / accuracy readout. */
export function currentBestFix(maxAgeMs = 60_000): GpsLocation | null {
  return bestRecentFix(maxAgeMs);
}

export function isGpsWatchActive(): boolean {
  return watchId !== null;
}

/** Start the single long-lived watch. Idempotent. The clock panel calls this once permission is
 * granted and clears it on unmount. */
export function startGpsWatch(): void {
  if (watchId !== null || typeof navigator === 'undefined' || !navigator.geolocation) {
    return;
  }
  watchId = navigator.geolocation.watchPosition(
    (pos) => pushFix(normalize(pos.coords)),
    () => {
      // Errors here are non-fatal — captureGpsSnapshot() surfaces the reason when a capture is
      // actually needed. A transient POSITION_UNAVAILABLE while walking indoors is expected.
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 }
  );
}

export function stopGpsWatch(): void {
  if (watchId !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
    navigator.geolocation.clearWatch(watchId);
  }
  watchId = null;
  recentFixes = [];
}

const CAPTURE_WAIT_MS = 25_000;
const CAPTURE_POLL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Best-effort GPS reading for a Check In/Out/Switch:
 *   1. if a recent (<=60 s) fix is already good enough (<= MAX_ACCEPTABLE_ACCURACY_METERS), use it;
 *   2. otherwise ensure the watch is running, fire one getCurrentPosition to seed, and poll the
 *      buffer for up to CAPTURE_WAIT_MS for a good fix;
 *   3. if none arrives, return the best (possibly poor) fix seen — the server records it and
 *      creates a GPS_NOT_VERIFIED exception, same as before, but now with the least-bad point.
 * Returns { location: null, reason } only when there is genuinely nothing (permission denied /
 * geolocation unavailable / never got a single fix).
 */
export async function captureGpsSnapshot(): Promise<GpsSnapshot> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return { location: null, gpsUnavailableReason: 'POSITION_UNAVAILABLE' };
  }

  const alreadyGood = bestRecentFix(60_000);
  if (alreadyGood && alreadyGood.accuracyMeters <= MAX_ACCEPTABLE_ACCURACY_METERS) {
    return { location: alreadyGood, gpsUnavailableReason: null };
  }

  startGpsWatch();

  let lastError: ClientGpsUnavailableReason | null = null;
  const seeded = new Promise<void>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        pushFix(normalize(pos.coords));
        resolve();
      },
      (err) => {
        lastError = mapGeolocationError(err);
        resolve();
      },
      { enableHighAccuracy: true, timeout: CAPTURE_WAIT_MS, maximumAge: 0 }
    );
  });

  const deadline = Date.now() + CAPTURE_WAIT_MS;
  while (Date.now() < deadline) {
    const candidate = bestRecentFix(CAPTURE_WAIT_MS + 5000);
    if (candidate && candidate.accuracyMeters <= MAX_ACCEPTABLE_ACCURACY_METERS) {
      return { location: candidate, gpsUnavailableReason: null };
    }
    await sleep(CAPTURE_POLL_MS);
  }
  await seeded;

  const best = bestRecentFix(CAPTURE_WAIT_MS + 10_000);
  if (best) {
    return { location: best, gpsUnavailableReason: null };
  }
  return { location: null, gpsUnavailableReason: lastError ?? 'POSITION_UNAVAILABLE' };
}

/** Test-only: reset the module buffer/watch state. */
export function __resetGpsForTest(): void {
  watchId = null;
  recentFixes = [];
}

/** Test-only: feed a fix into the buffer as if the watch produced it. */
export function __pushFixForTest(loc: GpsLocation, atMs?: number): void {
  const now = atMs ?? Date.now();
  recentFixes.push({ ...loc, at: now });
  recentFixes = recentFixes.slice(-FIX_BUFFER_MAX);
}
