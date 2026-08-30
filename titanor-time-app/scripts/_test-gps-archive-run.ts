// R08 — lib/gps-archive-run.ts against a disposable DB: sealable-day selection (new / retry /
// amendment / too-recent / done), per-day collection with createdAt bounds + deterministic order,
// and the GpsArchiveDay ledger helpers. db lane.
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import {
  listSealableDays,
  collectGpsDay,
  upsertArchiveDayWritten,
  markArchiveDayVerified,
  markArchiveDayFailed
} from '../lib/gps-archive-run';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x ?? ''); }
};

let empId = '';
let siteId = '';

async function fixture() {
  const admin = await prisma.user.create({ data: { username: `gpsa_${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });
  void admin;
  const site = await prisma.workSite.create({ data: { name: `GPSA ${randomUUID().slice(0, 6)}` } });
  const emp = await prisma.employee.create({ data: { employeeNumber: `GPSA-${randomUUID().slice(0, 8)}`, firstName: 'A', lastName: 'W' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00Z') } });
  empId = emp.id;
  siteId = site.id;
}

async function addClock(effectiveAt: string, locCreatedAt: string, lat: number, lng: number) {
  const ce = await prisma.clockEvent.create({
    data: {
      id: randomUUID(),
      employeeId: empId,
      operationType: 'CHECK_IN',
      siteId,
      clientCapturedAt: new Date(effectiveAt),
      capturedOffline: false,
      effectiveAt: new Date(effectiveAt),
      gpsVerification: 'VERIFIED_INSIDE',
      processingState: 'ACCEPTED',
      channel: 'ONLINE',
      payloadHash: 'x'.repeat(64),
      requestId: randomUUID()
    }
  });
  await prisma.clockEventLocation.create({
    data: { clockEventId: ce.id, latitude: lat, longitude: lng, createdAt: new Date(locCreatedAt) }
  });
  return ce.id;
}

async function addPresence(capturedAt: string, createdAt: string, lat: number, lng: number) {
  const s = await prisma.shiftPresenceSample.create({
    data: {
      clientSampleId: randomUUID(),
      employeeId: empId,
      siteId,
      capturedAt: new Date(capturedAt),
      capturedOffline: true,
      latitude: lat,
      longitude: lng,
      accuracyMeters: 9.0,
      createdAt: new Date(createdAt)
    }
  });
  return s.id;
}

async function main() {
  await fixture();
  const ASOF = new Date('2026-06-10T03:00:00.000Z'); // seal cutoff (margin 2) = 2026-06-08

  // Day 2026-05-20: normal — reading + insert same day, well before the cutoff.
  await addClock('2026-05-20T08:00:00Z', '2026-05-20T08:00:05Z', 60.1701, 24.9384);
  await addClock('2026-05-20T16:00:00Z', '2026-05-20T16:00:04Z', 60.1702, 24.9385);
  await addPresence('2026-05-20T12:00:00Z', '2026-05-20T12:00:03Z', 60.1703, 24.9386);
  // Day 2026-05-21: one clock event that SYNCED LATE (offline) — read 05-21, stored 05-25.
  const lateClockId = await addClock('2026-05-21T09:00:00Z', '2026-05-25T07:30:00Z', 60.20, 24.65);
  // Day 2026-06-09: inside the 2-day seal margin — must NOT be sealable yet.
  await addClock('2026-06-09T09:00:00Z', '2026-06-09T09:00:02Z', 60.99, 24.99);

  // ---- listSealableDays: new days ----
  let days = await listSealableDays(ASOF, { sealMarginDays: 2, maxLookbackDays: 120 });
  const dstr = days.map((d) => `${d.archiveDate}:${d.reason}:r${d.targetRevision}`);
  check('05-20 listed as new r0', dstr.includes('2026-05-20:new:r0'), dstr);
  check('05-21 listed as new r0 (late offline event still archived)', dstr.includes('2026-05-21:new:r0'), dstr);
  check('06-09 NOT listed (inside seal margin)', !days.some((d) => d.archiveDate === '2026-06-09'), dstr);
  check('exactly the two sealable days', days.length === 2, dstr);

  // ---- collectGpsDay: 05-20 ----
  const c20 = await collectGpsDay('2026-05-20', null, ASOF, new Date('2026-06-10T03:00:00Z'));
  check('05-20 collects 2 clock + 1 presence', c20.clockLocationCount === 2 && c20.presenceSampleCount === 1, c20);
  check('05-20 records ordered by createdAt then id', c20.records.map((r) => r.recordedAt).join() ===
    '2026-05-20T08:00:00.000Z,2026-05-20T16:00:00.000Z,2026-05-20T12:00:00.000Z');
  check('05-20 clock record has string lat', typeof c20.records[0].latitude === 'string' && c20.records[0].latitude.startsWith('60.170'));
  check('05-20 clock record carries the site id', (c20.records[0] as { siteId: string }).siteId === siteId);
  check('05-20 archivedAt stamped', c20.records[0].archivedAt === '2026-06-10T03:00:00.000Z');

  // ---- collectGpsDay: createdAt bounds ----
  const c20since = await collectGpsDay('2026-05-20', new Date('2026-05-20T12:00:02Z'), ASOF, ASOF);
  check('sinceCreatedAt excludes earlier rows', c20since.clockLocationCount === 1 && c20since.presenceSampleCount === 1, c20since);
  const c20through = await collectGpsDay('2026-05-20', null, new Date('2026-05-20T10:00:00Z'), ASOF);
  check('throughCreatedAt excludes later rows', c20through.clockLocationCount === 1 && c20through.presenceSampleCount === 0, c20through);

  // ---- write + verify 05-20, then it drops off the list ----
  // Simulate the archive run happening on 2026-05-27 — that becomes the day's watermark.
  const WATERMARK_20 = new Date('2026-05-27T02:00:00.000Z');
  await upsertArchiveDayWritten({
    archiveDate: '2026-05-20', revision: 0,
    clockLocationCount: 2, presenceSampleCount: 1,
    coveredThroughCreatedAt: WATERMARK_20,
    plaintextSha256: 'a'.repeat(64), ciphertextSha256: 'b'.repeat(64), ciphertextBytes: 200,
    relativePath: 'gps-archive/2026/05/2026-05-20.jsonl.gz.enc'
  });
  let row = await prisma.gpsArchiveDay.findUnique({ where: { archiveDate_revision: { archiveDate: new Date('2026-05-20T00:00:00Z'), revision: 0 } } });
  check('after write: status WRITTEN', row?.status === 'WRITTEN');
  days = await listSealableDays(ASOF, { sealMarginDays: 2 });
  check('WRITTEN-not-verified 05-20 shows as retry r0', days.some((d) => d.archiveDate === '2026-05-20' && d.reason === 'retry' && d.targetRevision === 0), days);
  await markArchiveDayVerified('2026-05-20', 0);
  row = await prisma.gpsArchiveDay.findUnique({ where: { archiveDate_revision: { archiveDate: new Date('2026-05-20T00:00:00Z'), revision: 0 } } });
  check('after verify: status VERIFIED + verifiedAt set', row?.status === 'VERIFIED' && row.verifiedAt !== null);
  days = await listSealableDays(ASOF, { sealMarginDays: 2 });
  check('verified 05-20 no longer listed', !days.some((d) => d.archiveDate === '2026-05-20'), days);

  // ---- amendment: a new row lands for verified day 05-20 AFTER its watermark (2026-05-27) ----
  await addClock('2026-05-20T18:00:00Z', '2026-06-05T10:00:00Z', 60.171, 24.939);
  days = await listSealableDays(ASOF, { sealMarginDays: 2 });
  const amend = days.find((d) => d.archiveDate === '2026-05-20');
  check('05-20 now needs an amendment r1', amend?.reason === 'amendment' && amend.targetRevision === 1, days);
  const cAmend = await collectGpsDay('2026-05-20', amend?.sinceCreatedAt ?? null, ASOF, ASOF);
  check('amendment collects only the late row', cAmend.clockLocationCount === 1 && cAmend.presenceSampleCount === 0, cAmend);
  check('amendment sinceCreatedAt is the prior watermark', amend?.sinceCreatedAt?.getTime() === WATERMARK_20.getTime());

  // ---- markArchiveDayFailed ----
  await markArchiveDayFailed('2026-05-21', 0, 'GPS_ARCHIVE_WRITE_FAILED', { clockLocationCount: 1, presenceSampleCount: 0, coveredThroughCreatedAt: ASOF });
  const f = await prisma.gpsArchiveDay.findUnique({ where: { archiveDate_revision: { archiveDate: new Date('2026-05-21T00:00:00Z'), revision: 0 } } });
  check('failed row: status FAILED + errorCode', f?.status === 'FAILED' && f.errorCode === 'GPS_ARCHIVE_WRITE_FAILED');
  days = await listSealableDays(ASOF, { sealMarginDays: 2 });
  check('FAILED 05-21 shows as retry r0', days.some((d) => d.archiveDate === '2026-05-21' && d.reason === 'retry' && d.targetRevision === 0), days);
  void lateClockId;

  console.log(`\nPASS: ${pass}/${pass + fail}`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
