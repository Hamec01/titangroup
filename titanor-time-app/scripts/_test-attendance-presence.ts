// T12 §2b (2026-08-28) — server side of the presence-sample track: recordPresenceSample stores an
// opportunistic "still on site" GPS point during an open shift, geofence-evaluates it, is
// idempotent on clientSampleId, ignores a sample with no open shift (worker checked out), refuses
// an unowned/revoked device and an implausible clock skew; the 90-day retention sweep drops old
// samples. Plus validatePresenceSampleInput's field checks.
//
// Needs a disposable PostgreSQL 16 with all migrations applied (DATABASE_URL).
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { validatePresenceSampleInput, recordPresenceSample } from '../lib/attendance-presence';
import { runAttendanceLocationRetention } from '../lib/attendance-location-retention';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL: ${name}`, extra ?? '');
  }
}

async function makeWorkerOnShift(tag: string, geofence: { lat: number; lon: number; radius: number } | null) {
  const admin = await prisma.user.create({ data: { username: `pres_${tag}_${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN' } });
  const site = await prisma.workSite.create({ data: { name: `PRES ${tag} ${randomUUID().slice(0, 4)}` } });
  if (geofence) {
    const gv = await prisma.workSiteGeofenceVersion.create({ data: { siteId: site.id, versionNumber: 1, latitude: geofence.lat, longitude: geofence.lon, radiusMeters: geofence.radius, createdByUserId: admin.id } });
    await prisma.workSite.update({ where: { id: site.id }, data: { currentGeofenceVersionId: gv.id } });
  }
  const emp = await prisma.employee.create({ data: { employeeNumber: `PRES-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'W' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00Z') } });
  const device = await prisma.workerDeviceInstallation.create({ data: { id: randomUUID(), employeeId: emp.id, lastSeenAt: new Date() } });

  const openEvent = await prisma.clockEvent.create({
    data: {
      id: randomUUID(),
      employeeId: emp.id,
      operationType: 'CHECK_IN',
      siteId: site.id,
      clientCapturedAt: new Date(),
      capturedOffline: false,
      effectiveAt: new Date(),
      gpsVerification: 'VERIFIED_INSIDE',
      processingState: 'ACCEPTED',
      channel: 'ONLINE',
      payloadHash: 'x'.repeat(64),
      requestId: randomUUID()
    }
  });
  const openShift = await prisma.employeeOpenShift.create({ data: { employeeId: emp.id, openedByClockEventId: openEvent.id, siteId: site.id, openedAt: new Date() } });
  return { emp, site, device, openShift };
}

async function main() {
  // ---- validatePresenceSampleInput ----
  const good = validatePresenceSampleInput({ clientSampleId: randomUUID(), latitude: 60.17, longitude: 24.94, accuracyMeters: 20, capturedAt: new Date().toISOString(), capturedOffline: false });
  check('valid input parses', good.ok === true, good);
  const badId = validatePresenceSampleInput({ clientSampleId: 'nope', latitude: 60, longitude: 24, accuracyMeters: 20, capturedAt: new Date().toISOString(), capturedOffline: false });
  check('bad clientSampleId rejected', badId.ok === false && !!(badId as { fieldErrors: Record<string, string[]> }).fieldErrors.clientSampleId);
  const badLat = validatePresenceSampleInput({ clientSampleId: randomUUID(), latitude: 200, longitude: 24, accuracyMeters: 20, capturedAt: new Date().toISOString(), capturedOffline: false });
  check('out-of-range latitude rejected', badLat.ok === false);
  const badDate = validatePresenceSampleInput({ clientSampleId: randomUUID(), latitude: 60, longitude: 24, accuracyMeters: 20, capturedAt: 'not-a-date', capturedOffline: false });
  check('bad capturedAt rejected', badDate.ok === false);
  const badBool = validatePresenceSampleInput({ clientSampleId: randomUUID(), latitude: 60, longitude: 24, accuracyMeters: 20, capturedAt: new Date().toISOString(), capturedOffline: 'yes' });
  check('non-boolean capturedOffline rejected', badBool.ok === false);

  // ---- inside the geofence ----
  {
    const f = await makeWorkerOnShift('IN', { lat: 60.17, lon: 24.94, radius: 100 });
    const sampleId = randomUUID();
    const r = await recordPresenceSample(f.emp.id, f.device.id, { clientSampleId: sampleId, latitude: 60.1701, longitude: 24.9401, accuracyMeters: 15, capturedAt: new Date(), capturedOffline: false });
    check('RECORDED, insideGeofence=true', r.kind === 'RECORDED' && r.insideGeofence === true, r);
    const row = await prisma.shiftPresenceSample.findUnique({ where: { clientSampleId: sampleId } });
    check('  row persisted with site + openShift + insideGeofence', !!row && row.siteId === f.site.id && row.openShiftId === f.openShift.id && row.insideGeofence === true, row);
    check('  coordinates rounded to 6dp', !!row && Number(row.latitude) === 60.1701, row?.latitude?.toString());

    // idempotent replay
    const again = await recordPresenceSample(f.emp.id, f.device.id, { clientSampleId: sampleId, latitude: 60.1701, longitude: 24.9401, accuracyMeters: 15, capturedAt: new Date(), capturedOffline: false });
    check('replay of same clientSampleId -> DUPLICATE', again.kind === 'DUPLICATE', again);
    check('  still exactly one row', (await prisma.shiftPresenceSample.count({ where: { clientSampleId: sampleId } })) === 1);
  }

  // ---- outside the geofence ----
  {
    const f = await makeWorkerOnShift('OUT', { lat: 60.17, lon: 24.94, radius: 100 });
    const r = await recordPresenceSample(f.emp.id, f.device.id, { clientSampleId: randomUUID(), latitude: 60.30, longitude: 25.20, accuracyMeters: 15, capturedAt: new Date(), capturedOffline: true });
    check('far point -> RECORDED, insideGeofence=false', r.kind === 'RECORDED' && r.insideGeofence === false, r);
  }

  // ---- low accuracy / no geofence -> insideGeofence null ----
  {
    const f = await makeWorkerOnShift('LOW', { lat: 60.17, lon: 24.94, radius: 100 });
    const r = await recordPresenceSample(f.emp.id, f.device.id, { clientSampleId: randomUUID(), latitude: 60.17, longitude: 24.94, accuracyMeters: 5000, capturedAt: new Date(), capturedOffline: false });
    check('low-accuracy point -> RECORDED, insideGeofence=null', r.kind === 'RECORDED' && r.insideGeofence === null, r);

    const f2 = await makeWorkerOnShift('NOGEO', null);
    const r2 = await recordPresenceSample(f2.emp.id, f2.device.id, { clientSampleId: randomUUID(), latitude: 60.17, longitude: 24.94, accuracyMeters: 15, capturedAt: new Date(), capturedOffline: false });
    check('no geofence -> RECORDED, insideGeofence=null', r2.kind === 'RECORDED' && r2.insideGeofence === null, r2);
  }

  // ---- no open shift (worker checked out) ----
  {
    const f = await makeWorkerOnShift('NOSHIFT', { lat: 60.17, lon: 24.94, radius: 100 });
    await prisma.employeeOpenShift.delete({ where: { employeeId: f.emp.id } });
    const r = await recordPresenceSample(f.emp.id, f.device.id, { clientSampleId: randomUUID(), latitude: 60.17, longitude: 24.94, accuracyMeters: 15, capturedAt: new Date(), capturedOffline: false });
    check('no open shift -> NO_OPEN_SHIFT, nothing stored', r.kind === 'NO_OPEN_SHIFT' && (await prisma.shiftPresenceSample.count({ where: { employeeId: f.emp.id } })) === 0, r);
  }

  // ---- device not owned / revoked ----
  {
    const f = await makeWorkerOnShift('DEV', { lat: 60.17, lon: 24.94, radius: 100 });
    const other = await makeWorkerOnShift('DEV2', null);
    const notOwned = await recordPresenceSample(f.emp.id, other.device.id, { clientSampleId: randomUUID(), latitude: 60.17, longitude: 24.94, accuracyMeters: 15, capturedAt: new Date(), capturedOffline: false });
    check("another worker's device -> DEVICE_NOT_OWNED", notOwned.kind === 'DEVICE_NOT_OWNED', notOwned);

    await prisma.workerDeviceInstallation.update({ where: { id: f.device.id }, data: { revokedAt: new Date() } });
    const revoked = await recordPresenceSample(f.emp.id, f.device.id, { clientSampleId: randomUUID(), latitude: 60.17, longitude: 24.94, accuracyMeters: 15, capturedAt: new Date(), capturedOffline: false });
    check('revoked device -> DEVICE_REVOKED', revoked.kind === 'DEVICE_REVOKED', revoked);
  }

  // ---- implausible clock skew ----
  {
    const f = await makeWorkerOnShift('SKEW', { lat: 60.17, lon: 24.94, radius: 100 });
    const r = await recordPresenceSample(f.emp.id, f.device.id, { clientSampleId: randomUUID(), latitude: 60.17, longitude: 24.94, accuracyMeters: 15, capturedAt: new Date(Date.now() - 3 * 86400000), capturedOffline: true });
    check('3-day-old capturedAt -> CLOCK_SKEW_TOO_LARGE, nothing stored', r.kind === 'CLOCK_SKEW_TOO_LARGE' && (await prisma.shiftPresenceSample.count({ where: { employeeId: f.emp.id } })) === 0, r);
  }

  // ---- retention sweep (R08 — archive-gated) ----
  {
    const f = await makeWorkerOnShift('RET', null);
    const oldCapturedAt = new Date(Date.now() - 100 * 86400000);
    const old = await prisma.shiftPresenceSample.create({
      data: { clientSampleId: randomUUID(), employeeId: f.emp.id, siteId: f.site.id, capturedAt: oldCapturedAt, capturedOffline: false, latitude: '60.170000', longitude: '24.940000', accuracyMeters: '20.0' }
    });
    await prisma.$executeRawUnsafe(`UPDATE "ShiftPresenceSample" SET "createdAt" = now() - interval '100 days' WHERE id = '${old.id}'`);
    const fresh = await recordPresenceSample(f.emp.id, f.device.id, { clientSampleId: randomUUID(), latitude: 60.17, longitude: 24.94, accuracyMeters: 15, capturedAt: new Date(), capturedOffline: false });
    check('fresh sample recorded', fresh.kind === 'RECORDED');

    // Un-archived: retention must NOT touch the old sample yet.
    const held = await runAttendanceLocationRetention();
    check('un-archived old sample is NOT deleted', held.presenceDeletedCount === 0 && (await prisma.shiftPresenceSample.count({ where: { employeeId: f.emp.id } })) === 2, held);
    check('  it is counted as an un-archived old day', held.unarchivedOldDayCount >= 1, held);

    // Mark that reading-day VERIFIED, then retention deletes the old sample and keeps the fresh one.
    const day = new Date(oldCapturedAt.toISOString().slice(0, 10) + 'T00:00:00.000Z');
    await prisma.gpsArchiveDay.create({
      data: {
        archiveDate: day, revision: 0, status: 'VERIFIED',
        clockLocationCount: 0, presenceSampleCount: 1,
        coveredThroughCreatedAt: new Date(), verifiedAt: new Date(),
        plaintextSha256: 'a'.repeat(64), ciphertextSha256: 'b'.repeat(64), ciphertextBytes: 128,
        relativePath: 'gps-archive/x.jsonl.gz.enc', writtenAt: new Date()
      }
    });
    const result = await runAttendanceLocationRetention();
    check('after VERIFIED archive: retention deletes the 100-day-old presence sample', result.presenceDeletedCount >= 1, result);
    check('  the fresh one survives', (await prisma.shiftPresenceSample.count({ where: { employeeId: f.emp.id } })) === 1);
  }

  // ---- retention is fully held when the archive key is absent (R08 fail-closed) ----
  {
    const saved = process.env.GPS_ARCHIVE_ENCRYPTION_KEY;
    delete process.env.GPS_ARCHIVE_ENCRYPTION_KEY;
    const r = await runAttendanceLocationRetention();
    check('no GPS_ARCHIVE_ENCRYPTION_KEY -> nothing deleted, gateSkippedReason set',
      r.deletedCount === 0 && r.presenceDeletedCount === 0 && r.gateSkippedReason === 'skipped_no_archive_key', r);
    if (saved) process.env.GPS_ARCHIVE_ENCRYPTION_KEY = saved;
  }

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
