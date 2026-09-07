// QA-only preview seed for the GPS confidence-zone change (docs/titanor-time/GPS_CONFIDENCE_ZONE_250_RU.md).
// Not a test, not in the manifest. Run against a DISPOSABLE DB migrated to schema 102.
//   DATABASE_URL=... npx tsx scripts/_qa-gps-confidence-preview.ts
// Prints admin + worker session cookies and the boundary exception id for the screenshot pass.
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { bootstrapSuperAdmin } from './bootstrap-super-admin';
import { generateSessionToken, hashSessionToken } from '../lib/session';
import { updateCompanyAttendancePolicy } from '../lib/attendance-policy';
import { ensureEmployeePeriodCore } from '../lib/periods';
import { evaluateGpsReading, exceptionDetailForGps, type ClockGeofence } from '../lib/attendance-clock';

async function session(userId: string): Promise<string> {
  const token = generateSessionToken();
  await prisma.userSession.create({ data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 7 * 86400_000), lastSeenAt: new Date() } });
  return token;
}

async function main() {
  const adminPw = 'PreviewAdmin_' + randomUUID().slice(0, 8) + '!9';
  const boot = await bootstrapSuperAdmin({ username: 'gcz_admin', email: null, locale: 'RU', dryRun: false, password: adminPw });
  const adminUser = await prisma.user.findFirstOrThrow({ where: { username: 'gcz_admin' } });
  const adminCookie = await session(adminUser.id);

  // Company policy at the target 250 so the preview shows the post-rollout behaviour.
  await updateCompanyAttendancePolicy(adminUser.id, randomUUID(), { maxGpsAccuracyMeters: 250 });

  // A geofenced site (shipyard-ish centre, 900 m radius — the reported real case).
  const CENTRE = { latitude: 60.4436, longitude: 22.2079 };
  const site = await prisma.workSite.create({ data: { name: 'Верфь Мейер (превью)' } });
  const gv = await prisma.workSiteGeofenceVersion.create({ data: { siteId: site.id, versionNumber: 1, latitude: CENTRE.latitude, longitude: CENTRE.longitude, radiusMeters: 900, createdByUserId: adminUser.id } });
  await prisma.workSite.update({ where: { id: site.id }, data: { currentGeofenceVersionId: gv.id } });

  // A period covering today so exceptions link to a timesheet.
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  const period = await prisma.payrollPeriod.create({ data: { startDate: start, endDate: end, status: 'OPEN', openedByUserId: adminUser.id } });

  // A worker with an active primary assignment.
  const workerPw = 'PreviewWorker_' + randomUUID().slice(0, 8) + '!9';
  const employee = await prisma.employee.create({ data: { employeeNumber: 'GCZ-0001', firstName: 'Назар', lastName: 'Друз' } });
  await prisma.employment.create({ data: { employeeId: employee.id, active: true, startDate: new Date('2020-01-01T00:00:00Z') } });
  await prisma.siteAssignment.create({ data: { employeeId: employee.id, siteId: site.id, isPrimary: true, validFrom: new Date('2020-01-01T00:00:00Z'), validTo: null, assignedByUserId: adminUser.id } });
  const workerUser = await prisma.user.create({ data: { username: 'gcz_worker', status: 'ACTIVE', locale: 'RU', employeeId: employee.id } });
  const workerRole = await prisma.role.findUniqueOrThrow({ where: { name: 'WORKER' } });
  await prisma.userRole.create({ data: { userId: workerUser.id, roleId: workerRole.id } });
  const workerCookie = await session(workerUser.id);
  const { timesheetId } = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employee.id}::uuid FOR UPDATE`;
    return ensureEmployeePeriodCore(tx, { periodId: period.id, employeeId: employee.id, startDate: start, endDate: end });
  });

  // The reported real case as a NEAR_BOUNDARY GPS_NOT_VERIFIED exception (distance ~820 m, acc 128.9,
  // radius 900) — an actual ClockEvent + ClockEventLocation + exception so the admin detail page renders.
  const geo: ClockGeofence = { geofenceVersionId: gv.id, latitude: CENTRE.latitude, longitude: CENTRE.longitude, radiusMeters: 900 };
  const point = { latitude: Number((CENTRE.latitude + 820 / 111_320).toFixed(6)), longitude: CENTRE.longitude };
  const evalr = evaluateGpsReading({ location: { ...point, accuracyMeters: 128.9 }, gpsUnavailableReason: null }, geo, 250);
  const clockEventId = randomUUID();
  await prisma.clockEvent.create({
    data: {
      id: clockEventId, groupId: randomUUID(), employeeId: employee.id, operationType: 'CHECK_IN', siteId: site.id,
      clientCapturedAt: new Date(), capturedOffline: false, serverReceivedAt: new Date(), effectiveAt: new Date(),
      clockSkewMs: BigInt(0), gpsAccuracyMeters: evalr.gpsAccuracyMeters, gpsVerification: evalr.gpsVerification,
      gpsUnavailableReason: evalr.gpsUnavailableReason, geofenceVersionId: evalr.geofenceVersionId,
      processingState: 'NEEDS_REVIEW', channel: 'ONLINE', payloadHash: 'b'.repeat(64), requestId: randomUUID()
    }
  });
  await prisma.clockEventLocation.create({ data: { clockEventId, latitude: point.latitude, longitude: point.longitude } });
  const exc = await prisma.attendanceException.create({
    data: { type: 'GPS_NOT_VERIFIED', employeeId: employee.id, timesheetId, payrollPeriodId: period.id, occurredAt: new Date(), siteId: site.id, clockEventId, status: 'OPEN', detail: exceptionDetailForGps(evalr, geo) }
  });

  console.log(JSON.stringify({
    adminUser: 'gcz_admin', adminPw, adminCookie,
    workerUser: 'gcz_worker', workerPw, workerCookie,
    siteId: site.id, geofenceVersionId: gv.id, boundaryExceptionId: exc.id,
    evalClassification: evalr.gpsVerification, boundaryUncertain: evalr.boundaryUncertain,
    bootId: boot.userId
  }, null, 2));
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
