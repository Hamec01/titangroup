import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../lib/prisma';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { POST as syncRoute } from '../app/api/worker/attendance/sync/route';
import { GET as contextRoute } from '../app/api/worker/attendance/context/route';
import { POST as periodsRoute } from '../app/api/admin/periods/route';
import { POST as assignmentsRoute } from '../app/api/admin/assignments/route';
import { POST as resolveRoute } from '../app/api/admin/attendance/exceptions/[exceptionId]/resolve/route';

// T7A.10C.2 FOLLOW-UP — closes the one matrix gap left open by the T7A.10C.2 pilot E2E
// (docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md, addendum "T7A.10C.2" §I): a live,
// deterministic PAIR_ORPHAN_EVENTS resolution. Fixture (owner-specified):
//
//   T0 < T1 < T2, one employee, one device, delivered in one offline /sync batch:
//   1. CHECK_OUT at T2 first, while no shift is open -> CHECKOUT_WITHOUT_OPEN_SHIFT (orphan A).
//   2. CHECK_IN at T0 -> opens a real EmployeeOpenShift (event B).
//   3. CHECK_IN at T1, while B's shift is still open -> DOUBLE_CHECK_IN (orphan C).
//   4. Never close the T0 shift before pairing.
//   5. POST .../exceptions/:id/resolve { action: PAIR_ORPHAN_EVENTS, checkInEventId: C,
//      checkOutEventId: A } on the DOUBLE_CHECK_IN exception -- lib/attendance-exception-
//      resolution.ts's pairOrphanEvents() locates CHECKOUT_WITHOUT_OPEN_SHIFT as the
//      complementary exception (via clockEventId===A) and resolves both in one call.
//
// deviceSequence 1/2/3 stay strictly increasing (FIFO satisfied) even though their
// clientCapturedAt values are deliberately out of order -- effectiveAt comes from
// clientCapturedAt (computeOfflineEffectiveTime), not delivery order.
//
// Uses the same direct-route-handler-invocation style as scripts/_test-activation.ts (real
// NextRequest, real cookies/CSRF/idempotency headers, real Prisma) -- exercises the actual
// production code path without needing a running HTTP server.

// ClockEvent.deviceSequence is a Prisma BigInt -- plain JSON.stringify throws on it.
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error('FAIL: ' + message);
  }
  console.log('PASS: ' + message);
}

async function makeSession(username: string, roleNames: string[], employeeId: string | null = null) {
  const user = await prisma.user.create({ data: { username: `${username}-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', employeeId } });
  for (const roleName of roleNames) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  const token = generateSessionToken();
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });
  return { user, token };
}

function req(url: string, token: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${token}`, ...extraHeaders };
  if (body !== undefined) {
    headers['x-requested-with'] = 'titanor-time';
  }
  return new NextRequest(url, { method: body !== undefined ? 'POST' : 'GET', headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

async function main() {
  const { user: admin, token: adminToken } = await makeSession('pilotpair-admin', ['ADMIN']);

  const site = await prisma.workSite.create({ data: { name: `PilotPair Site ${randomUUID().slice(0, 4)}` } });
  const gv = await prisma.workSiteGeofenceVersion.create({ data: { siteId: site.id, versionNumber: 1, latitude: 60.17, longitude: 24.94, radiusMeters: 100, createdByUserId: admin.id } });
  await prisma.workSite.update({ where: { id: site.id }, data: { currentGeofenceVersionId: gv.id } });

  const isoDate = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10);
  const rPeriod = await periodsRoute(req('http://localhost/api/admin/periods', adminToken, { startDate: isoDate, endDate: isoDate }, { 'idempotency-key': randomUUID() }));
  const periodJson: any = await rPeriod.json();
  assert(rPeriod.status === 201, `period create -> 201 (got ${rPeriod.status}: ${JSON.stringify(periodJson)})`);

  const employee = await prisma.employee.create({ data: { employeeNumber: `PP-${randomUUID().slice(0, 8)}`, firstName: 'PilotPair', lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: employee.id, active: true, startDate: new Date('2000-01-01T00:00:00Z') } });
  const rAssign = await assignmentsRoute(req('http://localhost/api/admin/assignments', adminToken, { employeeId: employee.id, siteId: site.id, validFrom: '2000-01-01', isPrimary: true }, { 'idempotency-key': randomUUID() }));
  const assignJson: any = await rAssign.json();
  assert(rAssign.status === 201, `assignment create -> 201 (got ${rAssign.status}: ${JSON.stringify(assignJson)})`);

  const { token: workerToken } = await makeSession('pilotpair-worker', ['WORKER'], employee.id);

  const deviceId = randomUUID();
  const rCtx = await contextRoute(req(`http://localhost/api/worker/attendance/context?deviceInstallationId=${deviceId}&platform=iOS`, workerToken));
  assert(rCtx.status === 200, `device bootstrap -> 200 (got ${rCtx.status})`);

  const dayStart = new Date(`${isoDate}T00:00:00.000Z`);
  const T0 = new Date(dayStart.getTime() + 8 * 3600_000);
  const T1 = new Date(dayStart.getTime() + 9 * 3600_000);
  const T2 = new Date(dayStart.getTime() + 10 * 3600_000);
  const INSIDE = { latitude: 60.17, longitude: 24.94, accuracyMeters: 10 };

  const eventA = randomUUID(); // orphan CHECK_OUT at T2, delivered FIRST (no open shift yet)
  const eventB = randomUUID(); // real CHECK_IN at T0, opens the shift
  const eventC = randomUUID(); // DOUBLE_CHECK_IN at T1, orphan, pairs with A

  const rSync = await syncRoute(req('http://localhost/api/worker/attendance/sync', workerToken, {
    deviceInstallationId: deviceId,
    events: [
      { clientEventId: eventA, deviceSequence: 1, groupId: null, operationType: 'CHECK_OUT', siteId: site.id, assumedSiteId: site.id, workAreaId: null, clientCapturedAt: T2.toISOString(), capturedOffline: true, cachedGeofenceVersionId: null, gps: INSIDE, gpsUnavailableReason: null },
      { clientEventId: eventB, deviceSequence: 2, groupId: null, operationType: 'CHECK_IN', siteId: site.id, assumedSiteId: null, workAreaId: null, clientCapturedAt: T0.toISOString(), capturedOffline: true, cachedGeofenceVersionId: null, gps: INSIDE, gpsUnavailableReason: null },
      { clientEventId: eventC, deviceSequence: 3, groupId: null, operationType: 'CHECK_IN', siteId: site.id, assumedSiteId: null, workAreaId: null, clientCapturedAt: T1.toISOString(), capturedOffline: true, cachedGeofenceVersionId: null, gps: INSIDE, gpsUnavailableReason: null }
    ]
  }));
  const syncJson: any = await rSync.json();
  assert(rSync.status === 200, `sync batch -> 200 (got ${rSync.status}: ${JSON.stringify(syncJson)})`);
  const outcomes = syncJson.results.map((r: any) => r.outcome);
  assert(JSON.stringify(outcomes) === JSON.stringify(['ACCEPTED', 'ACCEPTED', 'ACCEPTED']), `all 3 events ACCEPTED (got ${JSON.stringify(outcomes)})`);

  const excCheckoutOrphan = await prisma.attendanceException.findFirstOrThrow({ where: { employeeId: employee.id, type: 'CHECKOUT_WITHOUT_OPEN_SHIFT', status: 'OPEN' } });
  const excDoubleCheckIn = await prisma.attendanceException.findFirstOrThrow({ where: { employeeId: employee.id, type: 'DOUBLE_CHECK_IN', status: 'OPEN' } });
  assert(excCheckoutOrphan.clockEventId === eventA, 'CHECKOUT_WITHOUT_OPEN_SHIFT points at event A (T2)');
  assert(excDoubleCheckIn.clockEventId === eventC, 'DOUBLE_CHECK_IN points at event C (T1)');

  const openShift = await prisma.employeeOpenShift.findUniqueOrThrow({ where: { employeeId: employee.id } });
  assert(openShift.openedByClockEventId === eventB, 'EmployeeOpenShift anchored to event B (T0)');

  const beforeEventSnapshots = await prisma.clockEvent.findMany({ where: { id: { in: [eventA, eventB, eventC] } }, orderBy: { id: 'asc' } });
  const auditCountBefore = await prisma.auditEvent.count({ where: { eventType: 'ATTENDANCE_EXCEPTION_PAIRED' } });

  const rPair = await resolveRoute(
    req(`http://localhost/api/admin/attendance/exceptions/${excDoubleCheckIn.id}/resolve`, adminToken, {
      action: 'PAIR_ORPHAN_EVENTS',
      checkInEventId: eventC,
      checkOutEventId: eventA,
      resolutionNote: 'Pilot E2E pairing verification'
    }),
    { params: Promise.resolve({ exceptionId: excDoubleCheckIn.id }) }
  );
  const pairJson: any = await rPair.json();
  assert(rPair.status === 201, `PAIR_ORPHAN_EVENTS -> 201 (got ${rPair.status}: ${JSON.stringify(pairJson)})`);

  const newShift = await prisma.clockShift.findUniqueOrThrow({ where: { id: pairJson.clockShift.id } });
  assert(newShift.checkInEventId === eventC, 'new ClockShift.checkInEventId === event C (T1)');
  assert(newShift.checkOutEventId === eventA, 'new ClockShift.checkOutEventId === event A (T2)');
  assert(newShift.recordedStartAt.getTime() === T1.getTime(), 'recordedStartAt === T1');
  assert(newShift.recordedEndAt.getTime() === T2.getTime(), 'recordedEndAt === T2');
  assert(newShift.materializationState === 'PENDING', 'materializationState === PENDING');

  const excDoubleAfter = await prisma.attendanceException.findUniqueOrThrow({ where: { id: excDoubleCheckIn.id } });
  const excOrphanAfter = await prisma.attendanceException.findUniqueOrThrow({ where: { id: excCheckoutOrphan.id } });
  assert(excDoubleAfter.status === 'RESOLVED' && excDoubleAfter.clockShiftId === newShift.id, 'DOUBLE_CHECK_IN -> RESOLVED, points at the new ClockShift');
  assert(excOrphanAfter.status === 'RESOLVED' && excOrphanAfter.clockShiftId === newShift.id, 'CHECKOUT_WITHOUT_OPEN_SHIFT -> RESOLVED, points at the new ClockShift');

  const afterEventSnapshots = await prisma.clockEvent.findMany({ where: { id: { in: [eventA, eventB, eventC] } }, orderBy: { id: 'asc' } });
  assert(stableStringify(beforeEventSnapshots) === stableStringify(afterEventSnapshots), 'original ClockEvent rows byte-identical before/after pairing');

  const openShiftAfter = await prisma.employeeOpenShift.findUniqueOrThrow({ where: { employeeId: employee.id } });
  assert(openShiftAfter.openedByClockEventId === eventB && stableStringify(openShiftAfter) === stableStringify(openShift), 'original EmployeeOpenShift (T0) untouched/not re-bound');

  const auditRows = await prisma.auditEvent.findMany({ where: { eventType: 'ATTENDANCE_EXCEPTION_PAIRED' } });
  assert(auditRows.length === auditCountBefore + 1, `exactly one new AuditEvent(ATTENDANCE_EXCEPTION_PAIRED) (before=${auditCountBefore}, after=${auditRows.length})`);
  const auditRow = auditRows[auditRows.length - 1];
  const auditText = JSON.stringify(auditRow);
  assert(!/gps|latitude|longitude|deviceInstallationId|payloadHash|deviceSequence/i.test(auditText), 'AuditEvent contains no GPS/device/payload/hash fields');

  const responseText = JSON.stringify(pairJson);
  assert(!/gps|latitude|longitude|deviceInstallationId|payloadHash|deviceSequence/i.test(responseText), 'HTTP response contains no GPS/device/payload/hash fields');

  // Replay: same request again -> documented terminal conflict (ALREADY_RESOLVED), no new rows.
  const shiftCountBeforeReplay = await prisma.clockShift.count();
  const auditCountBeforeReplay = await prisma.auditEvent.count({ where: { eventType: 'ATTENDANCE_EXCEPTION_PAIRED' } });
  const rReplay = await resolveRoute(
    req(`http://localhost/api/admin/attendance/exceptions/${excDoubleCheckIn.id}/resolve`, adminToken, {
      action: 'PAIR_ORPHAN_EVENTS',
      checkInEventId: eventC,
      checkOutEventId: eventA,
      resolutionNote: 'Pilot E2E pairing verification'
    }),
    { params: Promise.resolve({ exceptionId: excDoubleCheckIn.id }) }
  );
  const replayJson: any = await rReplay.json();
  assert(rReplay.status === 409 && replayJson.error?.code === 'EXCEPTION_ALREADY_RESOLVED', `replay -> 409 EXCEPTION_ALREADY_RESOLVED (got ${rReplay.status}: ${JSON.stringify(replayJson)})`);
  const shiftCountAfterReplay = await prisma.clockShift.count();
  const auditCountAfterReplay = await prisma.auditEvent.count({ where: { eventType: 'ATTENDANCE_EXCEPTION_PAIRED' } });
  assert(shiftCountAfterReplay === shiftCountBeforeReplay, 'replay created no second ClockShift');
  assert(auditCountAfterReplay === auditCountBeforeReplay, 'replay created no second AuditEvent');

  // Materializer: sourceAssignmentId is null on the paired shift (T1's check-in occurred while
  // already open, so insertAndApplyCheckIn's DOUBLE_CHECK_IN branch never resolves one) --
  // documented domain result PENDING_SOURCE_ASSIGNMENT, not partial state.
  const { materializeClockShiftCore } = await import('../lib/attendance-materializer');
  const matResult = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employee.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ClockShift" WHERE id = ${newShift.id}::uuid FOR UPDATE`;
    return materializeClockShiftCore(tx as any, newShift.id, randomUUID());
  });
  assert((matResult as any).kind === 'PENDING_SOURCE_ASSIGNMENT', `materializer returns the documented PENDING_SOURCE_ASSIGNMENT domain result (got ${JSON.stringify(matResult)})`);
  const fragmentCount = await prisma.clockShiftFragment.count({ where: { clockShiftId: newShift.id } });
  assert(fragmentCount === 0, 'no partial ClockShiftFragment rows created by the blocked materialize attempt');

  console.log('\nAll pilot PAIR_ORPHAN_EVENTS assertions passed.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
