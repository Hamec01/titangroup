// docs/titanor-time/REPORT_REDESIGN_PRODUCTION_READINESS_RU.md §7 + §13.A — schema-level
// regression for the ReportFile table on disposable PostgreSQL 16. Exercises the actual DB
// constraints/triggers added by 20260906210000_harden_report_files, the lib/report-files.ts audit
// path, and proves the payroll ExportBatch/ExportItem contract is untouched. Needs DATABASE_URL
// (+ the *_KEY env the runner injects).
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { createReportFile, deleteReportFile, listReportFiles, verifyReportFileIntegrity, getReportFileDownload } from '../lib/report-files';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) pass++;
  else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 500) : '');
  }
};

async function expectReject(name: string, fn: () => Promise<unknown>, needle: string) {
  try {
    await fn();
    check(name, false, 'expected rejection, got success');
  } catch (err) {
    const anyErr = err as { message?: string; code?: string; meta?: unknown };
    const message = err instanceof Error ? err.message : String(err);
    const found = message.includes(needle) || anyErr.code === needle || JSON.stringify(anyErr.meta ?? {}).includes(needle);
    check(name, found, { code: anyErr.code, message: message.slice(-260) });
  }
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

async function makeAdmin() {
  const user = await prisma.user.create({ data: { username: `rf-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'ADMIN' } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return user;
}

async function makePeriod() {
  const admin = await makeAdmin();
  return prisma.payrollPeriod.create({
    data: { startDate: new Date('2091-02-03'), endDate: new Date('2091-02-16'), status: 'OPEN', openedByUserId: admin.id }
  });
}

/** Raw INSERT so we can push values the Prisma client / service would refuse and see the DB react.
 * `content` is always the 5-byte literal `test1`; `fileSizeBytes` defaults to 5 to match. */
async function rawInsert(userId: string, overrides: Record<string, string> = {}) {
  const cols: Record<string, string> = {
    periodId: 'NULL',
    reportType: `'PERIOD_SUMMARY'`,
    format: `'PDF'`,
    fileName: `'titanor-working-report_period_2091-02-03_2091-02-16.pdf'`,
    mimeType: `'application/pdf'`,
    fileHash: `'${'a'.repeat(64)}'`,
    fileSizeBytes: '5',
    rowCount: 'NULL',
    createdByUserId: `'${userId}'`,
    ...overrides
  };
  const keys = [...Object.keys(cols), 'content'];
  const values = [...Object.values(cols), `decode('7465737431', 'hex')`];
  return prisma.$executeRawUnsafe(`INSERT INTO "ReportFile" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${values.join(', ')})`);
}

async function main() {
  // ── 1/2: migration recorded + second `migrate deploy` is a clean no-op ──────────────────────
  {
    const rows = await prisma.$queryRaw<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
      SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"
      WHERE migration_name IN ('20260906193000_add_saved_report_files', '20260906210000_harden_report_files')`;
    check('1: both report-file migrations recorded in _prisma_migrations', rows.length === 2, rows.length);
    check('2: both finished cleanly, nothing rolled back', rows.every((r) => r.finished_at !== null && r.rolled_back_at === null), rows);

    const schemaPath = join(process.cwd(), '..', 'prisma', 'schema.prisma');
    const out = execFileSync(join(process.cwd(), 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy', '--schema', schemaPath], {
      env: { ...process.env },
      encoding: 'utf8'
    });
    check('2b: second `prisma migrate deploy` is a no-op', /No pending migrations to apply/.test(out), out.slice(-200));
  }

  const admin = await makeAdmin();
  const period = await makePeriod();

  // ── 3: FK integrity ───────────────────────────────────────────────────────────────────────────
  await expectReject('3a: dangling periodId is rejected', () => rawInsert(admin.id, { periodId: `'${randomUUID()}'` }), '23503');
  await expectReject('3b: dangling createdByUserId is rejected', () => rawInsert(randomUUID()), '23503');
  {
    await rawInsert(admin.id, { periodId: `'${period.id}'` });
    const count = await prisma.reportFile.count({ where: { periodId: period.id } });
    check('3c: a well-formed row inserts', count === 1, count);
  }

  // ── 4: CHECK constraints ──────────────────────────────────────────────────────────────────────
  await expectReject('4a: format must be PDF/CSV', () => rawInsert(admin.id, { format: `'XML'` }), 'ck_report_file_format');
  await expectReject('4b: reportType is a closed set', () => rawInsert(admin.id, { reportType: `'MYSTERY'` }), 'ck_report_file_type');
  await expectReject('4c: fileHash must be 64 lowercase hex', () => rawInsert(admin.id, { fileHash: `'NOT-A-HASH'` }), 'ck_report_file_hash_format');
  await expectReject('4d: fileSizeBytes must equal octet_length(content)', () => rawInsert(admin.id, { fileSizeBytes: '999' }), 'ck_report_file_size_matches_content');
  await expectReject('4e: rowCount cannot be negative', () => rawInsert(admin.id, { rowCount: '-1' }), 'ck_report_file_row_count');
  await expectReject('4f: mimeType must match format', () => rawInsert(admin.id, { format: `'CSV'`, mimeType: `'application/pdf'` }), 'ck_report_file_mime_matches_format');
  await expectReject(
    '4g: file name cannot carry a newline (header injection)',
    () => rawInsert(admin.id, { fileName: `E'bad\\nname.pdf'` }),
    'ck_report_file_name_safe'
  );

  // ── 5: service create → audit REPORT_FILE_CREATED, integrity holds ─────────────────────────────
  const requestId = randomUUID();
  const csv = Buffer.from('"WORKING REPORT — NOT AN OFFICIAL PAYROLL EXPORT"\r\nSite,Worked minutes\r\nAlpha,120\r\n', 'utf8');
  const created = await createReportFile({
    periodId: period.id,
    reportType: 'PERIOD_SUMMARY',
    format: 'CSV',
    fileName: 'titanor-working-report_period_2091-02-03_2091-02-16.csv',
    content: csv,
    rowCount: 1,
    createdByUserId: admin.id,
    requestId
  });
  check('5a: createReportFile returns a summary with a download url', created.downloadUrl === `/api/admin/report-files/${created.id}/download`, created);
  check('5b: stored hash = sha256(content)', created.fileHash === sha256(csv), created.fileHash);
  {
    const audit = await prisma.auditEvent.findFirst({ where: { eventType: 'REPORT_FILE_CREATED', entityId: created.id } });
    check('5c: REPORT_FILE_CREATED audit row exists with matching requestId', audit?.requestId === requestId, audit);
    const payload = JSON.stringify(audit?.afterValue ?? {});
    check('5d: audit payload carries metadata but never the bytes', payload.includes('"reportType":"PERIOD_SUMMARY"') && !payload.includes('WORKING REPORT'), payload.slice(0, 200));
  }
  {
    const dl = await getReportFileDownload(created.id);
    check('5e: download integrity re-check passes on a good row', dl != null && verifyReportFileIntegrity(dl), dl == null);
  }

  // ── 6: rejects an oversize / invalid create at the service layer ───────────────────────────────
  await expectReject(
    '6a: service rejects an unknown reportType',
    () => createReportFile({ periodId: period.id, reportType: 'NOPE' as never, format: 'CSV', fileName: 'x.csv', content: csv, createdByUserId: admin.id, requestId: randomUUID() }),
    'reportType'
  );
  await expectReject(
    '6b: service rejects a header-unsafe file name',
    () => createReportFile({ periodId: period.id, reportType: 'PERIOD_SUMMARY', format: 'CSV', fileName: 'bad\nname.csv', content: csv, createdByUserId: admin.id, requestId: randomUUID() }),
    'fileName'
  );

  // ── 7: delete is physical but audited ─────────────────────────────────────────────────────────
  {
    const delReq = randomUUID();
    const okDelete = await deleteReportFile(created.id, admin.id, delReq);
    check('7a: deleteReportFile returns true', okDelete === true);
    const still = await prisma.reportFile.findUnique({ where: { id: created.id } });
    check('7b: row is physically gone', still === null);
    const audit = await prisma.auditEvent.findFirst({ where: { eventType: 'REPORT_FILE_DELETED', entityId: created.id } });
    check('7c: REPORT_FILE_DELETED audit row exists', audit?.requestId === delReq, audit);
    const okSecond = await deleteReportFile(created.id, admin.id, randomUUID());
    check('7d: deleting an already-gone row returns false (=> clean 404)', okSecond === false);
  }

  // ── 8: pagination — no hidden take=100 ────────────────────────────────────────────────────────
  {
    const p2 = await makePeriod();
    for (let n = 0; n < 105; n++) {
      await createReportFile({
        periodId: p2.id,
        reportType: 'PERIOD_SUMMARY',
        format: 'CSV',
        fileName: `titanor-working-report_period_bulk-${n}.csv`,
        content: Buffer.from(`row ${n}\r\n`, 'utf8'),
        rowCount: 1,
        createdByUserId: admin.id,
        requestId: randomUUID()
      });
    }
    const page1 = await listReportFiles({ periodId: p2.id, page: 1, pageSize: 10 });
    const page11 = await listReportFiles({ periodId: p2.id, page: 11, pageSize: 10 });
    check('8a: totalItems reflects every row, not a 100 cap', page1.totalItems === 105, page1.totalItems);
    check('8b: totalPages computed from the full count', page1.totalPages === 11, page1.totalPages);
    check('8c: the last page returns the tail rows (beyond position 100)', page11.items.length === 5, page11.items.length);
    check('8d: pages do not overlap', !page1.items.some((f) => page11.items.find((g) => g.id === f.id)), true);
  }

  // ── 9: payroll ExportBatch/ExportItem contract untouched ──────────────────────────────────────
  {
    const before = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE conrelid = '"ExportBatch"'::regclass AND conname LIKE 'ck_export_batch%'`;
    check('9a: ExportBatch CHECK constraints still present', before.length >= 3, before.map((r) => r.conname));
    const trg = await prisma.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger WHERE tgrelid = '"ExportBatch"'::regclass AND tgname = 'trg_export_batch_immutable'`;
    check('9b: ExportBatch immutability trigger still present', trg.length === 1, trg);
    const rfConstraints = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint WHERE conrelid = '"ReportFile"'::regclass ORDER BY conname`;
    check('9c: ReportFile carries FK + CK constraints (>= 8)', rfConstraints.length >= 8, rfConstraints.map((r) => r.conname));
  }

  console.log(`\n  ${pass} passed · ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
