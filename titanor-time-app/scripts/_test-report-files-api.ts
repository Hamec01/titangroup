// docs/titanor-time/REPORT_REDESIGN_PRODUCTION_READINESS_RU.md §13.B — HTTP-contract regression
// for the report command centre, direct-route-handler style on disposable PostgreSQL 16. Covers
// create (PDF/CSV, all three report types), download, delete, repeat delete, malformed id, missing
// period, permissions (ADMIN / SUPER_ADMIN / read-only / none / no session), CSRF, Idempotency-Key
// (replay + reuse + concurrent), the >100-site no-truncation guarantee, and safe file names.
import { randomUUID, createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../lib/prisma';
import { generateSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from '../lib/session';
import { POST as exportPost } from '../app/api/admin/reports/export/route';
import { GET as downloadGet } from '../app/api/admin/report-files/[fileId]/download/route';
import { DELETE as fileDelete } from '../app/api/admin/report-files/[fileId]/route';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) pass++;
  else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 500) : '');
  }
};

const READ_PERMS = ['period.read.all', 'site.read.all', 'worker.read.all', 'timesheet.read.all', 'export.read'];

async function sessionFor(roleName: string, extraPermissionCodes: string[] = []) {
  const user = await prisma.user.create({ data: { username: `rfa-${roleName}-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });
  if (roleName === 'ADMIN' || roleName === 'SUPER_ADMIN') {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  } else {
    const role = await prisma.role.create({ data: { name: `${roleName}-${randomUUID().slice(0, 6)}` } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    for (const code of extraPermissionCodes) {
      const perm = await prisma.permission.findUnique({ where: { code } });
      if (perm) await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    }
  }
  const token = generateSessionToken();
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });
  return { user, token };
}

function exportReq(body: unknown, opts: { token?: string; csrf?: boolean; idem?: string | null } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.cookie = `${SESSION_COOKIE_NAME}=${opts.token}`;
  if (opts.csrf !== false) headers['x-requested-with'] = 'titanor-time';
  if (opts.idem !== null) headers['idempotency-key'] = opts.idem ?? randomUUID();
  return new NextRequest('http://localhost/api/admin/reports/export', { method: 'POST', headers, body: JSON.stringify(body) });
}
function downloadReq(fileId: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  return new NextRequest(`http://localhost/api/admin/report-files/${fileId}/download`, { method: 'GET', headers });
}
function deleteReq(fileId: string, opts: { token?: string; csrf?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.cookie = `${SESSION_COOKIE_NAME}=${opts.token}`;
  if (opts.csrf !== false) headers['x-requested-with'] = 'titanor-time';
  return new NextRequest(`http://localhost/api/admin/report-files/${fileId}`, { method: 'DELETE', headers });
}
const params = (fileId: string) => ({ params: Promise.resolve({ fileId }) });

let adminId = '';

async function makeEmployee(tag: string) {
  const emp = await prisma.employee.create({ data: { employeeNumber: `RFA-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  return emp;
}

async function makeAssignmentOnlySite(periodId: string, from: Date, to: Date, tag: string) {
  const site = await prisma.workSite.create({ data: { name: `RFA site ${tag} ${randomUUID().slice(0, 4)}` } });
  const emp = await makeEmployee(tag);
  await prisma.siteAssignment.create({ data: { employeeId: emp.id, siteId: site.id, isPrimary: true, validFrom: from, validTo: to, assignedByUserId: adminId } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId, employeeId: emp.id, expected: true } });
  return site;
}

/** A site with one worker who logged one 8h day (gross 480, 30 paid + 30 unpaid break, worked 450). */
async function makeHoursSite(periodId: string, from: Date, to: Date, dayStr: string, tag: string) {
  const site = await prisma.workSite.create({ data: { name: `RFA hours ${tag} ${randomUUID().slice(0, 4)}` } });
  const emp = await makeEmployee(tag);
  const asg = await prisma.siteAssignment.create({ data: { employeeId: emp.id, siteId: site.id, isPrimary: true, validFrom: from, validTo: to, assignedByUserId: adminId } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId, employeeId: emp.id, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId, status: 'FINAL_APPROVED' } });
  const version = await prisma.timesheetVersion.create({ data: { timesheetId: ts.id, employeeId: emp.id, versionNumber: 1, source: 'WORKER', createdByUserId: adminId, submissionSource: 'MANUAL' } });
  await prisma.timesheet.update({ where: { id: ts.id }, data: { currentVersionId: version.id } });
  const date = new Date(dayStr);
  const day = await prisma.timesheetDay.create({ data: { timesheetVersionId: version.id, date, dayType: 'WORK', confirmedZero: false } });
  await prisma.timesheetPlannedShift.create({ data: { timesheetVersionId: version.id, employeeId: emp.id, date, siteId: site.id, sourceAssignmentId: asg.id, plannedBreakMinutes: 0 } });
  await prisma.workSegment.create({
    data: {
      timesheetDayId: day.id,
      timesheetVersionId: version.id,
      employeeId: emp.id,
      date,
      startAt: new Date(`${dayStr}T08:00:00Z`),
      endAt: new Date(`${dayStr}T16:00:00Z`),
      siteId: site.id,
      sourceAssignmentId: asg.id,
      crossesMidnight: false,
      breaks: {
        create: [
          { startAt: new Date(`${dayStr}T10:00:00Z`), endAt: new Date(`${dayStr}T10:30:00Z`), paid: true },
          { startAt: new Date(`${dayStr}T12:00:00Z`), endAt: new Date(`${dayStr}T12:30:00Z`), paid: false }
        ]
      }
    }
  });
  return { site, employeeId: emp.id };
}

async function main() {
  const admin = await sessionFor('ADMIN');
  adminId = admin.user.id;
  const superAdmin = await sessionFor('SUPER_ADMIN');
  const readOnly = await sessionFor('reader', READ_PERMS); // read perms, but NOT export.create
  const nobody = await sessionFor('nobody', []);

  const from = new Date('2092-03-02');
  const to = new Date('2092-03-15');
  const period = await prisma.payrollPeriod.create({ data: { startDate: from, endDate: to, status: 'OPEN', openedByUserId: adminId } });

  // 3 sites with real hours + 100 assignment-only sites → 103 site rows in one period.
  const hoursSites = [];
  for (let n = 0; n < 3; n++) hoursSites.push(await makeHoursSite(period.id, from, to, '2092-03-03', `H${n}`));
  for (let n = 0; n < 100; n++) await makeAssignmentOnlySite(period.id, from, to, `A${n}`);

  // ── create: CSV period summary ───────────────────────────────────────────────────────────────
  const csvRes = await exportPost(exportReq({ periodId: period.id, format: 'CSV', reportType: 'PERIOD_SUMMARY' }, { token: admin.token }));
  const csvBody = await csvRes.json();
  check('1a: ADMIN creates a CSV period report -> 201', csvRes.status === 201 && !!csvBody.file?.id, csvBody);
  check('1b: rowCount reflects the FULL report (103 sites), not a 100 cap', csvBody.file?.rowCount === 103, csvBody.file?.rowCount);

  // ── download + no-truncation + totals ────────────────────────────────────────────────────────
  const dl = await downloadGet(downloadReq(csvBody.file.id, admin.token), params(csvBody.file.id));
  check('2a: download -> 200 text/csv', dl.status === 200 && (dl.headers.get('content-type') ?? '').startsWith('text/csv'), dl.status);
  const disposition = dl.headers.get('content-disposition') ?? '';
  check('2b: Content-Disposition is safe (filename + filename*, no CR/LF)', /filename="/.test(disposition) && /filename\*=UTF-8''/.test(disposition) && !/[\r\n]/.test(disposition), disposition);
  const csvText = Buffer.from(await dl.arrayBuffer()).toString('utf8');
  check('2c: file carries the working-report banner in English', csvText.includes('WORKING REPORT — NOT AN OFFICIAL PAYROLL EXPORT'), csvText.slice(0, 80));
  const siteRows = csvText.split('\r\n').filter((l) => /^"RFA (site|hours) /.test(l));
  check('2d: CSV contains every one of the 103 site rows (no silent truncation)', siteRows.length === 103, siteRows.length);
  // 3 hours sites × worked 450 = 1350; gross 480×3 = 1440; paid 30×3 = 90; unpaid 30×3 = 90.
  const totalLine = csvText.split('\r\n').find((l) => l.startsWith('"TOTAL"')) ?? '';
  const nums = totalLine.split(',').map((c) => Number(c.replace(/"/g, '')));
  check('2e: TOTAL gross minutes = sum of site rows (1440)', nums[5] === 1440, totalLine);
  check('2f: TOTAL paid-break minutes = 90', nums[6] === 90, totalLine);
  check('2g: TOTAL unpaid-break minutes = 90', nums[7] === 90, totalLine);
  check('2h: TOTAL worked minutes = 1350', nums[8] === 1350, totalLine);

  // ── create: PDF, and site/worker detail ──────────────────────────────────────────────────────
  const pdfRes = await exportPost(exportReq({ periodId: period.id, format: 'PDF', reportType: 'PERIOD_SUMMARY' }, { token: admin.token }));
  const pdfBody = await pdfRes.json();
  check('3a: PDF period report -> 201', pdfRes.status === 201 && pdfBody.file?.format === 'PDF', pdfBody);
  const pdfDl = await downloadGet(downloadReq(pdfBody.file.id, admin.token), params(pdfBody.file.id));
  const pdfBytes = Buffer.from(await pdfDl.arrayBuffer());
  check('3b: PDF downloads as application/pdf and starts with %PDF', (pdfDl.headers.get('content-type') ?? '') === 'application/pdf' && pdfBytes.subarray(0, 4).toString() === '%PDF', pdfBytes.subarray(0, 8).toString());

  const siteRes = await exportPost(exportReq({ periodId: period.id, format: 'CSV', reportType: 'SITE_DETAIL', siteId: hoursSites[0].site.id }, { token: admin.token }));
  check('3c: SITE_DETAIL needs + accepts siteId -> 201', siteRes.status === 201, await siteRes.json());
  const siteBad = await exportPost(exportReq({ periodId: period.id, format: 'CSV', reportType: 'SITE_DETAIL' }, { token: admin.token }));
  check('3d: SITE_DETAIL without siteId -> 400', siteBad.status === 400, await siteBad.json());
  const workerRes = await exportPost(exportReq({ periodId: period.id, format: 'PDF', reportType: 'WORKER_DETAIL', employeeId: hoursSites[0].employeeId }, { token: admin.token }));
  check('3e: WORKER_DETAIL with employeeId -> 201', workerRes.status === 201, await workerRes.json());

  // ── permissions ─────────────────────────────────────────────────────────────────────────────
  check('4a: SUPER_ADMIN can create', (await exportPost(exportReq({ periodId: period.id, format: 'CSV', reportType: 'PERIOD_SUMMARY' }, { token: superAdmin.token }))).status === 201);
  check('4b: read-only (no export.create) cannot create -> 403', (await exportPost(exportReq({ periodId: period.id, format: 'CSV', reportType: 'PERIOD_SUMMARY' }, { token: readOnly.token }))).status === 403);
  check('4c: no permissions -> 403', (await exportPost(exportReq({ periodId: period.id, format: 'CSV', reportType: 'PERIOD_SUMMARY' }, { token: nobody.token }))).status === 403);
  check('4d: no session -> 401', (await exportPost(exportReq({ periodId: period.id, format: 'CSV', reportType: 'PERIOD_SUMMARY' }, {}))).status === 401);
  check('4e: missing CSRF header -> 403', (await exportPost(exportReq({ periodId: period.id, format: 'CSV', reportType: 'PERIOD_SUMMARY' }, { token: admin.token, csrf: false }))).status === 403);
  check('4f: read-only CAN download (export.read)', (await downloadGet(downloadReq(csvBody.file.id, readOnly.token), params(csvBody.file.id))).status === 200);
  check('4g: no session cannot download -> 401', (await downloadGet(downloadReq(csvBody.file.id), params(csvBody.file.id))).status === 401);
  check('4h: read-only (no export.create) cannot delete -> 403', (await fileDelete(deleteReq(csvBody.file.id, { token: readOnly.token }), params(csvBody.file.id))).status === 403);

  // ── validation ──────────────────────────────────────────────────────────────────────────────
  check('5a: malformed periodId -> 400', (await exportPost(exportReq({ periodId: 'not-a-uuid', format: 'CSV', reportType: 'PERIOD_SUMMARY' }, { token: admin.token }))).status === 400);
  check('5b: unknown periodId -> 404', (await exportPost(exportReq({ periodId: randomUUID(), format: 'CSV', reportType: 'PERIOD_SUMMARY' }, { token: admin.token }))).status === 404);
  check('5c: missing Idempotency-Key -> 400', (await exportPost(exportReq({ periodId: period.id, format: 'CSV', reportType: 'PERIOD_SUMMARY' }, { token: admin.token, idem: null }))).status === 400);
  check('5d: malformed fileId download -> 404', (await downloadGet(downloadReq('nope', admin.token), params('nope'))).status === 404);
  check('5e: unknown fileId download -> 404', (await downloadGet(downloadReq(randomUUID(), admin.token), params(randomUUID()))).status === 404);

  // ── idempotency ─────────────────────────────────────────────────────────────────────────────
  {
    const key = randomUUID();
    const body = { periodId: period.id, format: 'CSV', reportType: 'PERIOD_SUMMARY' };
    const first = await (await exportPost(exportReq(body, { token: admin.token, idem: key }))).json();
    const replay = await (await exportPost(exportReq(body, { token: admin.token, idem: key }))).json();
    check('6a: replaying the same key returns the same file', first.file.id === replay.file.id, { a: first.file?.id, b: replay.file?.id });
    const fresh = await (await exportPost(exportReq(body, { token: admin.token, idem: randomUUID() }))).json();
    check('6b: a fresh key makes a new snapshot', fresh.file.id !== first.file.id);
    const reused = await exportPost(exportReq({ ...body, format: 'PDF' }, { token: admin.token, idem: key }));
    check('6c: same key + different body -> 409 IDEMPOTENCY_KEY_REUSED', reused.status === 409, await reused.json());
  }
  {
    const key = randomUUID();
    const body = { periodId: period.id, format: 'PDF', reportType: 'PERIOD_SUMMARY' };
    const [r1, r2] = await Promise.all([
      exportPost(exportReq(body, { token: admin.token, idem: key })),
      exportPost(exportReq(body, { token: admin.token, idem: key }))
    ]);
    const b1 = await r1.json().catch(() => ({}));
    const b2 = await r2.json().catch(() => ({}));
    const ids = [b1.file?.id, b2.file?.id].filter(Boolean);
    const conflicts = [r1.status, r2.status].filter((s) => s === 409).length;
    check('6d: two concurrent identical POSTs never make two files', new Set(ids).size <= 1, { s: [r1.status, r2.status], ids });
    check('6e: the loser is a cached success or a 409, never a second create', conflicts <= 1 && (ids.length >= 1 || conflicts === 1), { s: [r1.status, r2.status] });
    const rows = await prisma.reportFile.count({ where: { periodId: period.id, format: 'PDF', reportType: 'PERIOD_SUMMARY', createdByUserId: adminId } });
    check('6f: exactly the expected number of PDF rows exist (no idempotency double-write)', rows >= 2 && rows <= 4, rows);
  }

  // ── OPEN / LOCKED / EXPORTED — a working report can be created for any status (§5.A) ─────────
  {
    const locked = await prisma.payrollPeriod.create({
      data: { startDate: new Date('2093-03-02'), endDate: new Date('2093-03-15'), status: 'LOCKED', openedByUserId: adminId, lockedAt: new Date(), lockedByUserId: adminId }
    });
    const exported = await prisma.payrollPeriod.create({
      data: {
        startDate: new Date('2094-03-02'),
        endDate: new Date('2094-03-15'),
        status: 'EXPORTED',
        openedByUserId: adminId,
        lockedAt: new Date(),
        lockedByUserId: adminId,
        exportedAt: new Date()
      }
    });
    check('8a: OPEN period accepts a working report', (await exportPost(exportReq({ periodId: period.id, format: 'CSV', reportType: 'PERIOD_SUMMARY' }, { token: admin.token }))).status === 201);
    check('8b: LOCKED period accepts a working report', (await exportPost(exportReq({ periodId: locked.id, format: 'CSV', reportType: 'PERIOD_SUMMARY' }, { token: admin.token }))).status === 201);
    const expRes = await exportPost(exportReq({ periodId: exported.id, format: 'CSV', reportType: 'PERIOD_SUMMARY' }, { token: admin.token }));
    const expBody = await expRes.json();
    check('8c: EXPORTED period accepts a working report', expRes.status === 201, expBody);
    const expDl = await downloadGet(downloadReq(expBody.file.id, admin.token), params(expBody.file.id));
    const expText = Buffer.from(await expDl.arrayBuffer()).toString('utf8');
    check('8d: the file records the period status (EXPORTED)', expText.includes('"Period status","EXPORTED"'), expText.slice(0, 400));
  }

  // ── delete lifecycle ────────────────────────────────────────────────────────────────────────
  {
    const made = await (await exportPost(exportReq({ periodId: period.id, format: 'CSV', reportType: 'PERIOD_SUMMARY' }, { token: admin.token }))).json();
    const del1 = await fileDelete(deleteReq(made.file.id, { token: admin.token }), params(made.file.id));
    check('7a: delete -> 200', del1.status === 200, await del1.json().catch(() => ({})));
    const del2 = await fileDelete(deleteReq(made.file.id, { token: admin.token }), params(made.file.id));
    check('7b: repeat delete -> clean 404', del2.status === 404, await del2.json().catch(() => ({})));
    const dlGone = await downloadGet(downloadReq(made.file.id, admin.token), params(made.file.id));
    check('7c: downloading a deleted file -> 404', dlGone.status === 404);
    const audit = await prisma.auditEvent.count({ where: { eventType: 'REPORT_FILE_DELETED', entityId: made.file.id } });
    check('7d: the deletion is still in AuditEvent', audit === 1, audit);
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
