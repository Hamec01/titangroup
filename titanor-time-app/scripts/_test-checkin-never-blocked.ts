// T17 (2026-08-29) — a Check In is never blocked by GPS / geofence. A good fix outside the site
// geofence used to be REJECTED terminally (no ClockEvent, clock never started); now it opens the
// shift and files an OUTSIDE_GEOFENCE_CHECKIN review flag, exactly like Check Out already does.
// Direct-route-handler style. Needs a disposable PostgreSQL 16 (DATABASE_URL) with migrations
// through 20260829210000 applied and a CompanyAttendancePolicy singleton.
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../lib/prisma';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { POST as syncRoute } from '../app/api/worker/attendance/sync/route';
import { GET as contextRoute } from '../app/api/worker/attendance/context/route';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL:', n, x ?? '');
  }
};

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
function req(url: string, token: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${token}` };
  if (body !== undefined) headers['x-requested-with'] = 'titanor-time';
  return new NextRequest(url, { method: body !== undefined ? 'POST' : 'GET', headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

const SITE = { latitude: 60.4436, longitude: 22.2079 };
const FAR = { latitude: 60.17, longitude: 24.94, accuracyMeters: 12 }; // ~200 km away — clearly VERIFIED_OUTSIDE
const NEAR = { latitude: 60.4438, longitude: 22.208, accuracyMeters: 12 };

async function main() {
  const { user: admin } = await makeSession('t17-admin', ['ADMIN']);
  const site = await prisma.workSite.create({ data: { name: `T17 ${randomUUID().slice(0, 5)}` } });
  const gv = await prisma.workSiteGeofenceVersion.create({ data: { siteId: site.id, versionNumber: 1, latitude: SITE.latitude, longitude: SITE.longitude, radiusMeters: 300, createdByUserId: admin.id } });
  await prisma.workSite.update({ where: { id: site.id }, data: { currentGeofenceVersionId: gv.id } });
  const site2 = await prisma.workSite.create({ data: { name: `T17b ${randomUUID().slice(0, 5)}` } });
  const gv2 = await prisma.workSiteGeofenceVersion.create({ data: { siteId: site2.id, versionNumber: 1, latitude: SITE.latitude, longitude: SITE.longitude, radiusMeters: 300, createdByUserId: admin.id } });
  await prisma.workSite.update({ where: { id: site2.id }, data: { currentGeofenceVersionId: gv2.id } });

  const day = new Date(Date.now() - 2 * 86400_000);
  const dateOnly = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  await prisma.payrollPeriod.create({ data: { startDate: dateOnly, endDate: dateOnly, status: 'OPEN', openedByUserId: admin.id } });

  const employee = await prisma.employee.create({ data: { employeeNumber: `T17-${randomUUID().slice(0, 8)}`, firstName: 'Out', lastName: 'Side' } });
  await prisma.employment.create({ data: { employeeId: employee.id, active: true, startDate: new Date('2000-01-01T00:00:00Z') } });
  await prisma.siteAssignment.create({ data: { employeeId: employee.id, siteId: site.id, isPrimary: true, validFrom: new Date('2000-01-01T00:00:00Z'), validTo: null, assignedByUserId: admin.id } });
  await prisma.siteAssignment.create({ data: { employeeId: employee.id, siteId: site2.id, isPrimary: false, validFrom: new Date('2000-01-01T00:00:00Z'), validTo: null, assignedByUserId: admin.id } });
  const { token } = await makeSession('t17-worker', ['WORKER'], employee.id);

  const T = (h: number) => new Date(dateOnly.getTime() + h * 3600_000).toISOString();
  const device = randomUUID();
  await contextRoute(req(`http://localhost/api/worker/attendance/context?deviceInstallationId=${device}&platform=iOS`, token));

  // 1. offline CHECK_IN with a good fix that is OUTSIDE the geofence
  const evIn = randomUUID();
  const r1 = await syncRoute(req('http://localhost/api/worker/attendance/sync', token, {
    deviceInstallationId: device,
    events: [{ clientEventId: evIn, deviceSequence: 1, groupId: null, operationType: 'CHECK_IN', siteId: site.id, assumedSiteId: null, workAreaId: null, clientCapturedAt: T(8), capturedOffline: true, cachedGeofenceVersionId: null, gps: FAR, gpsUnavailableReason: null }]
  }));
  const j1 = await r1.json();
  check('1: outside-geofence CHECK_IN -> 200 ACCEPTED (not REJECTED)', r1.status === 200 && j1.results?.[0]?.outcome === 'ACCEPTED', j1);

  const ev1 = await prisma.clockEvent.findUniqueOrThrow({ where: { id: evIn }, select: { gpsVerification: true, processingState: true } });
  check('1: ClockEvent exists, gpsVerification VERIFIED_OUTSIDE, processingState ACCEPTED', ev1.gpsVerification === 'VERIFIED_OUTSIDE' && ev1.processingState === 'ACCEPTED', ev1);
  check('1: the shift is now OPEN (clock started)', !!(await prisma.employeeOpenShift.findUnique({ where: { employeeId: employee.id } })));

  const exc1 = await prisma.attendanceException.findFirstOrThrow({ where: { clockEventId: evIn, type: 'OUTSIDE_GEOFENCE_CHECKIN' } });
  check('1: OUTSIDE_GEOFENCE_CHECKIN exception OPEN with a distance detail', exc1.status === 'OPEN' && typeof (exc1.detail as Record<string, unknown>)?.distanceMeters === 'number', exc1.detail);
  check('1: NO REJECTED receipt for this event', (await prisma.deviceEventReceipt.count({ where: { clientEventId: evIn, outcome: 'REJECTED_TERMINAL' } })) === 0);
  check('1: ACCEPTED receipt written', (await prisma.deviceEventReceipt.count({ where: { clientEventId: evIn, outcome: 'ACCEPTED' } })) === 1);

  // 2. CHECK_OUT (also outside) -> shift closes, hours materialize (not blocked by the checkin flag)
  const evOut = randomUUID();
  const r2 = await syncRoute(req('http://localhost/api/worker/attendance/sync', token, {
    deviceInstallationId: device,
    events: [{ clientEventId: evOut, deviceSequence: 2, groupId: null, operationType: 'CHECK_OUT', siteId: site.id, assumedSiteId: site.id, workAreaId: null, clientCapturedAt: T(16), capturedOffline: true, cachedGeofenceVersionId: null, gps: FAR, gpsUnavailableReason: null }]
  }));
  check('2: CHECK_OUT -> 200 ACCEPTED', (await r2.json()).results?.[0]?.outcome === 'ACCEPTED');
  const shift = await prisma.clockShift.findFirstOrThrow({ where: { checkOutEventId: evOut } });
  check('2: a ClockShift was created (~8h)', Math.round((shift.recordedEndAt.getTime() - shift.recordedStartAt.getTime()) / 3600_000) === 8, shift);
  check('2: the geofence flags do NOT block the shift (no OVERLAPPING_SHIFT, materialization not stuck on them)',
    (await prisma.attendanceException.count({ where: { clockShiftId: shift.id, type: 'OVERLAPPING_SHIFT', status: 'OPEN' } })) === 0 && shift.materializationState !== 'FAILED', shift.materializationState);

  // 3. Switch Site where the NEW site's check-in half is outside its geofence -> still accepted
  await prisma.employeeOpenShift.deleteMany({ where: { employeeId: employee.id } });
  // open a clean shift at site (inside)
  const device2 = randomUUID();
  await contextRoute(req(`http://localhost/api/worker/attendance/context?deviceInstallationId=${device2}&platform=iOS`, token));
  const evIn2 = randomUUID();
  await syncRoute(req('http://localhost/api/worker/attendance/sync', token, {
    deviceInstallationId: device2,
    events: [{ clientEventId: evIn2, deviceSequence: 1, groupId: null, operationType: 'CHECK_IN', siteId: site.id, assumedSiteId: null, workAreaId: null, clientCapturedAt: T(9), capturedOffline: true, cachedGeofenceVersionId: null, gps: NEAR, gpsUnavailableReason: null }]
  }));
  const grp = randomUUID();
  const swOut = randomUUID();
  const swIn = randomUUID();
  const r3 = await syncRoute(req('http://localhost/api/worker/attendance/sync', token, {
    deviceInstallationId: device2,
    events: [
      { clientEventId: swOut, deviceSequence: 2, groupId: grp, operationType: 'CHECK_OUT', siteId: site.id, assumedSiteId: site.id, workAreaId: null, clientCapturedAt: T(10), capturedOffline: true, cachedGeofenceVersionId: null, gps: NEAR, gpsUnavailableReason: null },
      { clientEventId: swIn, deviceSequence: 3, groupId: grp, operationType: 'CHECK_IN', siteId: site2.id, assumedSiteId: null, workAreaId: null, clientCapturedAt: T(10), capturedOffline: true, cachedGeofenceVersionId: null, gps: FAR, gpsUnavailableReason: null }
    ]
  }));
  const j3 = await r3.json();
  check('3: switch-site with an outside new-site check-in -> both halves ACCEPTED', j3.results?.every((r: { outcome: string }) => r.outcome === 'ACCEPTED'), j3.results);
  check('3: worker is now clocked in at the new site', (await prisma.employeeOpenShift.findUniqueOrThrow({ where: { employeeId: employee.id } })).siteId === site2.id);
  check('3: OUTSIDE_GEOFENCE_CHECKIN flag on the switch-in event', (await prisma.attendanceException.count({ where: { clockEventId: swIn, type: 'OUTSIDE_GEOFENCE_CHECKIN' } })) === 1);

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
