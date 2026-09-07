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

  // 4. validatePolicyPatchInput range — GPS confidence zone (2026-09-07): business range is 10..250
  //    (the DB CHECK stays 10..5000 for compatibility). ТЗ STOP-GATE №1 / case 13.
  {
    const fe = (r: ReturnType<typeof validatePolicyPatchInput>) => (r.ok ? undefined : (r as { fieldErrors: Record<string, string[]> }).fieldErrors.maxGpsAccuracyMeters);
    check('validate accepts 10', validatePolicyPatchInput({ maxGpsAccuracyMeters: 10 }).ok === true);
    check('validate accepts 75', validatePolicyPatchInput({ maxGpsAccuracyMeters: 75 }).ok === true);
    check('validate accepts 150', validatePolicyPatchInput({ maxGpsAccuracyMeters: 150 }).ok === true);
    check('validate accepts 250 (upper bound)', validatePolicyPatchInput({ maxGpsAccuracyMeters: 250 }).ok === true);
    const r251 = validatePolicyPatchInput({ maxGpsAccuracyMeters: 251 });
    check('validate rejects 251 (> 250)', r251.ok === false && !!fe(r251), r251);
    check('validate rejects 251 message mentions 250', /250/.test((fe(r251) ?? []).join(' ')), fe(r251));
    const r5000 = validatePolicyPatchInput({ maxGpsAccuracyMeters: 5000 });
    check('validate rejects 5000', r5000.ok === false && !!fe(r5000), r5000);
    check('validate rejects 9 (< 10)', validatePolicyPatchInput({ maxGpsAccuracyMeters: 9 }).ok === false);
    check('validate rejects a non-integer (100.5)', validatePolicyPatchInput({ maxGpsAccuracyMeters: 100.5 }).ok === false);
    check('validate rejects a string', validatePolicyPatchInput({ maxGpsAccuracyMeters: '250' as unknown as number }).ok === false);
    check('validate rejects null', validatePolicyPatchInput({ maxGpsAccuracyMeters: null as unknown as number }).ok === false);
  }

  // 4a. PATCH route: 400 does NOT change the row and writes NO audit; a valid value does both.
  //     (ТЗ case 13 + case 14 RBAC.)
  {
    const { NextRequest } = await import('next/server');
    const { PATCH: policyPatch } = await import('../app/api/admin/attendance/policy/route');
    const { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } = await import('../lib/session');
    const roleId = async (name: string) => (await prisma.role.findFirstOrThrow({ where: { name } })).id;
    const mkUser = async (tag: string, role: string, employeeId: string | null = null) => {
      const u = await prisma.user.create({ data: { username: `gpst_${tag}_${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', employeeId, userRoles: { create: { roleId: await roleId(role) } } } });
      const tok = generateSessionToken();
      await prisma.userSession.create({ data: { userId: u.id, tokenHash: hashSessionToken(tok), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });
      return { u, tok };
    };
    const patchReq = (tok: string | null, body: unknown) =>
      new NextRequest('http://localhost/api/admin/attendance/policy', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'titanor-time', 'idempotency-key': randomUUID(), ...(tok ? { cookie: `${SESSION_COOKIE_NAME}=${tok}` } : {}) },
        body: JSON.stringify(body)
      });

    const superA = await mkUser('super', 'SUPER_ADMIN');
    const before = await getCompanyAttendancePolicy();
    const auditBefore = await prisma.auditEvent.count({ where: { eventType: 'ATTENDANCE_POLICY_UPDATED' } });

    const bad = await policyPatch(patchReq(superA.tok, { maxGpsAccuracyMeters: 5000 }));
    const badJson = await bad.json();
    check('4a: PATCH 5000 -> 400 VALIDATION_ERROR with fieldErrors.maxGpsAccuracyMeters', bad.status === 400 && badJson.error?.code === 'VALIDATION_ERROR' && Array.isArray(badJson.error?.fieldErrors?.maxGpsAccuracyMeters), badJson);
    check('4a: rejected PATCH did NOT change the policy', (await getCompanyAttendancePolicy()).maxGpsAccuracyMeters === before.maxGpsAccuracyMeters);
    check('4a: rejected PATCH wrote NO audit', (await prisma.auditEvent.count({ where: { eventType: 'ATTENDANCE_POLICY_UPDATED' } })) === auditBefore);

    const ok = await policyPatch(patchReq(superA.tok, { maxGpsAccuracyMeters: 250 }));
    check('4a: SUPER_ADMIN PATCH 250 -> 200', ok.status === 200, await ok.clone().json());
    check('4a: successful PATCH changed the policy to 250', (await getCompanyAttendancePolicy()).maxGpsAccuracyMeters === 250);
    check('4a: successful PATCH wrote exactly one audit', (await prisma.auditEvent.count({ where: { eventType: 'ATTENDANCE_POLICY_UPDATED' } })) === auditBefore + 1);

    // Case 14 — RBAC. WORKER definitely cannot. (ADMIN currently holds attendance.policy.update per
    // migration 20260818020000 — the GPS change does NOT alter the role matrix; see the report.)
    const emp = await prisma.employee.create({ data: { employeeNumber: `GPST-${randomUUID().slice(0, 8)}`, firstName: 'P', lastName: 'W' } });
    const worker = await mkUser('worker', 'WORKER', emp.id);
    const wRes = await policyPatch(patchReq(worker.tok, { maxGpsAccuracyMeters: 100 }));
    check('4a: WORKER PATCH -> 403 FORBIDDEN', wRes.status === 403, await wRes.clone().json());
    const noAuth = await policyPatch(patchReq(null, { maxGpsAccuracyMeters: 100 }));
    check('4a: unauthenticated PATCH -> 401', noAuth.status === 401);
    check('4a: policy still 250 after the forbidden/unauth attempts', (await getCompanyAttendancePolicy()).maxGpsAccuracyMeters === 250);

    // reset for other tests sharing this DB
    await policyPatch(patchReq(superA.tok, { maxGpsAccuracyMeters: 75 }));
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
