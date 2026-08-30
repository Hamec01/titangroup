// R08 — the retention gate (lib/attendance-location-retention): raw GPS is deleted ONLY when its
// UTC reading-day is fully VERIFIED and fully covered, and NEVER when GPS_ARCHIVE_ENCRYPTION_KEY is
// absent. Failure simulation preserves the original DB rows (TZ §9 PASS criterion). db lane.
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { runAttendanceLocationRetention } from '../lib/attendance-location-retention';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x ?? ''); }
};

let empId = '';
let siteId = '';

async function fixture() {
  const site = await prisma.workSite.create({ data: { name: `GATE ${randomUUID().slice(0, 6)}` } });
  const emp = await prisma.employee.create({ data: { employeeNumber: `GATE-${randomUUID().slice(0, 8)}`, firstName: 'G', lastName: 'W' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00Z') } });
  empId = emp.id;
  siteId = site.id;
}

/** A ClockEventLocation whose parent event reads on `effectiveAt` and whose location row was
 *  inserted `ageDays` ago (ClockEventLocation bans UPDATE, so createdAt is set at insert time). */
async function oldClockLocation(effectiveAt: string, ageDays: number) {
  const ce = await prisma.clockEvent.create({
    data: {
      id: randomUUID(), employeeId: empId, operationType: 'CHECK_IN', siteId,
      clientCapturedAt: new Date(effectiveAt), capturedOffline: false, effectiveAt: new Date(effectiveAt),
      gpsVerification: 'VERIFIED_INSIDE', processingState: 'ACCEPTED', channel: 'ONLINE',
      payloadHash: 'x'.repeat(64), requestId: randomUUID()
    }
  });
  const createdAt = new Date(Date.now() - ageDays * 86400000);
  await prisma.clockEventLocation.create({ data: { clockEventId: ce.id, latitude: 60.17, longitude: 24.94, createdAt } });
  return ce.id;
}

async function oldPresence(capturedAt: string, ageDays: number) {
  const s = await prisma.shiftPresenceSample.create({
    data: {
      clientSampleId: randomUUID(), employeeId: empId, siteId, capturedAt: new Date(capturedAt),
      capturedOffline: false, latitude: 60.17, longitude: 24.94, accuracyMeters: 10,
      createdAt: new Date(Date.now() - ageDays * 86400000)
    }
  });
  return s.id;
}

async function verifyDay(dateStr: string, watermark: Date, revision = 0) {
  await prisma.gpsArchiveDay.create({
    data: {
      archiveDate: new Date(`${dateStr}T00:00:00.000Z`), revision, status: 'VERIFIED',
      clockLocationCount: 0, presenceSampleCount: 0, coveredThroughCreatedAt: watermark, verifiedAt: new Date(),
      plaintextSha256: 'a'.repeat(64), ciphertextSha256: 'b'.repeat(64), ciphertextBytes: 64,
      relativePath: `gps-archive/x/${dateStr}.jsonl.gz.enc`, writtenAt: new Date()
    }
  });
}

const clkCount = () => prisma.clockEventLocation.count({ where: { clockEvent: { employeeId: empId } } });
const psCount = () => prisma.shiftPresenceSample.count({ where: { employeeId: empId } });

async function main() {
  await fixture();
  const KEY = process.env.GPS_ARCHIVE_ENCRYPTION_KEY;

  // Two old reading-days + one fresh row.
  await oldClockLocation('2026-01-10T09:00:00Z', 120);
  await oldPresence('2026-01-10T12:00:00Z', 120);
  await oldClockLocation('2026-01-11T09:00:00Z', 119);
  await oldClockLocation('2026-06-01T09:00:00Z', 5); // fresh (<90d) — must always survive

  check('start: 3 clock locations + 1 presence', (await clkCount()) === 3 && (await psCount()) === 1);

  // ---- no archive at all -> nothing deleted ----
  let r = await runAttendanceLocationRetention();
  check('no archive -> deletes nothing', r.deletedCount === 0 && r.presenceDeletedCount === 0, r);
  check('no archive -> counts un-archived old days (2)', r.unarchivedOldDayCount === 2, r);
  check('all rows still present', (await clkCount()) === 3 && (await psCount()) === 1);

  // ---- day WRITTEN but not VERIFIED -> still nothing deleted ----
  await prisma.gpsArchiveDay.create({
    data: {
      archiveDate: new Date('2026-01-10T00:00:00Z'), revision: 0, status: 'WRITTEN',
      clockLocationCount: 1, presenceSampleCount: 1, coveredThroughCreatedAt: new Date(),
      plaintextSha256: 'a'.repeat(64), ciphertextSha256: 'b'.repeat(64), ciphertextBytes: 64,
      relativePath: 'gps-archive/x/2026-01-10.jsonl.gz.enc', writtenAt: new Date()
    }
  });
  r = await runAttendanceLocationRetention();
  check('WRITTEN (not VERIFIED) -> deletes nothing', r.deletedCount === 0 && r.presenceDeletedCount === 0, r);
  check('rows still present', (await clkCount()) === 3 && (await psCount()) === 1);

  // ---- promote 2026-01-10 to VERIFIED -> only that day's old rows go ----
  await prisma.gpsArchiveDay.update({
    where: { archiveDate_revision: { archiveDate: new Date('2026-01-10T00:00:00Z'), revision: 0 } },
    data: { status: 'VERIFIED', verifiedAt: new Date() }
  });
  r = await runAttendanceLocationRetention();
  check('VERIFIED 2026-01-10 -> its 1 clock + 1 presence deleted', r.deletedCount === 1 && r.presenceDeletedCount === 1, r);
  check('2026-01-11 + fresh row untouched', (await clkCount()) === 2 && (await psCount()) === 0);
  check('un-archived old day count now 1 (2026-01-11)', r.unarchivedOldDayCount === 1, r);

  // ---- a pending amendment blocks its day ----
  await verifyDay('2026-01-11', new Date(Date.now() - 200 * 86400000)); // watermark far in the past
  // an old row for 2026-01-11 inserted AFTER that watermark:
  await oldClockLocation('2026-01-11T18:00:00Z', 95);
  r = await runAttendanceLocationRetention();
  check('2026-01-11 has a row past the watermark -> not deleted', (await clkCount()) === 3, r);

  // ---- cover the amendment -> 2026-01-11 clears ----
  await verifyDay('2026-01-11', new Date(), 1);
  r = await runAttendanceLocationRetention();
  check('2026-01-11 fully covered -> its old clock rows deleted', r.deletedCount === 2 && (await clkCount()) === 1, r);
  check('the <90-day fresh row still survives', (await clkCount()) === 1);

  // ---- 90-day floor still holds on a VERIFIED day ----
  await verifyDay('2026-06-01', new Date());
  r = await runAttendanceLocationRetention();
  check('fresh (<90d) row on a VERIFIED day is NOT deleted', (await clkCount()) === 1, r);
  // and the DB trigger independently blocks an early delete
  let triggerBlocked = false;
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "ClockEventLocation" WHERE "createdAt" >= now() - interval '90 days'`);
  } catch (e) {
    triggerBlocked = /RETENTION_WINDOW_NOT_ELAPSED/.test(String(e));
  }
  check('DB trigger blocks a manual <90-day ClockEventLocation delete', triggerBlocked);

  // ---- fail-closed: no key -> nothing deleted even with everything VERIFIED ----
  await oldPresence('2026-06-01T12:00:00Z', 100); // an old, archived-day presence sample
  delete process.env.GPS_ARCHIVE_ENCRYPTION_KEY;
  r = await runAttendanceLocationRetention();
  check('no GPS_ARCHIVE_ENCRYPTION_KEY -> deletes nothing, gateSkippedReason set',
    r.deletedCount === 0 && r.presenceDeletedCount === 0 && r.gateSkippedReason === 'skipped_no_archive_key', r);
  check('  the old archived-day sample survived the keyless pass', (await psCount()) === 1);
  if (KEY) process.env.GPS_ARCHIVE_ENCRYPTION_KEY = KEY;
  r = await runAttendanceLocationRetention();
  check('key restored -> the old archived-day sample is now deleted', r.presenceDeletedCount === 1 && (await psCount()) === 0, r);

  console.log(`\nPASS: ${pass}/${pass + fail}`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
