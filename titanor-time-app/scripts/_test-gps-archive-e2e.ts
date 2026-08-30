// R08 — end-to-end (TZ §9 PASS): raw GPS -> write -> host off-box sync -> promote (VERIFIED) ->
// retention deletes the archived days -> the deleted coordinates are recoverable by decrypting the
// off-box file. And: a day whose promote fails keeps its raw GPS. db lane (+ temp dirs).
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prisma } from '../lib/prisma';
import { runGpsArchiveWrite, runGpsArchivePromote } from '../lib/gps-archive-runner';
import { runAttendanceLocationRetention } from '../lib/attendance-location-retention';
import { unpackArchive, parseGpsRecords, sha256Hex } from '../lib/gps-archive';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x ?? ''); }
};

const STAGING = mkdtempSync(join(tmpdir(), 'r08-e2e-stg-'));
const OFFBOX = mkdtempSync(join(tmpdir(), 'r08-e2e-box-'));

let empId = '';
let siteId = '';

async function fixture() {
  const site = await prisma.workSite.create({ data: { name: `E2E ${randomUUID().slice(0, 6)}` } });
  const emp = await prisma.employee.create({ data: { employeeNumber: `E2E-${randomUUID().slice(0, 8)}`, firstName: 'E', lastName: 'W' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00Z') } });
  empId = emp.id;
  siteId = site.id;
}

const dayAgo = (n: number) => new Date(Date.now() - n * 86400000);
const utcDate = (d: Date) => d.toISOString().slice(0, 10);

async function oldClock(readingDaysAgo: number, insertDaysAgo: number, lat: string, lng: string) {
  const effectiveAt = dayAgo(readingDaysAgo);
  const ce = await prisma.clockEvent.create({
    data: {
      id: randomUUID(), employeeId: empId, operationType: 'CHECK_IN', siteId,
      clientCapturedAt: effectiveAt, capturedOffline: false, effectiveAt,
      gpsVerification: 'VERIFIED_INSIDE', processingState: 'ACCEPTED', channel: 'ONLINE',
      payloadHash: 'x'.repeat(64), requestId: randomUUID()
    }
  });
  await prisma.clockEventLocation.create({
    data: { clockEventId: ce.id, latitude: lat, longitude: lng, createdAt: dayAgo(insertDaysAgo) }
  });
  return { id: ce.id, readingDay: utcDate(effectiveAt) };
}

/** Simulate ops/titanor-time/gps-archive-titanor-time.sh's sync step: copy every pending file to
 *  the off-box root, sha-check it, and write _offbox-verified.json. Optionally corrupt one file. */
function hostSync(corrupt?: { archiveDate: string; revision: number }) {
  const pending = JSON.parse(readFileSync(join(STAGING, 'gps-archive/_pending-offbox.json'), 'utf8')) as {
    days: { archiveDate: string; revision: number; relativePath: string; ciphertextSha256: string }[];
  };
  const confirmed: { archiveDate: string; revision: number; ciphertextSha256: string }[] = [];
  for (const d of pending.days) {
    const src = join(STAGING, d.relativePath);
    const dst = join(OFFBOX, d.relativePath);
    execFileSync('mkdir', ['-p', join(dst, '..')]);
    cpSync(src, dst);
    if (existsSync(`${src}.manifest.json`)) cpSync(`${src}.manifest.json`, `${dst}.manifest.json`);
    if (corrupt && corrupt.archiveDate === d.archiveDate && corrupt.revision === d.revision) {
      const b = readFileSync(dst); b[b.length - 3] ^= 0xff; writeFileSync(dst, b);
    }
    const actual = sha256Hex(readFileSync(dst));
    if (actual === d.ciphertextSha256) confirmed.push({ archiveDate: d.archiveDate, revision: d.revision, ciphertextSha256: d.ciphertextSha256 });
  }
  writeFileSync(join(STAGING, 'gps-archive/_offbox-verified.json'), JSON.stringify({ days: confirmed }));
  return confirmed;
}

async function main() {
  await fixture();
  const ASOF = new Date();

  // Reading-day A (~100 days ago): three old clock locations with distinct, known coordinates.
  const coords = [
    ['60.100001', '24.200001'],
    ['60.100002', '24.200002'],
    ['60.100003', '24.200003']
  ];
  const ids: string[] = [];
  let dayA = '';
  for (let i = 0; i < 3; i++) {
    const c = await oldClock(100, 100, coords[i][0], coords[i][1]);
    ids.push(c.id);
    dayA = c.readingDay;
  }
  // Reading-day B (~99 days ago): one old row that will hit a promote failure and must survive.
  const b = await oldClock(99, 99, '60.9', '24.9');
  // A fresh row (reading yesterday — inside the 2-day seal margin, never archived, never deleted).
  await oldClock(1, 1, '60.5', '24.5');

  // ---- write -> host sync (corrupt day B) -> promote ----
  const w = await runGpsArchiveWrite({ stagingDir: STAGING, asOf: ASOF });
  check('write: reading-days A and B written', w.written.some((d) => d.archiveDate === dayA) && w.written.some((d) => d.archiveDate === b.readingDay) && w.failed.length === 0, w);
  // The host copies both off-box but day B's copy is corrupt -> its SHA-256 mismatches -> the host
  // does NOT confirm it, so promote never verifies it and it stays WRITTEN.
  const confirmed = hostSync({ archiveDate: b.readingDay, revision: 0 });
  check('host confirms day A only (day B off-box SHA mismatch)', confirmed.length === 1 && confirmed[0].archiveDate === dayA, confirmed);
  const p = await runGpsArchivePromote({ stagingDir: STAGING });
  check('promote: day A VERIFIED, day B untouched', p.verified.some((v) => v.archiveDate === dayA) && p.verified.length === 1, p);
  const bRow = await prisma.gpsArchiveDay.findFirst({ where: { archiveDate: new Date(`${b.readingDay}T00:00:00Z`) } });
  check('day B ledger row is still WRITTEN (retry next run)', bRow?.status === 'WRITTEN', bRow);

  // ---- retention ----
  const r = await runAttendanceLocationRetention();
  check('retention deletes the 3 day-A rows only', r.deletedCount === 3, r);
  check('day B (not verified) row survives', (await prisma.clockEventLocation.count({ where: { clockEventId: b.id } })) === 1);
  check('fresh row survives', (await prisma.clockEventLocation.count({ where: { clockEvent: { employeeId: empId } } })) === 2);
  check('day B still counted as un-archived old day', r.unarchivedOldDayCount === 1, r);

  // ---- the deleted coordinates are recoverable from the OFF-BOX archive ----
  const [y, m, d] = dayA.split('-');
  const encPath = join(OFFBOX, `gps-archive/${y}/${m}/${dayA}.jsonl.gz.enc`);
  void d;
  const jsonl = unpackArchive(readFileSync(encPath));
  const recs = parseGpsRecords(jsonl);
  check('off-box day-A archive has 3 records', recs.length === 3);
  for (let i = 0; i < 3; i++) {
    const rec = recs.find((x) => (x as { clockEventId?: string }).clockEventId === ids[i]) as { latitude: string; longitude: string } | undefined;
    check(`deleted row ${i} recoverable with exact coordinates`, rec?.latitude === coords[i][0] && rec?.longitude === coords[i][1], rec);
  }
  const manifest = JSON.parse(readFileSync(`${encPath}.manifest.json`, 'utf8')) as { plaintextSha256: string; recordCount: number };
  check('off-box manifest matches the decrypted content', sha256Hex(jsonl) === manifest.plaintextSha256 && manifest.recordCount === 3);

  console.log(`\nPASS: ${pass}/${pass + fail}`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
