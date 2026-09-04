// T14.4 (2026-08-29) — offline /sync accepts an APPROXIMATE coordinate (gps null + gpsApproximate)
// and stores it as an approximate ClockEventLocation (never verified).
//
// R15 fixroad F03 (owner, 2026-09-04) — the per-site `gpsOftenUnavailable` flag is now
// INFORMATIONAL ONLY: a plain no-coordinate GPS_NOT_VERIFIED at a flagged site stays OPEN and joins
// the review queue like any other, and NO auto ACKNOWLEDGE_AS_VALID audit is written. (Step 3 below
// asserts the new behaviour.)
//
// Direct-route-handler style (real NextRequest / cookies / CSRF), same as _test-pilot-pair-orphan.ts.
// Needs a disposable PostgreSQL 16 with all migrations applied (DATABASE_URL).
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../lib/prisma';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { POST as syncRoute } from '../app/api/worker/attendance/sync/route';
import { GET as contextRoute } from '../app/api/worker/attendance/context/route';
import { validateApproximateGpsPayload } from '../lib/attendance-clock';

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

function req(url: string, token: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${token}`, ...extraHeaders };
  if (body !== undefined) headers['x-requested-with'] = 'titanor-time';
  return new NextRequest(url, { method: body !== undefined ? 'POST' : 'GET', headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

// A shipyard-ish site centre; the approximate point sits ~2 km away — far enough that, IF it were
// ever run through the geofence (it must not be), it would read VERIFIED_OUTSIDE.
const SITE = { latitude: 60.4436, longitude: 22.2079 };
const APPROX_POINT = { latitude: 60.463, longitude: 22.235, accuracyMeters: 45 };

async function syncOneCheckIn(opts: {
  workerToken: string;
  deviceId: string;
  siteId: string;
  seq: number;
  capturedAt: string;
  gps: unknown;
  gpsUnavailableReason: string | null;
  gpsApproximate?: unknown;
}) {
  const clientEventId = randomUUID();
  const body: Record<string, unknown> = {
    clientEventId,
    deviceSequence: opts.seq,
    groupId: null,
    operationType: 'CHECK_IN',
    siteId: opts.siteId,
    assumedSiteId: null,
    workAreaId: null,
    clientCapturedAt: opts.capturedAt,
    capturedOffline: true,
    cachedGeofenceVersionId: null,
    gps: opts.gps,
    gpsUnavailableReason: opts.gpsUnavailableReason
  };
  if (opts.gpsApproximate !== undefined) body.gpsApproximate = opts.gpsApproximate;
  const res = await syncRoute(req('http://localhost/api/worker/attendance/sync', opts.workerToken, { deviceInstallationId: opts.deviceId, events: [body] }));
  const json = await res.json();
  return { status: res.status, json, clientEventId };
}

async function main() {
  // ---- pure validator ----
  check('validateApproximateGpsPayload(null) -> ok null', (() => {
    const r = validateApproximateGpsPayload(null, 'g');
    return r.ok && r.value === null;
  })());
  check('validateApproximateGpsPayload rejects both ages set', !validateApproximateGpsPayload({ latitude: 60.1, longitude: 22.1, accuracyMeters: 30, fixAgeSeconds: 10, capturedAfterEventSeconds: 10 }, 'g').ok);
  check('validateApproximateGpsPayload rejects a negative age', !validateApproximateGpsPayload({ latitude: 60.1, longitude: 22.1, accuracyMeters: 30, fixAgeSeconds: -1 }, 'g').ok);
  check('validateApproximateGpsPayload rejects out-of-range latitude', !validateApproximateGpsPayload({ latitude: 900, longitude: 22.1, accuracyMeters: 30 }, 'g').ok);
  check('validateApproximateGpsPayload accepts a good fixAge-only reading', (() => {
    const r = validateApproximateGpsPayload({ latitude: 60.463, longitude: 22.235, accuracyMeters: 45, fixAgeSeconds: 480 }, 'g');
    return r.ok && r.value !== null && r.value.fixAgeSeconds === 480 && r.value.capturedAfterEventSeconds === null;
  })());

  // ---- fixture ----
  const { user: admin } = await makeSession('gpsapprox-admin', ['ADMIN']);
  const site = await prisma.workSite.create({ data: { name: `GpsApprox ${randomUUID().slice(0, 4)}` } });
  const gv = await prisma.workSiteGeofenceVersion.create({ data: { siteId: site.id, versionNumber: 1, latitude: SITE.latitude, longitude: SITE.longitude, radiusMeters: 300, createdByUserId: admin.id } });
  await prisma.workSite.update({ where: { id: site.id }, data: { currentGeofenceVersionId: gv.id } });

  const day = new Date(Date.now() - 2 * 86400_000);
  const dateOnly = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  await prisma.payrollPeriod.create({ data: { startDate: dateOnly, endDate: dateOnly, status: 'OPEN', openedByUserId: admin.id } });

  const employee = await prisma.employee.create({ data: { employeeNumber: `GA-${randomUUID().slice(0, 8)}`, firstName: 'Gps', lastName: 'Approx' } });
  await prisma.employment.create({ data: { employeeId: employee.id, active: true, startDate: new Date('2000-01-01T00:00:00Z') } });
  await prisma.siteAssignment.create({ data: { employeeId: employee.id, siteId: site.id, isPrimary: true, validFrom: new Date('2000-01-01T00:00:00Z'), validTo: null, assignedByUserId: admin.id } });
  const { token: workerToken } = await makeSession('gpsapprox-worker', ['WORKER'], employee.id);

  const T = (h: number) => new Date(dateOnly.getTime() + h * 3600_000).toISOString();

  // ---- 1. an offline CHECK_IN with only an approximate point (no fresh fix) ----
  const deviceA = randomUUID();
  await contextRoute(req(`http://localhost/api/worker/attendance/context?deviceInstallationId=${deviceA}&platform=iOS`, workerToken));
  const r1 = await syncOneCheckIn({
    workerToken,
    deviceId: deviceA,
    siteId: site.id,
    seq: 1,
    capturedAt: T(8),
    gps: null,
    gpsUnavailableReason: 'TIMEOUT',
    gpsApproximate: { ...APPROX_POINT, fixAgeSeconds: 480, capturedAfterEventSeconds: null }
  });
  check('1: approximate-only CHECK_IN -> 200 ACCEPTED', r1.status === 200 && r1.json.results?.[0]?.outcome === 'ACCEPTED', r1.json);

  const ev1 = await prisma.clockEvent.findUniqueOrThrow({ where: { id: r1.clientEventId }, select: { gpsVerification: true, gpsUnavailableReason: true, gpsAccuracyMeters: true } });
  check('1: ClockEvent is NOT_VERIFIED (approximate point never verified)', ev1.gpsVerification === 'NOT_VERIFIED', ev1);
  check('1: ClockEvent.gpsUnavailableReason = TIMEOUT', ev1.gpsUnavailableReason === 'TIMEOUT', ev1);
  check('1: ClockEvent.gpsAccuracyMeters is null (no fresh fix)', ev1.gpsAccuracyMeters === null, ev1);

  const loc1 = await prisma.clockEventLocation.findUnique({ where: { clockEventId: r1.clientEventId } });
  check('1: an approximate ClockEventLocation was stored', !!loc1 && loc1.isApproximate === true && loc1.fixAgeSeconds === 480 && loc1.capturedAfterEventSeconds === null, loc1);
  check('1: stored coordinate matches the approximate point', !!loc1 && Number(loc1.latitude) === APPROX_POINT.latitude && Number(loc1.longitude) === APPROX_POINT.longitude, loc1);

  const exc1 = await prisma.attendanceException.findFirstOrThrow({ where: { clockEventId: r1.clientEventId, type: 'GPS_NOT_VERIFIED' } });
  check('1: GPS_NOT_VERIFIED exception is OPEN (site not flagged)', exc1.status === 'OPEN', exc1);

  // ---- 2. a plain no-coordinate CHECK_IN at the same, still-unflagged site -> OPEN ----
  await prisma.employeeOpenShift.deleteMany({ where: { employeeId: employee.id } });
  const deviceB = randomUUID();
  await contextRoute(req(`http://localhost/api/worker/attendance/context?deviceInstallationId=${deviceB}&platform=iOS`, workerToken));
  const r2 = await syncOneCheckIn({ workerToken, deviceId: deviceB, siteId: site.id, seq: 1, capturedAt: T(9), gps: null, gpsUnavailableReason: 'POSITION_UNAVAILABLE' });
  check('2: no-coordinate CHECK_IN -> 200 ACCEPTED', r2.status === 200 && r2.json.results?.[0]?.outcome === 'ACCEPTED', r2.json);
  const exc2 = await prisma.attendanceException.findFirstOrThrow({ where: { clockEventId: r2.clientEventId, type: 'GPS_NOT_VERIFIED' } });
  check('2: exception OPEN before the site is flagged', exc2.status === 'OPEN', exc2);
  check('2: no ClockEventLocation (no coordinate at all)', (await prisma.clockEventLocation.findUnique({ where: { clockEventId: r2.clientEventId } })) === null);

  // ---- 3. flag the site -> a plain no-coordinate GPS_NOT_VERIFIED still opens (F03: informational only) ----
  await prisma.workSite.update({ where: { id: site.id }, data: { gpsOftenUnavailable: true } });
  await prisma.employeeOpenShift.deleteMany({ where: { employeeId: employee.id } });
  const auditBefore = await prisma.auditEvent.count({ where: { eventType: 'ATTENDANCE_EXCEPTION_ACKNOWLEDGED_AS_VALID' } });
  const deviceC = randomUUID();
  await contextRoute(req(`http://localhost/api/worker/attendance/context?deviceInstallationId=${deviceC}&platform=iOS`, workerToken));
  const r3 = await syncOneCheckIn({ workerToken, deviceId: deviceC, siteId: site.id, seq: 1, capturedAt: T(10), gps: null, gpsUnavailableReason: 'TIMEOUT' });
  check('3: no-coordinate CHECK_IN at a flagged site -> 200 ACCEPTED', r3.status === 200 && r3.json.results?.[0]?.outcome === 'ACCEPTED', r3.json);
  const exc3 = await prisma.attendanceException.findFirstOrThrow({ where: { clockEventId: r3.clientEventId, type: 'GPS_NOT_VERIFIED' } });
  check('3: F03 — exception stays OPEN despite the flag (flag is informational, does not auto-resolve)', exc3.status === 'OPEN', exc3);
  check('3: F03 — no auto resolver / note / resolvedAt on the exception', exc3.resolvedByUserId === null && exc3.resolutionNote === null && exc3.resolvedAt === null, exc3);
  const auditAfter = await prisma.auditEvent.count({ where: { eventType: 'ATTENDANCE_EXCEPTION_ACKNOWLEDGED_AS_VALID' } });
  check('3: F03 — NO ATTENDANCE_EXCEPTION_ACKNOWLEDGED_AS_VALID audit was written', auditAfter === auditBefore, { auditBefore, auditAfter });
  // and the site now carries the flag for the informational admin/worker notes
  check('3: flagged site reports gpsOftenUnavailable=true', (await prisma.workSite.findUniqueOrThrow({ where: { id: site.id }, select: { gpsOftenUnavailable: true } })).gpsOftenUnavailable === true);

  // ---- 4. a LOW_ACCURACY reading (has a coordinate) at the flagged site also stays OPEN ----
  await prisma.employeeOpenShift.deleteMany({ where: { employeeId: employee.id } });
  const deviceD = randomUUID();
  await contextRoute(req(`http://localhost/api/worker/attendance/context?deviceInstallationId=${deviceD}&platform=iOS`, workerToken));
  const r4 = await syncOneCheckIn({
    workerToken,
    deviceId: deviceD,
    siteId: site.id,
    seq: 1,
    capturedAt: T(11),
    gps: { latitude: SITE.latitude, longitude: SITE.longitude, accuracyMeters: 4000 },
    gpsUnavailableReason: null
  });
  check('4: low-accuracy CHECK_IN at a flagged site -> 200 ACCEPTED', r4.status === 200 && r4.json.results?.[0]?.outcome === 'ACCEPTED', r4.json);
  const exc4 = await prisma.attendanceException.findFirstOrThrow({ where: { clockEventId: r4.clientEventId, type: 'GPS_NOT_VERIFIED' } });
  check('4: LOW_ACCURACY exception stays OPEN (it has a coordinate)', exc4.status === 'OPEN', exc4);

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
