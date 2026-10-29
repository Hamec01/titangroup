// GPS step 4 (2026-08-28) — the geofence-verification accuracy gate is now
// CompanyAttendancePolicy.maxGpsAccuracyMeters (was a hard-coded 75). evaluateGpsReading() takes
// it as a parameter; the online + offline clock paths load it via loadMaxGpsAccuracyMeters().
// Needs a disposable PostgreSQL 16 with all migrations (DATABASE_URL).
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { evaluateGpsReading, loadMaxGpsAccuracyMeters, type ClockGeofence } from '../lib/attendance-clock';
import { getCompanyAttendancePolicy, validatePolicyPatchInput, updateCompanyAttendancePolicy } from '../lib/attendance-policy';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL:', n, x ?? '');
  }
};

const geo: ClockGeofence = { geofenceVersionId: randomUUID(), latitude: 60.4436, longitude: 22.2079, radiusMeters: 650 };
const near = { latitude: 60.4444, longitude: 22.2088, accuracyMeters: 100 }; // ~110 m from centre, accuracy 100 m

async function main() {
  // 1. evaluateGpsReading honours the threshold parameter
  {
    const strict = evaluateGpsReading({ location: near, gpsUnavailableReason: null }, geo, 75);
    check('accuracy 100 m with gate 75 -> NOT_VERIFIED / LOW_ACCURACY', strict.gpsVerification === 'NOT_VERIFIED' && strict.gpsUnavailableReason === 'LOW_ACCURACY', strict);
    const relaxed = evaluateGpsReading({ location: near, gpsUnavailableReason: null }, geo, 150);
    check('accuracy 100 m with gate 150 -> verified (inside)', relaxed.gpsVerification === 'VERIFIED_INSIDE', relaxed);
    const defaulted = evaluateGpsReading({ location: near, gpsUnavailableReason: null }, geo);
    check('no threshold arg -> 500 m fallback verifies a 100 m fix', defaulted.gpsVerification === 'VERIFIED_INSIDE', defaulted);

    const centerInsideBoundary = {
      latitude: geo.latitude + (geo.radiusMeters - 50) / 111_320,
      longitude: geo.longitude,
      accuracyMeters: 100
    };
    const centerInside = evaluateGpsReading({ location: centerInsideBoundary, gpsUnavailableReason: null }, geo, 150);
    check(
      'center inside the geofence is verified even when the accuracy circle crosses its boundary',
      centerInside.gpsVerification === 'VERIFIED_INSIDE'
        && centerInside.distanceMeters !== null
        && centerInside.distanceMeters < geo.radiusMeters
        && centerInside.distanceMeters + centerInsideBoundary.accuracyMeters > geo.radiusMeters,
      centerInside
    );

    const centerOutsideBoundary = {
      latitude: geo.latitude + (geo.radiusMeters + 50) / 111_320,
      longitude: geo.longitude,
      accuracyMeters: 100
    };
    const centerOutside = evaluateGpsReading({ location: centerOutsideBoundary, gpsUnavailableReason: null }, geo, 150);
    check(
      'center outside the geofence remains outside when the accuracy circle overlaps its boundary',
      centerOutside.gpsVerification === 'VERIFIED_OUTSIDE'
        && centerOutside.distanceMeters !== null
        && centerOutside.distanceMeters > geo.radiusMeters
        && centerOutside.distanceMeters - centerOutsideBoundary.accuracyMeters < geo.radiusMeters,
      centerOutside
    );
  }

  // 2. an unset singleton override uses the 500 m fallback
  {
    const policy = await prisma.companyAttendancePolicy.findUniqueOrThrow({ where: { singleton: true }, select: { maxGpsAccuracyMeters: true } });
    const initialMaxGpsAccuracyMeters = policy.maxGpsAccuracyMeters;
    check('CompanyAttendancePolicy.maxGpsAccuracyMeters is unset by default', initialMaxGpsAccuracyMeters === null, policy);
    const loaded = await prisma.$transaction((tx) => loadMaxGpsAccuracyMeters(tx));
    check('loadMaxGpsAccuracyMeters -> 500 fallback', loaded === 500, loaded);

    // 3. the policy view returns the effective value, not the nullable storage override
    const view = await getCompanyAttendancePolicy();
    check('getCompanyAttendancePolicy view has maxGpsAccuracyMeters = 500', view.maxGpsAccuracyMeters === 500, view);

    // 4. a configured company value takes priority over the fallback
    check('validate accepts 150', validatePolicyPatchInput({ maxGpsAccuracyMeters: 150 }).ok === true);
    const low = validatePolicyPatchInput({ maxGpsAccuracyMeters: 5 });
    check('validate rejects 5 (< 10)', low.ok === false && !!(low as { fieldErrors: Record<string, string[]> }).fieldErrors.maxGpsAccuracyMeters, low);
    const high = validatePolicyPatchInput({ maxGpsAccuracyMeters: 6000 });
    check('validate rejects 6000 (> 5000)', high.ok === false, high);
    check('validate rejects a non-integer', validatePolicyPatchInput({ maxGpsAccuracyMeters: 100.5 }).ok === false);

    // 5. update round-trips + audits + a later load sees the configured value
    const admin = await prisma.user.create({ data: { username: `gpst_${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: (await prisma.role.findFirstOrThrow({ where: { name: 'SUPER_ADMIN' } })).id } } } });
    const updated = await updateCompanyAttendancePolicy(admin.id, randomUUID(), { maxGpsAccuracyMeters: 200 });
    check('update returns configured maxGpsAccuracyMeters = 200', updated.maxGpsAccuracyMeters === 200, updated);
    const loadedAfter = await prisma.$transaction((tx) => loadMaxGpsAccuracyMeters(tx));
    check('loadMaxGpsAccuracyMeters prefers configured 200 over 500 fallback', loadedAfter === 200, loadedAfter);
    const audit = await prisma.auditEvent.findFirst({ where: { eventType: 'ATTENDANCE_POLICY_UPDATED' }, orderBy: { createdAt: 'desc' }, select: { afterValue: true, beforeValue: true } });
    check('audit before/after carry nullable and configured values', (audit?.afterValue as Record<string, unknown>)?.maxGpsAccuracyMeters === 200 && (audit?.beforeValue as Record<string, unknown>)?.maxGpsAccuracyMeters === null, audit);
    const relaxedNow = evaluateGpsReading({ location: { ...near, accuracyMeters: 180 }, gpsUnavailableReason: null }, geo, loadedAfter);
    check('accuracy 180 m verifies with the configured 200 m gate', relaxedNow.gpsVerification === 'VERIFIED_INSIDE', relaxedNow);
    await prisma.companyAttendancePolicy.update({ where: { singleton: true }, data: { maxGpsAccuracyMeters: initialMaxGpsAccuracyMeters } });
  }

  // 6. DB CHECK constraint
  {
    let threw = false;
    try {
      await prisma.$executeRawUnsafe(`UPDATE "CompanyAttendancePolicy" SET "maxGpsAccuracyMeters" = 4 WHERE singleton = true`);
    } catch {
      threw = true;
    }
    check('DB CHECK rejects maxGpsAccuracyMeters below 10', threw);
  }

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
