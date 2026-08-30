// R08 — lib/gps-archive-runner: write phase encrypts sealable days into a staging dir + records
// WRITTEN + self-verifies; promote phase marks VERIFIED only for days the host confirmed off-box,
// re-checking staging sha + decrypt + counts; tamper / sha-mismatch -> FAILED; no key -> refuses.
// db lane (+ a temp staging dir).
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from '../lib/prisma';
import { runGpsArchiveWrite, runGpsArchivePromote } from '../lib/gps-archive-runner';
import { unpackArchive, parseGpsRecords, sha256Hex, GpsArchiveKeyConfigError } from '../lib/gps-archive';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x ?? ''); }
};

let empId = '';
let siteId = '';

async function fixture() {
  const site = await prisma.workSite.create({ data: { name: `RUN ${randomUUID().slice(0, 6)}` } });
  const emp = await prisma.employee.create({ data: { employeeNumber: `RUN-${randomUUID().slice(0, 8)}`, firstName: 'R', lastName: 'W' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00Z') } });
  empId = emp.id;
  siteId = site.id;
}

async function addClock(effectiveAt: string, createdAt: string) {
  const ce = await prisma.clockEvent.create({
    data: {
      id: randomUUID(), employeeId: empId, operationType: 'CHECK_IN', siteId,
      clientCapturedAt: new Date(effectiveAt), capturedOffline: false, effectiveAt: new Date(effectiveAt),
      gpsVerification: 'VERIFIED_INSIDE', processingState: 'ACCEPTED', channel: 'ONLINE',
      payloadHash: 'x'.repeat(64), requestId: randomUUID()
    }
  });
  await prisma.clockEventLocation.create({ data: { clockEventId: ce.id, latitude: 60.17, longitude: 24.94, createdAt: new Date(createdAt) } });
}

async function addPresence(capturedAt: string, createdAt: string) {
  await prisma.shiftPresenceSample.create({
    data: {
      clientSampleId: randomUUID(), employeeId: empId, siteId, capturedAt: new Date(capturedAt),
      capturedOffline: true, latitude: 60.18, longitude: 24.95, accuracyMeters: 7, createdAt: new Date(createdAt)
    }
  });
}

const STAGING = mkdtempSync(join(tmpdir(), 'r08-runner-'));

async function main() {
  await fixture();
  const ASOF = new Date('2026-06-20T02:00:00.000Z'); // seal cutoff (margin 2) = 2026-06-18

  await addClock('2026-05-10T08:00:00Z', '2026-05-10T08:00:03Z');
  await addClock('2026-05-10T17:00:00Z', '2026-05-10T17:00:02Z');
  await addPresence('2026-05-10T12:00:00Z', '2026-05-10T12:00:01Z');
  await addClock('2026-05-11T09:00:00Z', '2026-05-11T09:00:04Z');

  // ---- write ----
  const w = await runGpsArchiveWrite({ stagingDir: STAGING, asOf: ASOF });
  check('write: 2 days written, 0 failed', w.written.length === 2 && w.failed.length === 0, w);
  const d10 = w.written.find((d) => d.archiveDate === '2026-05-10');
  check('05-10 counts: 2 clock + 1 presence', d10?.clockLocationCount === 2 && d10?.presenceSampleCount === 1, d10);
  const blobPath = join(STAGING, 'gps-archive/2026/05/2026-05-10.jsonl.gz.enc');
  check('05-10 .enc file exists', existsSync(blobPath));
  check('05-10 .manifest.json exists', existsSync(`${blobPath}.manifest.json`));
  check('_pending-offbox.json lists both days', (() => {
    const p = JSON.parse(readFileSync(join(STAGING, 'gps-archive/_pending-offbox.json'), 'utf8')) as { days: unknown[] };
    return p.days.length === 2;
  })());

  const row10 = await prisma.gpsArchiveDay.findUnique({ where: { archiveDate_revision: { archiveDate: new Date('2026-05-10T00:00:00Z'), revision: 0 } } });
  check('05-10 ledger row: WRITTEN, hashes + path set', row10?.status === 'WRITTEN' && !!row10.ciphertextSha256 && !!row10.relativePath && row10.writtenAt !== null);

  // ---- the encrypted file decrypts to exactly the DB rows ----
  const jsonl = unpackArchive(readFileSync(blobPath));
  const recs = parseGpsRecords(jsonl);
  check('decrypted 05-10 has 3 records', recs.length === 3);
  check('decrypted plaintext sha matches the manifest', (() => {
    const m = JSON.parse(readFileSync(`${blobPath}.manifest.json`, 'utf8')) as { plaintextSha256: string; recordCount: number };
    return sha256Hex(jsonl) === m.plaintextSha256 && m.recordCount === 3;
  })());
  check('decrypted records carry the real employee id', recs.every((r) => (r as { employeeId: string }).employeeId === empId));
  check('manifest file contains no coordinate', !readFileSync(`${blobPath}.manifest.json`, 'utf8').includes('60.17'));

  // ---- promote: nothing until the host confirms off-box ----
  let p = await runGpsArchivePromote({ stagingDir: STAGING });
  check('promote with no _offbox-verified.json -> nothing', p.verified.length === 0 && p.failed.length === 0, p);

  // simulate the host: it copied the files off-box and checksum-verified them
  const pending = JSON.parse(readFileSync(join(STAGING, 'gps-archive/_pending-offbox.json'), 'utf8')) as { days: { archiveDate: string; revision: number; ciphertextSha256: string }[] };
  writeFileSync(join(STAGING, 'gps-archive/_offbox-verified.json'), JSON.stringify({
    days: pending.days.map((d) => ({ archiveDate: d.archiveDate, revision: d.revision, ciphertextSha256: d.ciphertextSha256 }))
  }));
  p = await runGpsArchivePromote({ stagingDir: STAGING });
  check('promote -> both days VERIFIED', p.verified.length === 2 && p.failed.length === 0, p);
  const row10v = await prisma.gpsArchiveDay.findUnique({ where: { archiveDate_revision: { archiveDate: new Date('2026-05-10T00:00:00Z'), revision: 0 } } });
  check('05-10 ledger row: VERIFIED + verifiedAt', row10v?.status === 'VERIFIED' && row10v.verifiedAt !== null);

  // ---- amendment + a tampered staging file on promote -> FAILED, not VERIFIED ----
  // A late offline sync for 05-10 lands AFTER the first run's watermark (ASOF).
  await addClock('2026-05-10T21:00:00Z', '2026-06-20T12:00:00Z');
  const ASOF2 = new Date('2026-06-21T02:00:00.000Z');
  const w2 = await runGpsArchiveWrite({ stagingDir: STAGING, asOf: ASOF2 });
  const amend = w2.written.find((d) => d.archiveDate === '2026-05-10' && d.revision === 1);
  check('amendment r1 written for 05-10', !!amend, w2.written);
  const amendPath = join(STAGING, 'gps-archive/2026/05/2026-05-10.r01.jsonl.gz.enc');
  // corrupt the staged amendment file
  const good = readFileSync(amendPath);
  const bad = Buffer.from(good); bad[bad.length - 2] ^= 0xff;
  writeFileSync(amendPath, bad);
  writeFileSync(join(STAGING, 'gps-archive/_offbox-verified.json'), JSON.stringify({
    days: [{ archiveDate: '2026-05-10', revision: 1, ciphertextSha256: amend!.ciphertextSha256 }]
  }));
  const p2 = await runGpsArchivePromote({ stagingDir: STAGING });
  check('tampered staging file -> promote FAILED (not VERIFIED)', p2.verified.length === 0 && p2.failed.length === 1 && p2.failed[0].errorCode === 'GPS_ARCHIVE_STAGING_SHA_MISMATCH', p2);
  const amendRow = await prisma.gpsArchiveDay.findUnique({ where: { archiveDate_revision: { archiveDate: new Date('2026-05-10T00:00:00Z'), revision: 1 } } });
  check('amendment r1 ledger row is FAILED', amendRow?.status === 'FAILED' && amendRow.errorCode === 'GPS_ARCHIVE_STAGING_SHA_MISMATCH');

  // ---- off-box sha mismatch -> FAILED ----
  writeFileSync(amendPath, good); // fix the file
  // the write run left r1 FAILED; a fresh write retries it as r1 again
  const w3 = await runGpsArchiveWrite({ stagingDir: STAGING, asOf: ASOF2 });
  check('failed amendment retried', w3.written.some((d) => d.archiveDate === '2026-05-10' && d.revision === 1), w3);
  writeFileSync(join(STAGING, 'gps-archive/_offbox-verified.json'), JSON.stringify({
    days: [{ archiveDate: '2026-05-10', revision: 1, ciphertextSha256: 'deadbeef'.repeat(8) }]
  }));
  const p3 = await runGpsArchivePromote({ stagingDir: STAGING });
  check('wrong off-box sha -> FAILED GPS_ARCHIVE_OFFBOX_SHA_MISMATCH', p3.failed[0]?.errorCode === 'GPS_ARCHIVE_OFFBOX_SHA_MISMATCH', p3);

  // ---- fail-closed: no key ----
  const KEY = process.env.GPS_ARCHIVE_ENCRYPTION_KEY;
  delete process.env.GPS_ARCHIVE_ENCRYPTION_KEY;
  let refused = false;
  try { await runGpsArchiveWrite({ stagingDir: STAGING, asOf: ASOF2 }); } catch (e) { refused = e instanceof GpsArchiveKeyConfigError; }
  check('no key -> runGpsArchiveWrite refuses', refused);
  if (KEY) process.env.GPS_ARCHIVE_ENCRYPTION_KEY = KEY;

  console.log(`\nPASS: ${pass}/${pass + fail}`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
