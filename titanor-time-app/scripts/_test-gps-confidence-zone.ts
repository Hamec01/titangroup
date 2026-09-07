// GPS confidence zone (2026-09-07) — docs/titanor-time/GPS_CONFIDENCE_ZONE_250_RU.md.
// Pure classification of evaluateGpsReading: the four-way INSIDE / OUTSIDE / NEAR_BOUNDARY /
// LOW_ACCURACY decision, the 250 m absolute auto-verify ceiling on top of the company policy gate,
// and the exception-detail shape for the boundary case. No DB, no browser.
import { randomUUID } from 'node:crypto';
import {
  evaluateGpsReading,
  exceptionDetailForGps,
  MAX_AUTO_VERIFY_ACCURACY_METERS,
  type ClockGeofence
} from '../lib/attendance-clock';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL:', n, x ?? '');
  }
};

// A geofence centre; a point pushed purely north by `d` metres lands ~`d` m away (haversine of a
// pure-latitude offset is within a few cm of the flat-earth value at this latitude).
const CENTRE = { latitude: 60.0, longitude: 24.0 };
const northOf = (d: number) => ({ latitude: CENTRE.latitude + d / 111_320, longitude: CENTRE.longitude });
const geo = (radiusMeters: number): ClockGeofence => ({ geofenceVersionId: randomUUID(), latitude: CENTRE.latitude, longitude: CENTRE.longitude, radiusMeters });
const reading = (loc: { latitude: number; longitude: number }, accuracyMeters: number) => ({
  location: { latitude: Number(loc.latitude.toFixed(6)), longitude: Number(loc.longitude.toFixed(6)), accuracyMeters },
  gpsUnavailableReason: null as null
});

// The company policy value is rolled to 250 in these cases (the target). GATE_75 documents that a
// production policy still at 75 keeps 75 — the new logic must not silently ignore it.
const GATE_250 = 250;
const GATE_75 = 75;

function main() {
  check('MAX_AUTO_VERIFY_ACCURACY_METERS is 250', MAX_AUTO_VERIFY_ACCURACY_METERS === 250);

  // 1. Real reported case: distance 550, radius 900, accuracy 128.9 -> VERIFIED_INSIDE, no exception.
  {
    const g = geo(900);
    const r = evaluateGpsReading(reading(northOf(550), 128.9), g, GATE_250);
    check('1: d=550 r=900 acc=128.9 -> VERIFIED_INSIDE', r.gpsVerification === 'VERIFIED_INSIDE', r);
    check('1: no boundaryUncertain, reason null', r.boundaryUncertain === false && r.gpsUnavailableReason === null, r);
    check('1: exceptionDetailForGps returns undefined (nothing to flag)', exceptionDetailForGps(r, g) === undefined);
    // and the geofence version is recorded on a verified reading
    check('1: geofenceVersionId recorded', r.geofenceVersionId === g.geofenceVersionId, r);
  }

  // 2. A genuine out-of-zone: distance 730, radius 650, accuracy 3.2 -> VERIFIED_OUTSIDE (unchanged).
  {
    const g = geo(650);
    const r = evaluateGpsReading(reading(northOf(730), 3.2), g, GATE_250);
    check('2: d=730 r=650 acc=3.2 -> VERIFIED_OUTSIDE', r.gpsVerification === 'VERIFIED_OUTSIDE', r);
    const d = exceptionDetailForGps(r, g) as Record<string, unknown>;
    check('2: OUTSIDE detail shape unchanged (distanceMeters/accuracyMeters/thresholdMeters, no reason)', typeof d.distanceMeters === 'number' && d.accuracyMeters === 3.2 && d.thresholdMeters === 650 && d.reason === undefined && d.boundaryUncertain === undefined, d);
  }

  // 3. Boundary/uncertain: distance 820, radius 900, accuracy 128.9 -> NOT_VERIFIED (circle straddles).
  {
    const g = geo(900);
    const r = evaluateGpsReading(reading(northOf(820), 128.9), g, GATE_250);
    check('3: d=820 r=900 acc=128.9 -> NOT_VERIFIED', r.gpsVerification === 'NOT_VERIFIED', r);
    check('3: reason stays wire-compatible LOW_ACCURACY, boundaryUncertain=true', r.gpsUnavailableReason === 'LOW_ACCURACY' && r.boundaryUncertain === true, r);
    const d = exceptionDetailForGps(r, g) as Record<string, unknown>;
    check('3: detail marks boundaryUncertain + carries distance/radius context', d.boundaryUncertain === true && d.reason === 'LOW_ACCURACY' && typeof d.distanceToSiteMeters === 'number' && d.geofenceRadiusMeters === 900, d);
  }

  // 4. Poor accuracy: distance 100, radius 900, accuracy 251 -> LOW_ACCURACY (not boundary).
  {
    const g = geo(900);
    const r = evaluateGpsReading(reading(northOf(100), 251), g, GATE_250);
    check('4: acc=251 (> 250 ceiling) -> NOT_VERIFIED / LOW_ACCURACY, not boundary', r.gpsVerification === 'NOT_VERIFIED' && r.gpsUnavailableReason === 'LOW_ACCURACY' && r.boundaryUncertain === false, r);
    check('4: geofenceVersionId null for a low-accuracy reading', r.geofenceVersionId === null, r);
  }

  // 5. Exact boundary: distance + accuracy == radius -> VERIFIED_INSIDE (inclusive).
  {
    // distance 0 (point == centre) makes the equality exact and float-safe.
    const g = geo(200);
    const r = evaluateGpsReading(reading(CENTRE, 200), g, GATE_250);
    check('5: d=0 acc=200 r=200 (d+acc == r) -> VERIFIED_INSIDE', r.gpsVerification === 'VERIFIED_INSIDE', r);
  }

  // 6. Clearly outside: distance - accuracy > radius -> VERIFIED_OUTSIDE.
  {
    const g = geo(300);
    const r = evaluateGpsReading(reading(northOf(1000), 50), g, GATE_250);
    check('6: d=1000 acc=50 r=300 -> VERIFIED_OUTSIDE', r.gpsVerification === 'VERIFIED_OUTSIDE', r);
  }

  // 7. Approximate / cached coordinate: it arrives as location:null (see validateApproximateGpsPayload)
  //    so it is never auto-verified even when the point would be geometrically inside.
  {
    const g = geo(900);
    const r = evaluateGpsReading({ location: null, gpsUnavailableReason: 'TIMEOUT' }, g, GATE_250);
    check('7: approximate (location null) -> NOT_VERIFIED, never auto-confirmed', r.gpsVerification === 'NOT_VERIFIED' && r.gpsUnavailableReason === 'TIMEOUT' && r.boundaryUncertain === false, r);
  }

  // 8. No coordinate: existing reasons + review-queue behaviour preserved for every client reason.
  {
    const g = geo(900);
    for (const reason of ['TIMEOUT', 'POSITION_UNAVAILABLE', 'PERMISSION_DENIED'] as const) {
      const r = evaluateGpsReading({ location: null, gpsUnavailableReason: reason }, g, GATE_250);
      check(`8: no coordinate (${reason}) -> NOT_VERIFIED with the same reason`, r.gpsVerification === 'NOT_VERIFIED' && r.gpsUnavailableReason === reason, r);
    }
  }

  // 9. The company policy value is still honoured (never silently ignored): with the gate still at
  //    75, the real reported 128.9 m case is NOT auto-verified — it needs the 75 -> 250 rollout.
  {
    const g = geo(900);
    const r75 = evaluateGpsReading(reading(northOf(550), 128.9), g, GATE_75);
    check('9: gate 75 -> d=550 acc=128.9 stays NOT_VERIFIED / LOW_ACCURACY (policy honoured)', r75.gpsVerification === 'NOT_VERIFIED' && r75.gpsUnavailableReason === 'LOW_ACCURACY' && r75.boundaryUncertain === false, r75);
    // 10. And a policy value ABOVE the ceiling never widens auto-verification past 250 m.
    const rHuge = evaluateGpsReading(reading(northOf(100), 251), g, 5000);
    check('10: gate 5000 -> acc 251 still NOT_VERIFIED (clamped to the 250 ceiling)', rHuge.gpsVerification === 'NOT_VERIFIED' && rHuge.gpsUnavailableReason === 'LOW_ACCURACY', rHuge);
    const rHugeOk = evaluateGpsReading(reading(northOf(100), 240), g, 5000);
    check('10: gate 5000 -> acc 240 (<=250) is evaluated normally -> VERIFIED_INSIDE', rHugeOk.gpsVerification === 'VERIFIED_INSIDE', rHugeOk);
  }

  // 11. No geofence configured -> NOT_VERIFIED regardless of accuracy (unchanged).
  {
    const r = evaluateGpsReading(reading(CENTRE, 10), null, GATE_250);
    check('11: no geofence -> NOT_VERIFIED, reason null, not boundary', r.gpsVerification === 'NOT_VERIFIED' && r.gpsUnavailableReason === null && r.boundaryUncertain === false, r);
  }

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

main();
