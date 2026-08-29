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
//
// T14 (2026-08-29) — GPS offline resilience (owner request, shipyard indoor/offline check-ins):
//   - the capture falls back to an OS-cached fix (`maximumAge` up to 15 min) and then to a single
//     last-good fix this device persists in localStorage (bounded to 30 min). When it can only
//     offer such a stale point it is returned as `approximate: true` with `fixAgeSeconds` — the
//     server records it as an approximate location, shown on the admin map as a dashed marker,
//     never a verified one.
//   - `captureGpsSnapshot({ maxWaitMs, signal })` — the clock panel shows a "getting your
//     location…" countdown and lets the worker press "check in anyway", which aborts the wait and
//     takes the best-available point immediately.
// The persisted fix is one coordinate, on this device only, expired after 30 min — the offline
// outbox already persists check-in coordinates to IndexedDB, so this is not a new data boundary.
// Coordinates are rounded to the same decimal precision lib/attendance-clock.ts's roundTripDecimal
// enforces server-side (numeric(8,6)/numeric(9,6) lat/lon, numeric(6,1) accuracy).

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
  /** T14 — true when `location` is a stale/cached fix, not a fresh reading at the moment of the
   *  clock event. `fixAgeSeconds` is how old it is. The server marks the recorded coordinate
   *  approximate; the geofence check does not "verify" an approximate point. */
  approximate: boolean;
  fixAgeSeconds: number | null;
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

// T12 GPS step 1 — "разрешить навсегда". iOS Safari's navigator.permissions.query({name:'geolocation'})
// reports 'prompt' even when the site grant is actually live, and an indoor getCurrentPosition often
// TIMEOUTs without a fix — the pre-T12 code kept re-showing the onboarding banner in both cases, so
// the worker "allowed" and nothing changed. This one boolean records "the worker went through the
// onboarding once on this device"; once set we run the watch silently and only flip to the blocked
// banner on an *explicit* PERMISSION_DENIED from the OS. It is a UX hint only — never a coordinate,
// never PII — so localStorage is fine here (unlike the fix buffer, which stays in memory).
const GEO_ONBOARDED_KEY = 'titanor.geo.onboarded';

export function isGeoOnboarded(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(GEO_ONBOARDED_KEY) === '1';
  } catch {
    return false;
  }
}

export function markGeoOnboarded(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(GEO_ONBOARDED_KEY, '1');
    }
  } catch {
    // Private mode / storage disabled — the banner logic still works, it just can't remember
    // across reloads. No worse than the pre-T12 behaviour.
  }
}

export function clearGeoOnboarded(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(GEO_ONBOARDED_KEY);
    }
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------------------------
// T14 — last-good-fix persistence (one coordinate, this device only, 30-min TTL)
// ---------------------------------------------------------------------------------------------

const PERSISTED_FIX_KEY = 'titanor.geo.lastFix';
const PERSISTED_FIX_TTL_MS = 30 * 60_000;
// Don't persist a wildly inaccurate reading as "last good" — a 1500 m fix is no better than none.
const PERSIST_ACCURACY_CAP_METERS = 300;

interface PersistedFix extends GpsLocation {
  at: number;
}

function persistFix(loc: GpsLocation): void {
  if (loc.accuracyMeters > PERSIST_ACCURACY_CAP_METERS) return;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PERSISTED_FIX_KEY, JSON.stringify({ ...loc, at: Date.now() }));
    }
  } catch {
    // storage disabled — the in-memory buffer still works within its 90 s window
  }
}

/** The last good fix this device saw, if it is still within the TTL. `ageMs` is how old it is. */
export function loadPersistedFix(now = Date.now()): { location: GpsLocation; ageMs: number } | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(PERSISTED_FIX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedFix>;
    if (typeof parsed.latitude !== 'number' || typeof parsed.longitude !== 'number' || typeof parsed.accuracyMeters !== 'number' || typeof parsed.at !== 'number') {
      return null;
    }
    const ageMs = now - parsed.at;
    if (ageMs < 0 || ageMs > PERSISTED_FIX_TTL_MS) return null;
    return { location: { latitude: parsed.latitude, longitude: parsed.longitude, accuracyMeters: parsed.accuracyMeters }, ageMs };
  } catch {
    return null;
  }
}

export function clearPersistedFix(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(PERSISTED_FIX_KEY);
  } catch {
    // ignore
  }
}

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
  // T14 — remember the best fix on the device so an offline/indoor capture later has something.
  if (loc.accuracyMeters <= MAX_ACCEPTABLE_ACCURACY_METERS) {
    persistFix(loc);
  }
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
 * granted and clears it on unmount. `onPermissionDenied` fires if the OS reports the grant was
 * revoked while the watch is running (worker turned Location off mid-session) — the panel uses it
 * to flip back to the blocked banner and forget the onboarding flag. */
export function startGpsWatch(onPermissionDenied?: () => void): void {
  if (watchId !== null || typeof navigator === 'undefined' || !navigator.geolocation) {
    return;
  }
  watchId = navigator.geolocation.watchPosition(
    (pos) => pushFix(normalize(pos.coords)),
    (err) => {
      // A transient POSITION_UNAVAILABLE / TIMEOUT while walking indoors is expected and non-fatal —
      // captureGpsSnapshot() surfaces those when a capture is actually needed. Only an explicit
      // PERMISSION_DENIED means the grant is really gone.
      if (err.code === err.PERMISSION_DENIED) {
        onPermissionDenied?.();
      }
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
// A fix the OS already had (from another app, or from when the worker was outside) — accept up to
// 15 min old rather than always forcing a fresh lock the device can't get indoors/offline.
const OS_CACHE_MAX_AGE_MS = 15 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const FRESH: Pick<GpsSnapshot, 'approximate' | 'fixAgeSeconds'> = { approximate: false, fixAgeSeconds: null };

/** Returns true when a fresh, accurate fix is on hand right now — the panel uses this to skip the
 *  "getting your location…" wait entirely. */
export function hasFreshGoodFix(): boolean {
  const f = bestRecentFix(60_000);
  return !!f && f.accuracyMeters <= MAX_ACCEPTABLE_ACCURACY_METERS;
}

function getCurrentPositionCached(maxAgeMs: number, timeoutMs: number): Promise<{ location: GpsLocation | null; reason: ClientGpsUnavailableReason | null }> {
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = normalize(pos.coords);
        pushFix(loc);
        resolve({ location: loc, reason: null });
      },
      (err) => resolve({ location: null, reason: mapGeolocationError(err) }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: maxAgeMs }
    );
  });
}

/**
 * Best-effort GPS reading for a Check In/Out/Switch:
 *   1. a recent (<=60 s) fix already good enough (<= MAX_ACCEPTABLE_ACCURACY_METERS) — use it;
 *   2. otherwise run the watch, seed a getCurrentPosition, and poll the buffer up to `maxWaitMs`
 *      (default CAPTURE_WAIT_MS; the panel passes a shorter value and an AbortSignal so the worker
 *      can press "check in anyway");
 *   3. the best fresh-ish fix in the buffer, even if inaccurate — still `approximate: false`;
 *   4. an OS-cached fix up to 15 min old — `approximate: true`;
 *   5. the device's persisted last-good fix (<= 30 min) — `approximate: true`;
 *   6. nothing — { location: null, reason }.
 */
export async function captureGpsSnapshot(opts: { maxWaitMs?: number; signal?: AbortSignal } = {}): Promise<GpsSnapshot> {
  const maxWaitMs = opts.maxWaitMs ?? CAPTURE_WAIT_MS;
  const aborted = () => opts.signal?.aborted ?? false;

  const finishWithBestAvailable = async (lastError: ClientGpsUnavailableReason | null): Promise<GpsSnapshot> => {
    const buffered = bestRecentFix(maxWaitMs + 10_000);
    if (buffered) return { location: buffered, gpsUnavailableReason: null, ...FRESH };
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      const cached = await getCurrentPositionCached(OS_CACHE_MAX_AGE_MS, 4000);
      if (cached.location) {
        // The OS reading may itself be a few minutes old; we can't tell exactly, so treat it as
        // approximate but don't claim a precise age.
        return { location: cached.location, gpsUnavailableReason: null, approximate: true, fixAgeSeconds: null };
      }
      lastError = lastError ?? cached.reason;
    }
    const persisted = loadPersistedFix();
    if (persisted) {
      return { location: persisted.location, gpsUnavailableReason: null, approximate: true, fixAgeSeconds: Math.round(persisted.ageMs / 1000) };
    }
    return { location: null, gpsUnavailableReason: lastError ?? 'POSITION_UNAVAILABLE', ...FRESH };
  };

  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return { location: null, gpsUnavailableReason: 'POSITION_UNAVAILABLE', ...FRESH };
  }

  const alreadyGood = bestRecentFix(60_000);
  if (alreadyGood && alreadyGood.accuracyMeters <= MAX_ACCEPTABLE_ACCURACY_METERS) {
    return { location: alreadyGood, gpsUnavailableReason: null, ...FRESH };
  }
  if (aborted()) return finishWithBestAvailable(null);

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
      { enableHighAccuracy: true, timeout: maxWaitMs, maximumAge: 0 }
    );
  });

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline && !aborted()) {
    const candidate = bestRecentFix(maxWaitMs + 5000);
    if (candidate && candidate.accuracyMeters <= MAX_ACCEPTABLE_ACCURACY_METERS) {
      return { location: candidate, gpsUnavailableReason: null, ...FRESH };
    }
    await sleep(CAPTURE_POLL_MS);
  }
  if (!aborted()) await seeded;

  return finishWithBestAvailable(lastError);
}

/** Test-only: reset the module buffer/watch state. */
export function __resetGpsForTest(): void {
  watchId = null;
  recentFixes = [];
  clearPersistedFix();
}

/** Test-only: seed the persisted last-good fix as if it were saved `ageMs` ago. */
export function __setPersistedFixForTest(loc: GpsLocation, ageMs: number): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PERSISTED_FIX_KEY, JSON.stringify({ ...loc, at: Date.now() - ageMs }));
    }
  } catch {
    // ignore
  }
}

/** Test-only: feed a fix into the buffer as if the watch produced it. */
export function __pushFixForTest(loc: GpsLocation, atMs?: number): void {
  const now = atMs ?? Date.now();
  recentFixes.push({ ...loc, at: now });
  recentFixes = recentFixes.slice(-FIX_BUFFER_MAX);
  if (atMs === undefined && loc.accuracyMeters <= MAX_ACCEPTABLE_ACCURACY_METERS) {
    persistFix(loc);
  }
}
