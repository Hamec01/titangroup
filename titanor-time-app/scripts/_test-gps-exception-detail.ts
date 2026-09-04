// GPS-1 (2026-08-28) — the admin can tell "was the worker actually near the site?" from a
// GPS_NOT_VERIFIED exception: exceptionDetailForGps() now records distance-to-geofence-centre +
// inside/outside for LOW_ACCURACY / no-geofence readings (no raw coords), and
// getAttendanceExceptionDetail() exposes the raw point + geofence for the mini-map ONLY with
// attendance.gps.read.raw.
// Needs a disposable PostgreSQL 16 (DATABASE_URL) for the getAttendanceExceptionDetail part.
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { prisma } from '../lib/prisma';
import { evaluateGpsReading, exceptionDetailForGps, type ClockGeofence } from '../lib/attendance-clock';
import { sanitizeExceptionDetail, getAttendanceExceptionDetail, type ExceptionDetail } from '../lib/attendance-exceptions';
import { ExceptionDetailView } from '../components/attendance-exceptions/ExceptionDetailView';

// R15 fixroad F03 — the "GPS often unavailable at this site" note shows ONLY for a GPS_NOT_VERIFIED
// with NO coordinate (TIMEOUT / POSITION_UNAVAILABLE) at a flagged site. Renders the real component.
const NOTE_EN = 'the device sent no coordinate';
function noteShown(detail: ExceptionDetail): boolean {
  const html = renderToStaticMarkup(
    createElement(ExceptionDetailView, { basePath: '/admin/attendance/exceptions', detail, timesheetHref: null, resolutionPanel: null, locale: 'EN' })
  );
  return html.includes(NOTE_EN);
}

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL:', n, x ?? '');
  }
};

// Meyer Turku Shipyard-ish centre
const SITE = { lat: 60.4436, lon: 22.2079 };
const geofence: ClockGeofence = { geofenceVersionId: randomUUID(), latitude: SITE.lat, longitude: SITE.lon, radiusMeters: 650 };
// ~280 m NE of centre
const NEAR = { lat: 60.4456, lon: 22.2094 };
// ~40 km away
const FAR = { lat: 60.1699, lon: 24.9384 };

async function main() {
  // 1. LOW_ACCURACY, point near the site, inside the circle even ignoring accuracy
  {
    const evalr = evaluateGpsReading({ location: { latitude: NEAR.lat, longitude: NEAR.lon, accuracyMeters: 2000 }, gpsUnavailableReason: null }, geofence);
    check('near point at 2000 m accuracy -> NOT_VERIFIED / LOW_ACCURACY', evalr.gpsVerification === 'NOT_VERIFIED' && evalr.gpsUnavailableReason === 'LOW_ACCURACY', evalr);
    const d = exceptionDetailForGps(evalr, geofence) as Record<string, unknown>;
    check('detail.reason = LOW_ACCURACY', d.reason === 'LOW_ACCURACY', d);
    check('detail.accuracyMeters = 2000', d.accuracyMeters === 2000, d);
    check('detail.distanceToSiteMeters ~ 280 (200-360)', typeof d.distanceToSiteMeters === 'number' && (d.distanceToSiteMeters as number) > 150 && (d.distanceToSiteMeters as number) < 400, d);
    check('detail.geofenceRadiusMeters = 650', d.geofenceRadiusMeters === 650, d);
    check('detail.pointInsideGeofence = true', d.pointInsideGeofence === true, d);
  }

  // 2. LOW_ACCURACY, point 40 km away
  {
    const evalr = evaluateGpsReading({ location: { latitude: FAR.lat, longitude: FAR.lon, accuracyMeters: 2000 }, gpsUnavailableReason: null }, geofence);
    const d = exceptionDetailForGps(evalr, geofence) as Record<string, unknown>;
    check('far point -> pointInsideGeofence = false', d.pointInsideGeofence === false, d);
    check('far point -> distanceToSiteMeters large (> 20000)', (d.distanceToSiteMeters as number) > 20000, d);
  }

  // 3. good accuracy but no geofence configured
  {
    const evalr = evaluateGpsReading({ location: { latitude: NEAR.lat, longitude: NEAR.lon, accuracyMeters: 15 }, gpsUnavailableReason: null }, null);
    check('no geofence -> NOT_VERIFIED', evalr.gpsVerification === 'NOT_VERIFIED', evalr);
    const d = exceptionDetailForGps(evalr, null) as Record<string, unknown>;
    check('no-geofence detail.reason = NO_GEOFENCE_CONFIGURED', d.reason === 'NO_GEOFENCE_CONFIGURED', d);
    check('no-geofence detail has accuracy, no distance', d.accuracyMeters === 15 && d.distanceToSiteMeters === undefined, d);
  }

  // 4. no location at all (permission denied)
  {
    const evalr = evaluateGpsReading({ location: null, gpsUnavailableReason: 'PERMISSION_DENIED' }, geofence);
    const d = exceptionDetailForGps(evalr, geofence) as Record<string, unknown>;
    check('no-location detail.reason = PERMISSION_DENIED, nothing else', d.reason === 'PERMISSION_DENIED' && d.accuracyMeters === undefined && d.distanceToSiteMeters === undefined, d);
  }

  // 5. VERIFIED_OUTSIDE unchanged (regression)
  {
    const outside = { lat: 60.4600, lon: 22.2300 }; // ~2 km, good accuracy
    const evalr = evaluateGpsReading({ location: { latitude: outside.lat, longitude: outside.lon, accuracyMeters: 18 }, gpsUnavailableReason: null }, geofence);
    check('good accuracy far -> VERIFIED_OUTSIDE', evalr.gpsVerification === 'VERIFIED_OUTSIDE', evalr);
    const d = exceptionDetailForGps(evalr, geofence) as Record<string, unknown>;
    check('VERIFIED_OUTSIDE detail shape unchanged', typeof d.distanceMeters === 'number' && d.accuracyMeters === 18 && d.thresholdMeters === 650 && d.reason === undefined, d);
  }

  // 6. sanitizeExceptionDetail keeps the new keys, drops unknowns
  {
    const s = sanitizeExceptionDetail({ reason: 'LOW_ACCURACY', accuracyMeters: 2000, distanceToSiteMeters: 280, geofenceRadiusMeters: 650, pointInsideGeofence: true, secretRawLat: 60.44 });
    check('sanitizer keeps distanceToSiteMeters / geofenceRadiusMeters / pointInsideGeofence', s?.distanceToSiteMeters === 280 && s?.geofenceRadiusMeters === 650 && s?.pointInsideGeofence === true, s);
    check('sanitizer drops unknown key secretRawLat', s !== null && !('secretRawLat' in s), s);
  }

  // 7. getAttendanceExceptionDetail — includeRawGps toggle (DB)
  {
    const admin = await prisma.user.create({ data: { username: `gpsx_${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: (await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } })).id } } } });
    const site = await prisma.workSite.create({ data: { name: `GPSX ${randomUUID().slice(0, 4)}` } });
    const gv = await prisma.workSiteGeofenceVersion.create({ data: { siteId: site.id, latitude: SITE.lat, longitude: SITE.lon, radiusMeters: 650, createdByUserId: admin.id, versionNumber: 1 } });
    await prisma.workSite.update({ where: { id: site.id }, data: { currentGeofenceVersionId: gv.id } });
    const emp = await prisma.employee.create({ data: { employeeNumber: `GPSX-${randomUUID().slice(0, 8)}`, firstName: 'Gps', lastName: 'Worker' } });
    await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01') } });
    const period = await prisma.payrollPeriod.create({ data: { startDate: new Date(Date.UTC(2024, 0, 1)), endDate: new Date(Date.UTC(2024, 0, 7)), status: 'OPEN', openedByUserId: admin.id } });
    const clockEventId = randomUUID();
    await prisma.clockEvent.create({
      data: {
        id: clockEventId, groupId: randomUUID(), employeeId: emp.id, operationType: 'CHECK_IN', siteId: site.id,
        clientCapturedAt: new Date(), capturedOffline: true, serverReceivedAt: new Date(), effectiveAt: new Date(),
        clockSkewMs: BigInt(0), gpsAccuracyMeters: 2000, gpsVerification: 'NOT_VERIFIED', gpsUnavailableReason: 'LOW_ACCURACY',
        processingState: 'ACCEPTED', channel: 'OFFLINE_SYNC', payloadHash: 'x'.repeat(64), requestId: randomUUID()
      }
    });
    await prisma.clockEventLocation.create({ data: { clockEventId, latitude: NEAR.lat, longitude: NEAR.lon } });
    const exc = await prisma.attendanceException.create({
      data: { type: 'GPS_NOT_VERIFIED', employeeId: emp.id, payrollPeriodId: period.id, occurredAt: new Date(), siteId: site.id, clockEventId, status: 'OPEN', detail: { reason: 'LOW_ACCURACY', accuracyMeters: 2000, distanceToSiteMeters: 280, geofenceRadiusMeters: 650, pointInsideGeofence: true } }
    });

    const withRaw = await getAttendanceExceptionDetail(exc.id, null, { includeRawGps: true });
    check('includeRawGps=true -> gpsLocation populated', !!withRaw?.gpsLocation && Math.abs(withRaw!.gpsLocation!.latitude - NEAR.lat) < 0.001, withRaw?.gpsLocation);
    check('includeRawGps=true -> siteGeofence populated', withRaw?.siteGeofence?.radiusMeters === 650, withRaw?.siteGeofence);

    check('includeRawGps=true -> gpsLocation.isApproximate false for a normal fix', withRaw?.gpsLocation?.isApproximate === false, withRaw?.gpsLocation);

    const noRaw = await getAttendanceExceptionDetail(exc.id, null);
    check('no includeRawGps -> gpsLocation null', noRaw?.gpsLocation === null, noRaw?.gpsLocation);
    check('no includeRawGps -> siteGeofence null', noRaw?.siteGeofence === null, noRaw?.siteGeofence);
    check('detail JSON still surfaced regardless', noRaw?.detail?.pointInsideGeofence === true, noRaw?.detail);

    // R15 fixroad F03 — the detail DTO carries the site's informational "GPS often unavailable" flag
    check('siteGpsOftenUnavailable is false by default', noRaw?.siteGpsOftenUnavailable === false, noRaw?.siteGpsOftenUnavailable);
    // flag OFF -> no note, and this exception is a LOW_ACCURACY one (has a coordinate)
    check('F03: flag OFF -> no "GPS often unavailable" note', noRaw ? !noteShown(noRaw) : false);
    await prisma.workSite.update({ where: { id: site.id }, data: { gpsOftenUnavailable: true } });
    const flagged = await getAttendanceExceptionDetail(exc.id, null);
    check('siteGpsOftenUnavailable=true once the site is flagged', flagged?.siteGpsOftenUnavailable === true, flagged?.siteGpsOftenUnavailable);
    check('flagging the site did NOT resolve the exception (informational only)', flagged?.status === 'OPEN', flagged?.status);
    // flag ON but reason is LOW_ACCURACY (a real, imprecise coordinate) -> STILL no note (not weakened)
    check('F03: flag ON + LOW_ACCURACY -> no note (real coordinate keeps full scrutiny)', flagged ? !noteShown(flagged) : false);
  }

  // 8. T14 — an approximate ClockEventLocation surfaces its age on the detail DTO
  {
    const admin = await prisma.user.create({ data: { username: `gpsxa_${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: (await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } })).id } } } });
    const site = await prisma.workSite.create({ data: { name: `GPSXA ${randomUUID().slice(0, 4)}` } });
    const emp = await prisma.employee.create({ data: { employeeNumber: `GPSXA-${randomUUID().slice(0, 8)}`, firstName: 'Gps', lastName: 'Approx' } });
    await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01') } });
    const period = await prisma.payrollPeriod.create({ data: { startDate: new Date(Date.UTC(2024, 0, 1)), endDate: new Date(Date.UTC(2024, 0, 7)), status: 'OPEN', openedByUserId: admin.id } });
    const clockEventId = randomUUID();
    await prisma.clockEvent.create({
      data: {
        id: clockEventId, groupId: randomUUID(), employeeId: emp.id, operationType: 'CHECK_IN', siteId: site.id,
        clientCapturedAt: new Date(), capturedOffline: true, serverReceivedAt: new Date(), effectiveAt: new Date(),
        clockSkewMs: BigInt(0), gpsAccuracyMeters: null, gpsVerification: 'NOT_VERIFIED', gpsUnavailableReason: 'TIMEOUT',
        processingState: 'ACCEPTED', channel: 'OFFLINE_SYNC', payloadHash: 'y'.repeat(64), requestId: randomUUID()
      }
    });
    await prisma.clockEventLocation.create({ data: { clockEventId, latitude: NEAR.lat, longitude: NEAR.lon, isApproximate: true, fixAgeSeconds: 480 } });
    const exc = await prisma.attendanceException.create({
      data: { type: 'GPS_NOT_VERIFIED', employeeId: emp.id, payrollPeriodId: period.id, occurredAt: new Date(), siteId: site.id, clockEventId, status: 'OPEN' }
    });
    const withRaw = await getAttendanceExceptionDetail(exc.id, null, { includeRawGps: true });
    check('approximate ClockEventLocation -> gpsLocation.isApproximate true + fixAgeSeconds 480', withRaw?.gpsLocation?.isApproximate === true && withRaw?.gpsLocation?.fixAgeSeconds === 480 && withRaw?.gpsLocation?.capturedAfterEventSeconds === null, withRaw?.gpsLocation);

    // R15 fixroad F03 — this is a GPS_NOT_VERIFIED with NO coordinate (reason TIMEOUT)
    const offNote = await getAttendanceExceptionDetail(exc.id, null);
    check('F03: no-coordinate GPS_NOT_VERIFIED, flag OFF -> no note', offNote ? !noteShown(offNote) : false);
    await prisma.workSite.update({ where: { id: site.id }, data: { gpsOftenUnavailable: true } });
    const onNote = await getAttendanceExceptionDetail(exc.id, null);
    check('F03: no-coordinate GPS_NOT_VERIFIED, flag ON -> note IS shown', onNote ? noteShown(onNote) : false);
    check('F03: flag ON did not change the exception status', onNote?.status === 'OPEN', onNote?.status);
  }

  // 9. F03 — OUTSIDE_GEOFENCE at a flagged site: NO note, handling unchanged (a good coordinate that
  //    placed the worker elsewhere is never "normal GPS absence").
  {
    const admin = await prisma.user.create({ data: { username: `gpsog_${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: (await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } })).id } } } });
    const site = await prisma.workSite.create({ data: { name: `GPSOG ${randomUUID().slice(0, 4)}`, gpsOftenUnavailable: true } });
    const emp = await prisma.employee.create({ data: { employeeNumber: `GPSOG-${randomUUID().slice(0, 8)}`, firstName: 'Gps', lastName: 'Outside' } });
    await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01') } });
    const period = await prisma.payrollPeriod.create({ data: { startDate: new Date(Date.UTC(2024, 0, 1)), endDate: new Date(Date.UTC(2024, 0, 7)), status: 'OPEN', openedByUserId: admin.id } });
    const clockEventId = randomUUID();
    await prisma.clockEvent.create({
      data: {
        id: clockEventId, groupId: randomUUID(), employeeId: emp.id, operationType: 'CHECK_IN', siteId: site.id,
        clientCapturedAt: new Date(), capturedOffline: true, serverReceivedAt: new Date(), effectiveAt: new Date(),
        clockSkewMs: BigInt(0), gpsAccuracyMeters: 12, gpsVerification: 'VERIFIED_OUTSIDE', gpsUnavailableReason: null,
        processingState: 'ACCEPTED', channel: 'OFFLINE_SYNC', payloadHash: 'z'.repeat(64), requestId: randomUUID()
      }
    });
    const exc = await prisma.attendanceException.create({
      data: { type: 'OUTSIDE_GEOFENCE_CHECKIN', employeeId: emp.id, payrollPeriodId: period.id, occurredAt: new Date(), siteId: site.id, clockEventId, status: 'OPEN', detail: { distanceMeters: 1600, thresholdMeters: 650, accuracyMeters: 12 } }
    });
    const d = await getAttendanceExceptionDetail(exc.id, null);
    check('F03: OUTSIDE_GEOFENCE_CHECKIN at a flagged site -> exception stays OPEN', d?.status === 'OPEN', d?.status);
    check('F03: OUTSIDE_GEOFENCE_CHECKIN at a flagged site -> NO "GPS often unavailable" note', d ? !noteShown(d) : false);
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
