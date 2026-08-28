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
    check('no threshold arg -> historic 75 m behaviour (NOT_VERIFIED)', defaulted.gpsVerification === 'NOT_VERIFIED', defaulted);
  }

  // 2. the singleton row exists with the default, and loadMaxGpsAccuracyMeters reads it
  {
    const policy = await prisma.companyAttendancePolicy.findFirst({ select: { maxGpsAccuracyMeters: true } });
    check('CompanyAttendancePolicy.maxGpsAccuracyMeters defaults to 75', policy?.maxGpsAccuracyMeters === 75, policy);
    const loaded = await prisma.$transaction((tx) => loadMaxGpsAccuracyMeters(tx));
    check('loadMaxGpsAccuracyMeters -> 75', loaded === 75, loaded);
  }

  // 3. getCompanyAttendancePolicy surfaces the field
  {
    const view = await getCompanyAttendancePolicy();
    check('getCompanyAttendancePolicy view has maxGpsAccuracyMeters = 75', view.maxGpsAccuracyMeters === 75, view);
  }

  // 4. validatePolicyPatchInput range
  {
    check('validate accepts 150', validatePolicyPatchInput({ maxGpsAccuracyMeters: 150 }).ok === true);
    const low = validatePolicyPatchInput({ maxGpsAccuracyMeters: 5 });
    check('validate rejects 5 (< 10)', low.ok === false && !!(low as { fieldErrors: Record<string, string[]> }).fieldErrors.maxGpsAccuracyMeters, low);
    const high = validatePolicyPatchInput({ maxGpsAccuracyMeters: 6000 });
    check('validate rejects 6000 (> 5000)', high.ok === false, high);
    check('validate rejects a non-integer', validatePolicyPatchInput({ maxGpsAccuracyMeters: 100.5 }).ok === false);
  }

  // 5. update round-trips + audits + a later load sees the new value
  {
    const admin = await prisma.user.create({ data: { username: `gpst_${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: (await prisma.role.findFirstOrThrow({ where: { name: 'SUPER_ADMIN' } })).id } } } });
    const updated = await updateCompanyAttendancePolicy(admin.id, randomUUID(), { maxGpsAccuracyMeters: 200 });
    check('update returns maxGpsAccuracyMeters = 200', updated.maxGpsAccuracyMeters === 200, updated);
    const loadedAfter = await prisma.$transaction((tx) => loadMaxGpsAccuracyMeters(tx));
    check('loadMaxGpsAccuracyMeters after update -> 200', loadedAfter === 200, loadedAfter);
    const audit = await prisma.auditEvent.findFirst({ where: { eventType: 'ATTENDANCE_POLICY_UPDATED' }, orderBy: { createdAt: 'desc' }, select: { afterValue: true, beforeValue: true } });
    check('audit before/after carry maxGpsAccuracyMeters', (audit?.afterValue as Record<string, unknown>)?.maxGpsAccuracyMeters === 200 && (audit?.beforeValue as Record<string, unknown>)?.maxGpsAccuracyMeters === 75, audit);
    // now a poor reading passes with the relaxed gate
    const relaxedNow = evaluateGpsReading({ location: { ...near, accuracyMeters: 180 }, gpsUnavailableReason: null }, geo, loadedAfter);
    check('accuracy 180 m now verified with the 200 m gate', relaxedNow.gpsVerification === 'VERIFIED_INSIDE', relaxedNow);
    // reset for other tests sharing this DB
    await updateCompanyAttendancePolicy(admin.id, randomUUID(), { maxGpsAccuracyMeters: 75 });
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
