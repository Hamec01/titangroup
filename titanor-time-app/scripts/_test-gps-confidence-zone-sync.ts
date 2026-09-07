// GPS confidence zone (2026-09-07) — docs/titanor-time/GPS_CONFIDENCE_ZONE_250_RU.md.
// End-to-end: the confidence-zone classification is IDENTICAL for the online clock path
// (performCheckIn via the real route handler) and the offline /sync path, and an idempotent
// re-sync of the same event creates no duplicate ClockEvent / AttendanceException.
// Direct-route-handler style. Needs a disposable PostgreSQL 16 (DATABASE_URL) with all migrations
// and a CompanyAttendancePolicy singleton.
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../lib/prisma';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { updateCompanyAttendancePolicy } from '../lib/attendance-policy';
import { POST as checkInRoute } from '../app/api/worker/attendance/check-in/route';
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

function req(url: string, token: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${token}`, ...extraHeaders };
  if (body !== undefined) headers['x-requested-with'] = 'titanor-time';
  return new NextRequest(url, { method: body !== undefined ? 'POST' : 'GET', headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

const CENTRE = { latitude: 60.0, longitude: 24.0 };
const RADIUS = 900;
const northOf = (d: number) => ({ latitude: Number((CENTRE.latitude + d / 111_320).toFixed(6)), longitude: CENTRE.longitude });

// The three confidence cases against a 900 m geofence, all at accuracy 130 (> the old 75 gate,
// <= the 250 ceiling — exactly the band the redesign is about).
const CASES = [
  { tag: 'INSIDE', point: northOf(550), acc: 130, expectVerification: 'VERIFIED_INSIDE', expectReason: null as string | null, expectException: null as string | null, expectBoundary: false },
  { tag: 'NEAR_BOUNDARY', point: northOf(820), acc: 130, expectVerification: 'NOT_VERIFIED', expectReason: 'LOW_ACCURACY', expectException: 'GPS_NOT_VERIFIED', expectBoundary: true },
  { tag: 'OUTSIDE', point: northOf(1300), acc: 12, expectVerification: 'VERIFIED_OUTSIDE', expectReason: null, expectException: 'OUTSIDE_GEOFENCE_CHECKIN', expectBoundary: false }
] as const;

async function main() {
  const { user: admin } = await makeSession('gcz-admin', ['SUPER_ADMIN']);

  // Roll the company policy gate to the target 250 (the mandatory cases assume the rollout is done).
  await updateCompanyAttendancePolicy(admin.id, randomUUID(), { maxGpsAccuracyMeters: 250 });

  const site = await prisma.workSite.create({ data: { name: `GCZ ${randomUUID().slice(0, 5)}` } });
  const gv = await prisma.workSiteGeofenceVersion.create({ data: { siteId: site.id, versionNumber: 1, latitude: CENTRE.latitude, longitude: CENTRE.longitude, radiusMeters: RADIUS, createdByUserId: admin.id } });
  await prisma.workSite.update({ where: { id: site.id }, data: { currentGeofenceVersionId: gv.id } });

  const day = new Date(Date.now() - 2 * 86400_000);
  const dateOnly = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  await prisma.payrollPeriod.create({ data: { startDate: dateOnly, endDate: dateOnly, status: 'OPEN', openedByUserId: admin.id } });
  const T = (h: number) => new Date(dateOnly.getTime() + h * 3600_000).toISOString();

  async function makeWorker(tag: string) {
    const employee = await prisma.employee.create({ data: { employeeNumber: `GCZ-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'W' } });
    await prisma.employment.create({ data: { employeeId: employee.id, active: true, startDate: new Date('2000-01-01T00:00:00Z') } });
    await prisma.siteAssignment.create({ data: { employeeId: employee.id, siteId: site.id, isPrimary: true, validFrom: new Date('2000-01-01T00:00:00Z'), validTo: null, assignedByUserId: admin.id } });
    const { token } = await makeSession(`gcz-${tag}`, ['WORKER'], employee.id);
    return { employee, token };
  }

  // ---- online path (performCheckIn via the real route) ----
  const online = await makeWorker('online');
  const onlineEvents: Record<string, string> = {};
  for (const c of CASES) {
    await prisma.employeeOpenShift.deleteMany({ where: { employeeId: online.employee.id } });
    const clientEventId = randomUUID();
    const res = await checkInRoute(
      req('http://localhost/api/worker/attendance/check-in', online.token, {
        clientEventId,
        siteId: site.id,
        workAreaId: null,
        clientCapturedAt: T(8),
        location: { latitude: c.point.latitude, longitude: c.point.longitude, accuracyMeters: c.acc },
        gpsUnavailableReason: null
      })
    );
    check(`online ${c.tag}: 201 CREATED`, res.status === 201, await res.clone().json());
    onlineEvents[c.tag] = clientEventId;
  }

  // ---- offline path (/sync) ----
  const offline = await makeWorker('offline');
  const deviceId = randomUUID();
  await contextRoute(req(`http://localhost/api/worker/attendance/context?deviceInstallationId=${deviceId}&platform=iOS`, offline.token));
  const offlineEvents: Record<string, string> = {};
  let seq = 0;
  for (const c of CASES) {
    await prisma.employeeOpenShift.deleteMany({ where: { employeeId: offline.employee.id } });
    seq += 1;
    const clientEventId = randomUUID();
    const body = {
      clientEventId,
      deviceSequence: seq,
      groupId: null,
      operationType: 'CHECK_IN' as const,
      siteId: site.id,
      assumedSiteId: null,
      workAreaId: null,
      clientCapturedAt: T(8),
      capturedOffline: true,
      cachedGeofenceVersionId: gv.id,
      gps: { latitude: c.point.latitude, longitude: c.point.longitude, accuracyMeters: c.acc },
      gpsUnavailableReason: null
    };
    const res = await syncRoute(req('http://localhost/api/worker/attendance/sync', offline.token, { deviceInstallationId: deviceId, events: [body] }));
    const json = await res.json();
    check(`offline ${c.tag}: 200 ACCEPTED`, res.status === 200 && json.results?.[0]?.outcome === 'ACCEPTED', json);
    offlineEvents[c.tag] = clientEventId;
  }

  // ---- parity assertions ----
  for (const c of CASES) {
    const on = await prisma.clockEvent.findUniqueOrThrow({ where: { id: onlineEvents[c.tag] }, select: { gpsVerification: true, gpsUnavailableReason: true, gpsAccuracyMeters: true } });
    const off = await prisma.clockEvent.findUniqueOrThrow({ where: { id: offlineEvents[c.tag] }, select: { gpsVerification: true, gpsUnavailableReason: true, gpsAccuracyMeters: true } });

    check(`${c.tag}: online gpsVerification == expected`, on.gpsVerification === c.expectVerification, on);
    check(`${c.tag}: offline gpsVerification == expected`, off.gpsVerification === c.expectVerification, off);
    check(`${c.tag}: online reason == expected`, (on.gpsUnavailableReason ?? null) === c.expectReason, on);
    check(`${c.tag}: offline reason == expected`, (off.gpsUnavailableReason ?? null) === c.expectReason, off);
    check(`${c.tag}: online/offline identical GPS fields`, on.gpsVerification === off.gpsVerification && (on.gpsUnavailableReason ?? null) === (off.gpsUnavailableReason ?? null) && Number(on.gpsAccuracyMeters) === Number(off.gpsAccuracyMeters), { on, off });

    for (const [chan, evId] of [['online', onlineEvents[c.tag]], ['offline', offlineEvents[c.tag]]] as const) {
      const gpsExc = await prisma.attendanceException.findFirst({ where: { clockEventId: evId, type: { in: ['GPS_NOT_VERIFIED', 'OUTSIDE_GEOFENCE_CHECKIN'] } } });
      if (c.expectException === null) {
        check(`${c.tag}/${chan}: no GPS exception`, gpsExc === null, gpsExc);
      } else {
        check(`${c.tag}/${chan}: ${c.expectException} exception OPEN`, gpsExc?.type === c.expectException && gpsExc?.status === 'OPEN', gpsExc);
        if (c.expectBoundary) {
          check(`${c.tag}/${chan}: exception detail carries boundaryUncertain=true`, (gpsExc?.detail as Record<string, unknown>)?.boundaryUncertain === true, gpsExc?.detail);
        }
      }
    }
  }

  // ---- idempotent re-sync: replay the NEAR_BOUNDARY event, byte-identical ----
  const boundaryClientEventId = offlineEvents.NEAR_BOUNDARY;
  const cBoundary = CASES.find((c) => c.tag === 'NEAR_BOUNDARY')!;
  const beforeEvents = await prisma.clockEvent.count({ where: { employeeId: offline.employee.id } });
  const beforeExc = await prisma.attendanceException.count({ where: { employeeId: offline.employee.id } });
  const replayBody = {
    clientEventId: boundaryClientEventId,
    deviceSequence: 2,
    groupId: null,
    operationType: 'CHECK_IN' as const,
    siteId: site.id,
    assumedSiteId: null,
    workAreaId: null,
    clientCapturedAt: T(8),
    capturedOffline: true,
    cachedGeofenceVersionId: gv.id,
    gps: { latitude: cBoundary.point.latitude, longitude: cBoundary.point.longitude, accuracyMeters: cBoundary.acc },
    gpsUnavailableReason: null
  };
  const replayRes = await syncRoute(req('http://localhost/api/worker/attendance/sync', offline.token, { deviceInstallationId: deviceId, events: [replayBody] }));
  const replayJson = await replayRes.json();
  check('idempotent re-sync -> DUPLICATE_ACK', replayRes.status === 200 && replayJson.results?.[0]?.outcome === 'DUPLICATE_ACK', replayJson);
  check('idempotent re-sync -> no new ClockEvent', (await prisma.clockEvent.count({ where: { employeeId: offline.employee.id } })) === beforeEvents);
  check('idempotent re-sync -> no new AttendanceException', (await prisma.attendanceException.count({ where: { employeeId: offline.employee.id } })) === beforeExc);

  // restore the policy for other tests sharing this DB
  await updateCompanyAttendancePolicy(admin.id, randomUUID(), { maxGpsAccuracyMeters: 75 });

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
