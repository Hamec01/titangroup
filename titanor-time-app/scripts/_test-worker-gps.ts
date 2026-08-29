// GPS steps 2+3 (2026-08-28) — lib/worker-gps.ts: best-fix-of-window selection, permission-state
// probe, and captureGpsSnapshot's "wait for a usable fix, else return the least-bad one" behaviour.
// No DB. Browser globals are mocked where needed.
import {
  pickBestFix,
  evaluateZoneProximity,
  haversineDistanceMeters,
  getGeolocationPermissionState,
  captureGpsSnapshot,
  currentBestFix,
  hasFreshGoodFix,
  loadPersistedFix,
  clearPersistedFix,
  isGeoOnboarded,
  markGeoOnboarded,
  clearGeoOnboarded,
  __resetGpsForTest,
  __pushFixForTest,
  __setPersistedFixForTest,
  MAX_ACCEPTABLE_ACCURACY_METERS
} from '../lib/worker-gps';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL:', n, x ?? '');
  }
};

async function main() {
  // --- pickBestFix ---
  const now = 1_000_000;
  const fixes = [
    { latitude: 60.44, longitude: 22.2, accuracyMeters: 2000, at: now - 50_000 },
    { latitude: 60.441, longitude: 22.201, accuracyMeters: 25, at: now - 20_000 },
    { latitude: 60.442, longitude: 22.202, accuracyMeters: 12, at: now - 120_000 } // stale
  ];
  check('pickBestFix picks the smallest-accuracy fix within the window', pickBestFix(fixes, 60_000, now)?.accuracyMeters === 25, pickBestFix(fixes, 60_000, now));
  check('pickBestFix ignores fixes older than the window', pickBestFix(fixes, 60_000, now)?.accuracyMeters !== 12);
  check('pickBestFix returns null when all fixes are stale', pickBestFix(fixes, 10_000, now) === null);
  check('pickBestFix returns null for an empty list', pickBestFix([], 60_000, now) === null);
  check('pickBestFix widened window reaches the 12 m fix', pickBestFix(fixes, 200_000, now)?.accuracyMeters === 12);

  // --- evaluateZoneProximity (regression) ---
  const geo = { latitude: 60.4436, longitude: 22.2079, radiusMeters: 650 };
  check('inside at good accuracy -> INSIDE', evaluateZoneProximity({ latitude: 60.4440, longitude: 22.2085, accuracyMeters: 15 }, geo) === 'INSIDE');
  check('2 km away at good accuracy -> OUTSIDE', evaluateZoneProximity({ latitude: 60.46, longitude: 22.23, accuracyMeters: 15 }, geo) === 'OUTSIDE');
  check('accuracy over the gate -> LOW_ACCURACY', evaluateZoneProximity({ latitude: 60.4440, longitude: 22.2085, accuracyMeters: 2000 }, geo) === 'LOW_ACCURACY');
  check('MAX_ACCEPTABLE_ACCURACY_METERS is 75', MAX_ACCEPTABLE_ACCURACY_METERS === 75);

  // --- haversine sanity ---
  const d = haversineDistanceMeters(60.4436, 22.2079, 60.4536, 22.2079);
  check('haversine ~1.11 km for 0.01 deg lat', d > 1050 && d < 1160, d);

  // --- node env (no navigator) ---
  check('getGeolocationPermissionState -> unsupported without navigator', (await getGeolocationPermissionState()) === 'unsupported');
  const noNav = await captureGpsSnapshot();
  check('captureGpsSnapshot without navigator -> null + POSITION_UNAVAILABLE', noNav.location === null && noNav.gpsUnavailableReason === 'POSITION_UNAVAILABLE', noNav);

  // --- __pushFixForTest + currentBestFix ---
  __resetGpsForTest();
  __pushFixForTest({ latitude: 60.44, longitude: 22.2, accuracyMeters: 1800 });
  __pushFixForTest({ latitude: 60.441, longitude: 22.201, accuracyMeters: 30 });
  check('currentBestFix returns the pushed best (30 m)', currentBestFix(60_000)?.accuracyMeters === 30, currentBestFix(60_000));

  // --- captureGpsSnapshot with a mocked geolocation that improves over time ---
  __resetGpsForTest();
  let watchCb: ((pos: unknown) => void) | null = null;
  const g: Record<string, unknown> = {
    getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: 60.44, longitude: 22.2, accuracy: 1500 } }),
    watchPosition: (ok: (p: unknown) => void) => {
      watchCb = ok;
      return 7;
    },
    clearWatch: () => {
      watchCb = null;
    }
  };
  Object.defineProperty(globalThis, 'navigator', { value: { geolocation: g }, configurable: true, writable: true });

  // after 1.2 s the watch delivers a good fix
  setTimeout(() => watchCb && watchCb({ coords: { latitude: 60.4441, longitude: 22.2081, accuracy: 22 } }), 1200);
  const improved = await captureGpsSnapshot();
  check('captureGpsSnapshot returns the improved 22 m fix, not the initial 1500 m', improved.location?.accuracyMeters === 22, improved);

  // when the watch never improves, it still returns the best (poor) fix, not null
  __resetGpsForTest();
  (g.getCurrentPosition as (ok: (p: unknown) => void) => void) = (ok) => ok({ coords: { latitude: 60.44, longitude: 22.2, accuracy: 1900 } });
  const poor = await captureGpsSnapshot();
  check('captureGpsSnapshot returns the poor 1900 m fix (server will make a GPS exception)', poor.location?.accuracyMeters === 1900 && poor.gpsUnavailableReason === null, poor);

  Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true, writable: true });

  // --- T12 GPS step 1 — onboarding flag (localStorage-backed, must never throw) ---
  check('isGeoOnboarded -> false without localStorage', isGeoOnboarded() === false);
  markGeoOnboarded(); // no localStorage -> silently no-ops, must not throw
  check('markGeoOnboarded without localStorage is a safe no-op', isGeoOnboarded() === false);

  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k)
    },
    configurable: true,
    writable: true
  });
  check('isGeoOnboarded -> false before marking', isGeoOnboarded() === false);
  markGeoOnboarded();
  check('isGeoOnboarded -> true after markGeoOnboarded', isGeoOnboarded() === true);
  clearGeoOnboarded();
  check('isGeoOnboarded -> false after clearGeoOnboarded', isGeoOnboarded() === false);

  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('storage disabled');
      },
      removeItem: () => {
        throw new Error('storage disabled');
      }
    },
    configurable: true,
    writable: true
  });
  check('isGeoOnboarded swallows a throwing localStorage', isGeoOnboarded() === false);
  markGeoOnboarded();
  clearGeoOnboarded();
  check('mark/clear swallow a throwing localStorage', true);
  Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true });

  // --- T14 — offline resilience: persisted last-good fix + approximate flag + abort ---
  {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k)
      },
      configurable: true,
      writable: true
    });
    // a geolocation that ALWAYS times out with no fix (indoors + offline)
    const deadGeo: Record<string, unknown> = {
      getCurrentPosition: (_ok: unknown, err: (e: unknown) => void) => err({ code: 3, TIMEOUT: 3, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2 }),
      watchPosition: () => 9,
      clearWatch: () => {}
    };
    Object.defineProperty(globalThis, 'navigator', { value: { geolocation: deadGeo }, configurable: true, writable: true });

    __resetGpsForTest();
    check('hasFreshGoodFix -> false with an empty buffer', hasFreshGoodFix() === false);
    __pushFixForTest({ latitude: 60.4441, longitude: 22.2081, accuracyMeters: 20 });
    check('hasFreshGoodFix -> true after a 20 m fix', hasFreshGoodFix() === true);

    // pushFix persisted that good fix
    const persisted = loadPersistedFix();
    check('a good fix is persisted to localStorage', !!persisted && persisted.location.accuracyMeters === 20, persisted);

    // a wildly inaccurate fix is NOT persisted as "last good"
    clearPersistedFix();
    __pushFixForTest({ latitude: 60.44, longitude: 22.2, accuracyMeters: 1500 });
    check('a 1500 m fix is NOT persisted', loadPersistedFix() === null);

    // capture with an empty buffer + no live fix + a persisted fix 8 min old -> approximate
    __resetGpsForTest();
    __setPersistedFixForTest({ latitude: 60.4438, longitude: 22.208, accuracyMeters: 30 }, 8 * 60_000);
    const approx = await captureGpsSnapshot({ maxWaitMs: 300 });
    check('captureGpsSnapshot falls back to the persisted fix, approximate=true', approx.location?.latitude === 60.4438 && approx.approximate === true, approx);
    check('  fixAgeSeconds ~ 480 (8 min)', typeof approx.fixAgeSeconds === 'number' && approx.fixAgeSeconds >= 470 && approx.fixAgeSeconds <= 490, approx.fixAgeSeconds);
    check('  approximate fallback carries the failed-fresh-read reason (TIMEOUT)', approx.gpsUnavailableReason === 'TIMEOUT', approx.gpsUnavailableReason);

    // persisted fix older than the 30-min TTL is ignored
    __resetGpsForTest();
    __setPersistedFixForTest({ latitude: 60.4438, longitude: 22.208, accuracyMeters: 30 }, 45 * 60_000);
    const tooOld = await captureGpsSnapshot({ maxWaitMs: 300 });
    check('a persisted fix older than 30 min is not used -> null + TIMEOUT', tooOld.location === null && tooOld.gpsUnavailableReason === 'TIMEOUT', tooOld);

    // abort signal -> returns immediately with the best available (a buffered fix here)
    __resetGpsForTest();
    __pushFixForTest({ latitude: 60.4441, longitude: 22.2081, accuracyMeters: 900 }); // poor but present
    const ac = new AbortController();
    ac.abort();
    const aborted = await captureGpsSnapshot({ signal: ac.signal, maxWaitMs: 20_000 });
    check('aborted capture returns the buffered fix immediately, not null', aborted.location?.accuracyMeters === 900 && aborted.approximate === false, aborted);

    Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true });
  }

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
