import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { requestCorrection, openCorrectionDraft, patchCorrectionDraftDay, submitCorrection, decideCorrection } from '../lib/corrections';
import { createExportBatch, buildCsvV1Content, sanitizeHumanTextCell, CSV_V1_COLUMNS } from '../lib/csv-export';

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4B" — permanent regression for immutable CSV
// generation, export APIs, and download. Scenario letters/numbers below match the task's own A-F /
// 1-58 list. Real HTTP against the four T8.4B endpoints (server started separately, TEST_BASE_URL),
// plus direct DB/Prisma assertions for schema invariants and concurrency evidence that HTTP alone
// cannot prove (distinct backend PIDs, rollback-leaves-nothing).

const BASE = process.env.TEST_BASE_URL || 'http://localhost:39610';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra, (k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 900) : '');
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ============================================================================
// Fixtures
// ============================================================================

async function makeUserWithRole(tag: string, roleName: string) {
  const user = await prisma.user.create({ data: { username: `${roleName.toLowerCase()}-${tag}-${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN' } });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const token = randomBytes(32).toString('base64url');
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) } });
  return { user, token };
}

async function makeCustomRoleUser(tag: string, permissionCodes: string[]) {
  const role = await prisma.role.create({ data: { name: `T84B_${randomUUID().slice(0, 20)}` } });
  const grants: { code: string; rolePermissionId: string }[] = [];
  for (const code of permissionCodes) {
    const perm = await prisma.permission.findUniqueOrThrow({ where: { code } });
    const rp = await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    grants.push({ code, rolePermissionId: rp.id });
  }
  const user = await prisma.user.create({ data: { username: `custom-${tag}-${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN' } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const token = randomBytes(32).toString('base64url');
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) } });
  return { user, token, grants };
}

async function revokeGrant(rolePermissionId: string) {
  await prisma.rolePermission.delete({ where: { id: rolePermissionId } });
}

let fixtureAdmin: { id: string };
async function ensureAdminUser() {
  if (fixtureAdmin) return fixtureAdmin;
  const { user } = await makeUserWithRole('fixture', 'ADMIN');
  fixtureAdmin = user;
  return user;
}

async function makeEmployee(tag: string, overrides: { employeeNumber?: string; firstName?: string; lastName?: string; phone?: string } = {}) {
  const emp = await prisma.employee.create({
    data: {
      employeeNumber: overrides.employeeNumber ?? `TEST-T84B-${tag}-${randomUUID().slice(0, 8)}`,
      firstName: overrides.firstName ?? tag,
      lastName: overrides.lastName ?? 'Worker',
      phone: overrides.phone
    }
  });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  return emp;
}

async function makeSite(tag: string, overrides: { name?: string } = {}) {
  return prisma.workSite.create({ data: { name: overrides.name ?? `T84B Site ${tag} ${randomUUID().slice(0, 4)}` } });
}

// Migration 100 (ex_site_assignment_one_primary_per_period) forbids two overlapping isPrimary rows
// for one worker. This export test reads segments, not primary-ness, so a worker on two sites at
// once gets ONE primary and the concurrent second is non-primary.
async function makeAssignment(employeeId: string, siteId: string, validFrom: Date, validTo: Date | null, isPrimary = true) {
  const admin = await ensureAdminUser();
  return prisma.siteAssignment.create({ data: { employeeId, siteId, isPrimary, validFrom, validTo, assignedByUserId: admin.id } });
}

async function makePeriod(startDate: Date, endDate: Date, status: 'OPEN' | 'LOCKED' | 'EXPORTED' = 'OPEN') {
  const admin = await ensureAdminUser();
  const period = await prisma.payrollPeriod.create({ data: { startDate, endDate, status: 'OPEN', openedByUserId: admin.id } });
  if (status === 'LOCKED' || status === 'EXPORTED') {
    await prisma.payrollPeriod.update({ where: { id: period.id }, data: { status: 'LOCKED', lockedAt: new Date(), lockedByUserId: admin.id } });
  }
  if (status === 'EXPORTED') {
    await prisma.payrollPeriod.update({ where: { id: period.id }, data: { status: 'EXPORTED', exportedAt: new Date() } });
  }
  return prisma.payrollPeriod.findUniqueOrThrow({ where: { id: period.id } });
}

async function makeParticipant(periodId: string, employeeId: string, expected = true) {
  if (expected) {
    return prisma.payrollPeriodParticipant.create({ data: { periodId, employeeId, expected: true } });
  }
  const admin = await ensureAdminUser();
  return prisma.payrollPeriodParticipant.create({ data: { periodId, employeeId, expected: false, exclusionReason: 'test exclusion', excludedByUserId: admin.id, excludedAt: new Date() } });
}

interface BreakInput {
  startAt: Date;
  endAt: Date;
  paid: boolean;
}

const versionDayCache = new Map<string, { id: string }>();
async function ensureVersionDay(versionId: string, date: Date) {
  const key = `${versionId}:${date.toISOString().slice(0, 10)}`;
  const cached = versionDayCache.get(key);
  if (cached) return cached;
  const day = await prisma.timesheetDay.create({ data: { timesheetVersionId: versionId, date, dayType: 'WORK', confirmedZero: false } });
  versionDayCache.set(key, day);
  return day;
}
const versionPlanCache = new Map<string, { id: string }>();
async function ensureVersionPlannedShift(versionId: string, employeeId: string, date: Date, siteId: string, sourceAssignmentId: string) {
  const key = `${versionId}:${date.toISOString().slice(0, 10)}:${sourceAssignmentId}`;
  const cached = versionPlanCache.get(key);
  if (cached) return cached;
  const ps = await prisma.timesheetPlannedShift.create({ data: { timesheetVersionId: versionId, employeeId, date, siteId, sourceAssignmentId, plannedBreakMinutes: 0 } });
  versionPlanCache.set(key, ps);
  return ps;
}
async function addVersionSegment(version: { id: string }, employeeId: string, siteId: string, sourceAssignmentId: string, date: Date, startAt: Date, endAt: Date, breaks: BreakInput[] = []) {
  const day = await ensureVersionDay(version.id, date);
  await ensureVersionPlannedShift(version.id, employeeId, date, siteId, sourceAssignmentId);
  const seg = await prisma.workSegment.create({ data: { timesheetDayId: day.id, timesheetVersionId: version.id, employeeId, date, startAt, endAt, siteId, sourceAssignmentId, crossesMidnight: false } });
  for (const b of breaks) {
    await prisma.breakSegment.create({ data: { workSegmentId: seg.id, startAt: b.startAt, endAt: b.endAt, paid: b.paid } });
  }
  return seg;
}

/** One Employee + PayrollPeriodParticipant + one SiteAssignment (already valid over `period`) + one
 * FINAL_APPROVED Timesheet + TimesheetVersion — everything an expected (or, with `expected: false`,
 * excluded) participant needs. Participant must exist BEFORE the Timesheet — Timesheet(periodId,
 * employeeId) has a composite FK to PayrollPeriodParticipant(periodId, employeeId). Caller adds
 * segments separately (or none, for a zero-hour worker). */
async function makeFinalApprovedWorker(
  tag: string,
  siteId: string,
  period: { id: string; startDate: Date; endDate: Date },
  overrides: { employeeNumber?: string; firstName?: string; lastName?: string; phone?: string; expected?: boolean } = {}
) {
  const admin = await ensureAdminUser();
  const emp = await makeEmployee(tag, overrides);
  const asg = await makeAssignment(emp.id, siteId, period.startDate, period.endDate);
  await makeParticipant(period.id, emp.id, overrides.expected ?? true);
  const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'FINAL_APPROVED' } });
  const version = await prisma.timesheetVersion.create({ data: { timesheetId: ts.id, employeeId: emp.id, versionNumber: 1, source: 'WORKER', createdByUserId: admin.id, submissionSource: 'MANUAL' } });
  await prisma.timesheet.update({ where: { id: ts.id }, data: { currentVersionId: version.id } });
  return { employee: emp, assignment: asg, timesheet: ts, version };
}

/** Full requestCorrection -> openCorrectionDraft -> patchCorrectionDraftDay -> submitCorrection -> decideCorrection(APPROVED) pipeline, via direct lib calls (not HTTP — this is a fixture step, not the thing under test). `segments: null` means "submit a day with zero segments" (used to test bucket deletion, item 28). */
async function makeApprovedCorrection(
  timesheetId: string,
  requesterUserId: string,
  deciderUserId: string,
  date: Date,
  segments: { siteId: string; startAt: Date; endAt: Date; breaks?: BreakInput[] }[] | null
) {
  const req = await requestCorrection(timesheetId, requesterUserId, 'test correction', randomUUID());
  if ('code' in req) throw new Error(`requestCorrection failed: ${JSON.stringify(req)}`);
  const open = await openCorrectionDraft(req.id, requesterUserId, randomUUID());
  if ('code' in open) throw new Error(`openCorrectionDraft failed: ${JSON.stringify(open)}`);
  const patch = await patchCorrectionDraftDay(req.id, date, {
    segments: (segments ?? []).map((s) => ({ startAt: s.startAt, endAt: s.endAt, siteId: s.siteId, workAreaId: null, breaks: (s.breaks ?? []).map((b) => ({ startAt: b.startAt, endAt: b.endAt, paid: b.paid })) }))
  });
  if ('code' in patch) throw new Error(`patchCorrectionDraftDay failed: ${JSON.stringify(patch)}`);
  const submit = await submitCorrection(req.id, randomUUID());
  if ('code' in submit) throw new Error(`submitCorrection failed: ${JSON.stringify(submit)}`);
  const decide = await decideCorrection(req.id, 'APPROVED', deciderUserId, false, null, randomUUID());
  if ('code' in decide) throw new Error(`decideCorrection failed: ${JSON.stringify(decide)}`);
  return { correctionRequestId: req.id, resultingVersionId: decide.resultingVersionId! };
}

// ============================================================================
// HTTP helpers
// ============================================================================

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function postExport(periodId: string, token: string, opts: { idempotencyKey?: string | null; csrf?: boolean; body?: string; skipAuth?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (!opts.skipAuth) headers.cookie = `tt_session=${token}`;
  if (opts.csrf !== false) headers['x-requested-with'] = 'titanor-time';
  if (opts.idempotencyKey !== null) headers['idempotency-key'] = opts.idempotencyKey ?? randomUUID();
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}/api/admin/periods/${periodId}/export`, { method: 'POST', headers, body: opts.body });
  return { status: res.status, body: await safeJson(res), res };
}

async function getExportList(token: string, query = '') {
  const res = await fetch(`${BASE}/api/admin/export-batches${query ? '?' + query : ''}`, { headers: { cookie: `tt_session=${token}` } });
  return { status: res.status, body: await safeJson(res) };
}

async function getExportDetail(batchId: string, token: string, query = '') {
  const res = await fetch(`${BASE}/api/admin/export-batches/${batchId}${query ? '?' + query : ''}`, { headers: { cookie: `tt_session=${token}` } });
  return { status: res.status, body: await safeJson(res) };
}

async function getExportDownload(batchId: string, token: string) {
  const res = await fetch(`${BASE}/api/admin/export-batches/${batchId}/download`, { headers: { cookie: `tt_session=${token}` } });
  const buffer = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buffer };
}

async function getSiteReport(siteId: string, periodId: string, token: string) {
  const res = await fetch(`${BASE}/api/admin/reports/sites/${siteId}?periodId=${periodId}&pageSize=100`, { headers: { cookie: `tt_session=${token}` } });
  return { status: res.status, body: await safeJson(res) };
}

// ============================================================================
// CSV parsing (RFC 4180, for asserting byte-contract details on real downloaded content)
// ============================================================================

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 2;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvRowsAsObjects(rows: string[][]): Record<string, string>[] {
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

/** True if the text contains a `\n` that is not part of a `\r\n` pair AND is not inside a quoted field — i.e. a structural row separator that isn't CRLF. */
function hasBareLineFeedOutsideQuotes(text: string): boolean {
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') {
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && c === '\n' && text[i - 1] !== '\r') {
      return true;
    }
  }
  return false;
}

async function expectReject(name: string, fn: () => Promise<unknown>, identifierOrCode: string | string[]) {
  const identifiers = Array.isArray(identifierOrCode) ? identifierOrCode : [identifierOrCode];
  try {
    await fn();
    check(name, false, 'expected rejection, got success');
  } catch (err) {
    const anyErr = err as { message?: string; code?: string; meta?: unknown };
    const message = err instanceof Error ? err.message : String(err);
    const found = identifiers.some((id) => message.includes(id) || (typeof anyErr.code === 'string' && anyErr.code === id) || JSON.stringify(anyErr.meta ?? {}).includes(id));
    check(name, found, { code: anyErr.code, meta: anyErr.meta, message: message.slice(-400) });
  }
}

// Randomized per-process anchor (not a fixed 2021-01-01 base) — this script is re-run repeatedly
// against the same disposable database while iterating, and EX-03 (ex_payroll_period_date_overlap)
// is a company-wide exclusion constraint across ALL periods ever created, from ANY previous run.
const PERIOD_ANCHOR_DAYS = 1000 + Math.floor(Math.random() * 50000);
function nonOverlappingPeriodDates(slot: number): { startDate: Date; endDate: Date } {
  const start = new Date(Date.UTC(2000, 0, 1) + (PERIOD_ANCHOR_DAYS + slot * 20) * 86400000);
  const end = new Date(start.getTime() + 6 * 86400000);
  return { startDate: start, endDate: end };
}
let periodSlot = 0;
function nextPeriodDates() {
  periodSlot += 1;
  return nonOverlappingPeriodDates(periodSlot);
}

async function main() {
  const admin = await makeUserWithRole('admin', 'ADMIN');
  const admin2 = await makeUserWithRole('admin2', 'ADMIN');
  const superAdmin = await makeUserWithRole('sa', 'SUPER_ADMIN');
  const worker = await makeUserWithRole('worker', 'WORKER');
  const foreman = await makeUserWithRole('foreman', 'FOREMAN');

  // ============================================================================
  // A. FULL export
  // ============================================================================

  // --- A1: permission combinations ---
  {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');

    const rWorker = await postExport(period.id, worker.token);
    check('A1: WORKER denied (403)', rWorker.status === 403, rWorker.body);

    const rForeman = await postExport(period.id, foreman.token);
    check('A1: FOREMAN denied (403)', rForeman.status === 403, rForeman.body);

    // export.create only, missing period.export
    const partial1 = await makeCustomRoleUser('partial1', ['export.create']);
    const rPartial1 = await postExport(period.id, partial1.token);
    check('A1: export.create alone denied (403)', rPartial1.status === 403, rPartial1.body);

    // period.export only, missing export.create
    const partial2 = await makeCustomRoleUser('partial2', ['period.export']);
    const rPartial2 = await postExport(period.id, partial2.token);
    check('A1: period.export alone denied (403)', rPartial2.status === 403, rPartial2.body);

    // both — succeeds
    const both = await makeCustomRoleUser('both', ['period.export', 'export.create']);
    const rBoth = await postExport(period.id, both.token);
    check('A1: both permissions together succeeds (201)', rBoth.status === 201, rBoth.body);

    // revoking either blocks the next request (checked later against a fresh period, §51)
  }

  // --- A2: malformed / missing period ---
  {
    const rMalformed = await postExport('not-a-uuid', admin.token);
    check('A2: malformed periodId -> 400 VALIDATION_ERROR', rMalformed.status === 400 && rMalformed.body?.error?.code === 'VALIDATION_ERROR', rMalformed.body);

    const rMissing = await postExport(randomUUID(), admin.token);
    check('A2: nonexistent periodId -> 404 PERIOD_NOT_FOUND', rMissing.status === 404 && rMissing.body?.error?.code === 'PERIOD_NOT_FOUND', rMissing.body);
  }

  // --- A3: OPEN rejected ---
  {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'OPEN');
    const r = await postExport(period.id, admin.token);
    check('A3: OPEN period -> 409 PERIOD_NOT_EXPORTABLE', r.status === 409 && r.body?.error?.code === 'PERIOD_NOT_EXPORTABLE', r.body);
  }

  // --- A4-A12, B (exact CSV), plus reconciliation: one rich shared fixture ---
  let mainFixture: {
    period: Awaited<ReturnType<typeof makePeriod>>;
    siteX: Awaited<ReturnType<typeof makeSite>>;
    siteY: Awaited<ReturnType<typeof makeSite>>;
    empA: Awaited<ReturnType<typeof makeFinalApprovedWorker>>;
    empB: Awaited<ReturnType<typeof makeFinalApprovedWorker>>;
    empExcluded: Awaited<ReturnType<typeof makeFinalApprovedWorker>>;
    batch: any;
    dateA1: Date;
    dateA2: Date;
    dateB: Date;
  };
  {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');
    const siteX = await makeSite('X');
    const siteY = await makeSite('Y');

    const dateA1 = new Date(startDate);
    const dateA2 = new Date(startDate.getTime() + 86400000);
    const dateB = new Date(startDate);

    // empA — two days at siteX (multi-day, single site)
    const empA = await makeFinalApprovedWorker('A', siteX.id, period);
    await addVersionSegment(empA.version, empA.employee.id, siteX.id, empA.assignment.id, dateA1, new Date(dateA1.getTime() + 8 * 3600000), new Date(dateA1.getTime() + 16 * 3600000));
    await addVersionSegment(empA.version, empA.employee.id, siteX.id, empA.assignment.id, dateA2, new Date(dateA2.getTime() + 9 * 3600000), new Date(dateA2.getTime() + 17 * 3600000), [
      { startAt: new Date(dateA2.getTime() + 12 * 3600000), endAt: new Date(dateA2.getTime() + 12.5 * 3600000), paid: true }
    ]);

    // empB — assigned+worked at both siteX and siteY same day (multi-site bucket split).
    // siteX assignment (from makeFinalApprovedWorker) is the primary; the concurrent siteY one is not.
    const empB = await makeFinalApprovedWorker('B', siteX.id, period);
    await makeAssignment(empB.employee.id, siteY.id, period.startDate, period.endDate, false);
    await addVersionSegment(empB.version, empB.employee.id, siteX.id, empB.assignment.id, dateB, new Date(dateB.getTime() + 6 * 3600000), new Date(dateB.getTime() + 10 * 3600000));
    const empBSiteYAssignment = await prisma.siteAssignment.findFirstOrThrow({ where: { employeeId: empB.employee.id, siteId: siteY.id } });
    await addVersionSegment(empB.version, empB.employee.id, siteY.id, empBSiteYAssignment.id, dateB, new Date(dateB.getTime() + 11 * 3600000), new Date(dateB.getTime() + 15 * 3600000), [
      { startAt: new Date(dateB.getTime() + 12.9 * 3600000), endAt: new Date(dateB.getTime() + 13 * 3600000), paid: false }
    ]);

    // excluded participant with real segments — must never appear (A7): the schema's own
    // Timesheet(periodId, employeeId) -> PayrollPeriodParticipant(periodId, employeeId) FK means a
    // Timesheet can never exist without SOME participant row, so "non-participant historical-only"
    // is not a reachable state to test separately — expected=false is the only real edge case here.
    const empExcluded = await makeFinalApprovedWorker('Excl', siteX.id, period, { expected: false });
    await addVersionSegment(empExcluded.version, empExcluded.employee.id, siteX.id, empExcluded.assignment.id, dateA1, new Date(dateA1.getTime() + 8 * 3600000), new Date(dateA1.getTime() + 12 * 3600000));

    const r = await postExport(period.id, admin.token);
    check('A4: LOCKED period creates FULL batch (201)', r.status === 201 && r.body?.batch?.kind === 'FULL', r.body);
    check('A4: exactly one FULL batch (only one from this call)', r.body?.batch?.correctsBatchId === null, r.body);

    const freshPeriod = await prisma.payrollPeriod.findUniqueOrThrow({ where: { id: period.id } });
    check('A5: period becomes EXPORTED atomically', freshPeriod.status === 'EXPORTED' && freshPeriod.exportedAt !== null, freshPeriod);
    check('A5: response period.status/exportedAt match DB', r.body?.period?.status === 'EXPORTED' && r.body?.period?.exportedAt === freshPeriod.exportedAt!.toISOString(), { response: r.body?.period, db: freshPeriod });

    const items = await prisma.exportItem.findMany({ where: { exportBatchId: r.body.batch.id } });
    check('A6: all expected FINAL_APPROVED current versions used', items.every((i) => i.timesheetVersionId === empA.version.id || i.timesheetVersionId === empB.version.id), items);
    check('A7: excluded participant not in ExportItem', !items.some((i) => i.employeeId === empExcluded.employee.id), items);
    check('A9: multi-worker/site/day buckets — 4 ExportItem rows (empA x2 days, empB x2 sites)', items.length === 4, items.length);
    check('A9: empA two distinct dates present', items.filter((i) => i.employeeId === empA.employee.id).length === 2, items);
    check('A9: empB two distinct sites present', new Set(items.filter((i) => i.employeeId === empB.employee.id).map((i) => i.siteId)).size === 2, items);

    // A10: paid break stays inside worked; unpaid subtracted — empA day2 (9h gross, 30min paid break)
    const empADay2 = items.find((i) => i.employeeId === empA.employee.id && i.date.getTime() === dateA2.getTime())!;
    check('A10: paid break included in worked minutes (canonical formula)', empADay2.grossMinutes === 480 && empADay2.paidBreakMinutes === 30 && empADay2.unpaidBreakMinutes === 0 && empADay2.workedMinutes === 480, empADay2);
    const empBSiteY = items.find((i) => i.employeeId === empB.employee.id && i.siteId === siteY.id)!;
    check('A10: unpaid break subtracted from worked minutes', empBSiteY.grossMinutes === 240 && empBSiteY.unpaidBreakMinutes === 6 && empBSiteY.workedMinutes === 234, empBSiteY);

    // A11: ExportItem equals downloaded CSV row, cell by cell.
    const dl = await getExportDownload(r.body.batch.id, admin.token);
    const text = dl.buffer.toString('utf8');
    const hasBom = dl.buffer[0] === 0xef && dl.buffer[1] === 0xbb && dl.buffer[2] === 0xbf;
    const withoutBom = hasBom ? text.slice(1) : text;
    const rows = csvRowsAsObjects(parseCsv(withoutBom));
    check('A11: CSV row count equals ExportItem count', rows.length === items.length, { csv: rows.length, db: items.length });
    for (const item of items) {
      const row = rows.find((rr) => rr.employee_id === item.employeeId && rr.site_id === item.siteId && rr.date === item.date.toISOString().slice(0, 10));
      check(
        `A11: CSV row matches ExportItem for ${item.employeeId}/${item.siteId}/${item.date.toISOString().slice(0, 10)}`,
        !!row &&
          Number(row.gross_minutes) === item.grossMinutes &&
          Number(row.paid_break_minutes) === item.paidBreakMinutes &&
          Number(row.unpaid_break_minutes) === item.unpaidBreakMinutes &&
          Number(row.worked_minutes) === item.workedMinutes &&
          Number(row.segment_count) === item.segmentCount &&
          row.employee_number === item.employeeNumberSnapshot &&
          row.employee_name === item.employeeNameSnapshot &&
          row.site_name === item.siteNameSnapshot &&
          row.timesheet_version_id === item.timesheetVersionId,
        { row, item }
      );
    }

    // A12: reconciliation with T8.2 (site report) for the same included buckets.
    const siteXReport = await getSiteReport(siteX.id, period.id, admin.token);
    const empADay1Bucket = siteXReport.body?.items?.find((it: any) => it.employee.id === empA.employee.id)?.days?.find((d: any) => d.date === dateA1.toISOString().slice(0, 10));
    const csvEmpADay1 = items.find((i) => i.employeeId === empA.employee.id && i.date.getTime() === dateA1.getTime())!;
    check(
      'A12: CSV bucket reconciles with T8.2 site report bucket',
      !!empADay1Bucket &&
        empADay1Bucket.grossMinutes === csvEmpADay1.grossMinutes &&
        empADay1Bucket.workedMinutes === csvEmpADay1.workedMinutes &&
        empADay1Bucket.paidBreakMinutes === csvEmpADay1.paidBreakMinutes &&
        empADay1Bucket.unpaidBreakMinutes === csvEmpADay1.unpaidBreakMinutes,
      { t82: empADay1Bucket, csv: csvEmpADay1 }
    );

    mainFixture = { period: freshPeriod, siteX, siteY, empA, empB, empExcluded, batch: r.body.batch, dateA1, dateA2, dateB };
  }

  // --- A8: zero-hour period (zero expected participants) -> header-only CSV ---
  {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');
    const r = await postExport(period.id, admin.token);
    check('A8: zero-expected-participant LOCKED period still creates a batch (201)', r.status === 201, r.body);
    check('A8: rowCount = 0', r.body?.batch?.rowCount === 0, r.body);
    const items = await prisma.exportItem.count({ where: { exportBatchId: r.body.batch.id } });
    check('A8: zero ExportItem rows', items === 0, items);

    const dl = await getExportDownload(r.body.batch.id, admin.token);
    const hasBom = dl.buffer[0] === 0xef && dl.buffer[1] === 0xbb && dl.buffer[2] === 0xbf;
    const text = (hasBom ? dl.buffer.slice(3) : dl.buffer).toString('utf8');
    const expectedHeader = CSV_V1_COLUMNS.map((c) => `"${c}"`).join(',') + '\r\n';
    check('A8: content = BOM + header + CRLF, nothing else', hasBom && text === expectedHeader, { hasBom, text });
  }

  // ============================================================================
  // B. Exact CSV byte contract
  // ============================================================================

  // --- B13-16, B20-21: from the mainFixture batch already downloaded above ---
  {
    const dl = await getExportDownload(mainFixture.batch.id, admin.token);
    check('B13: BOM present (EF BB BF)', dl.buffer[0] === 0xef && dl.buffer[1] === 0xbb && dl.buffer[2] === 0xbf, [...dl.buffer.slice(0, 3)]);

    const text = dl.buffer.slice(3).toString('utf8');
    const lines = text.split('\r\n');
    check('B15: every line CRLF-terminated (split on \\r\\n leaves exactly one trailing empty element)', lines[lines.length - 1] === '', lines.slice(-2));
    check('B15: no bare LF outside a quoted field anywhere in the file (CRLF-only structural row breaks)', !hasBareLineFeedOutsideQuotes(text), null);

    const headerLine = lines[0];
    const expectedHeader = CSV_V1_COLUMNS.map((c) => `"${c}"`).join(',');
    check('B14: exact header, exact column order', headerLine === expectedHeader, { got: headerLine, expected: expectedHeader });

    const parsedRows = parseCsv(text);
    check('B16: deterministic row order (employeeNumber, employeeId, date, siteName, siteId)', (() => {
      const dataRows = parsedRows.slice(1);
      const keys = dataRows.map((r) => [r[6], r[5], r[10], r[9], r[8]]);
      const sorted = [...keys].sort((a, b) => {
        for (let i = 0; i < 5; i++) {
          if (a[i] < b[i]) return -1;
          if (a[i] > b[i]) return 1;
        }
        return 0;
      });
      return JSON.stringify(keys) === JSON.stringify(sorted);
    })(), parsedRows.slice(1).map((r) => [r[6], r[5], r[10], r[9], r[8]]));

    check('B20: fileHash = lowercase SHA-256 of exact stored bytes', mainFixture.batch.fileHash === createHash('sha256').update(dl.buffer).digest('hex'), mainFixture.batch.fileHash);
    check('B20: fileHash is 64 lowercase hex chars', /^[0-9a-f]{64}$/.test(mainFixture.batch.fileHash), mainFixture.batch.fileHash);
    check('B20: fileSizeBytes = exact byte length (not JS string length)', mainFixture.batch.fileSizeBytes === dl.buffer.byteLength, { reported: mainFixture.batch.fileSizeBytes, actual: dl.buffer.byteLength });
    check('B21: deterministic filename pattern', new RegExp(`^titanor-time_${mainFixture.period.startDate.toISOString().slice(0, 10)}_${mainFixture.period.endDate.toISOString().slice(0, 10)}_full_${mainFixture.batch.id}\\.csv$`).test(mainFixture.batch.fileName), mainFixture.batch.fileName);
    check('B21: filename is ASCII-only', /^[\x00-\x7f]+$/.test(mainFixture.batch.fileName), mainFixture.batch.fileName);
  }

  // --- B17-18: commas/quotes/newlines + Cyrillic/Finnish UTF-8 in a dedicated worker/site ---
  {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');
    const site = await makeSite('Special', { name: 'Site, "Quoted"\nSecond line — Ä Ö å ü' });
    const worker1 = await makeFinalApprovedWorker('Special', site.id, period, { firstName: 'Кириллица "Имя"', lastName: 'Тестов, второй' });
    const date = new Date(startDate);
    await addVersionSegment(worker1.version, worker1.employee.id, site.id, worker1.assignment.id, date, new Date(date.getTime() + 8 * 3600000), new Date(date.getTime() + 16 * 3600000));

    const r = await postExport(period.id, admin.token);
    check('B17/18: FULL export with special characters succeeds', r.status === 201, r.body);
    const dl = await getExportDownload(r.body.batch.id, admin.token);
    const text = dl.buffer.slice(3).toString('utf8');
    const rows = csvRowsAsObjects(parseCsv(text));
    const row = rows.find((rr) => rr.employee_id === worker1.employee.id)!;
    check('B17: embedded comma in site_name preserved', row.site_name.includes('Site, "Quoted"'), row.site_name);
    check('B17: doubled internal quote decodes back to a single quote', row.site_name.includes('"Quoted"'), row.site_name);
    check('B17: embedded newline in site_name preserved', row.site_name.includes('\nSecond line'), JSON.stringify(row.site_name));
    check('B17: embedded comma in employee_name preserved', row.employee_name.includes('Тестов, второй'), row.employee_name);
    check('B18: Cyrillic preserved exactly', row.employee_name.startsWith('Кириллица'), row.employee_name);
    check('B18: Finnish/extended Latin preserved exactly', row.site_name.includes('Ä Ö å ü'), row.site_name);
    // Structural CRLF-only guarantee: every raw \n byte in the file lives strictly inside a quoted
    // field (verified by successfully round-tripping through parseCsv above); the file itself uses
    // \r\n exclusively between records, never a bare \n as a record separator.
  }

  // --- B19: formula injection, one dedicated employee per trigger character, rotated across all three human-text columns ---
  {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');
    const date = new Date(startDate);

    type InjCase = { tag: string; column: 'employee_number' | 'employee_name' | 'site_name'; trigger: string; triggerLabel: string };
    const cases: InjCase[] = [
      { tag: 'Inj1', column: 'employee_number', trigger: '=1+1', triggerLabel: '=' },
      { tag: 'Inj2', column: 'employee_name', trigger: '+SUM(A1:A9)', triggerLabel: '+' },
      { tag: 'Inj3', column: 'site_name', trigger: '-2+3', triggerLabel: '-' },
      { tag: 'Inj4', column: 'employee_number', trigger: '@SUM(A1:A9)', triggerLabel: '@' },
      { tag: 'Inj5', column: 'employee_name', trigger: '\tCMD()', triggerLabel: 'tab' },
      { tag: 'Inj6', column: 'site_name', trigger: '\rCR-led', triggerLabel: 'CR' },
      { tag: 'Inj7', column: 'employee_number', trigger: '\nLF-led', triggerLabel: 'LF' }
    ];

    const built: { tag: string; column: string; trigger: string; employeeId: string }[] = [];
    for (const c of cases) {
      const uniqSuffix = randomUUID().slice(0, 8);
      const site = await makeSite(c.tag, { name: c.column === 'site_name' ? `${c.trigger}-${uniqSuffix}` : `T84B Site ${c.tag} ${uniqSuffix}` });
      const worker = await makeFinalApprovedWorker(c.tag, site.id, period, {
        employeeNumber: c.column === 'employee_number' ? `${c.trigger}-${uniqSuffix}` : undefined,
        firstName: c.column === 'employee_name' ? c.trigger : c.tag,
        lastName: c.column === 'employee_name' ? uniqSuffix : 'Worker'
      });
      await addVersionSegment(worker.version, worker.employee.id, site.id, worker.assignment.id, date, new Date(date.getTime() + 8 * 3600000), new Date(date.getTime() + 16 * 3600000));
      const storedValue = c.column === 'employee_name' ? `${c.trigger} ${uniqSuffix}` : `${c.trigger}-${uniqSuffix}`;
      built.push({ tag: c.tag, column: c.column, trigger: storedValue, employeeId: worker.employee.id });
    }

    const r = await postExport(period.id, admin.token);
    check('B19: injection-fixture FULL export succeeds', r.status === 201, r.body);
    const dl = await getExportDownload(r.body.batch.id, admin.token);
    const text = dl.buffer.slice(3).toString('utf8');
    const rows = csvRowsAsObjects(parseCsv(text));

    for (const b of built) {
      const row = rows.find((rr) => rr.employee_id === b.employeeId)!;
      const cellValue = row?.[b.column];
      check(`B19: ${b.column} trigger (${cases.find((c) => c.tag === b.tag)!.triggerLabel}) neutralized with leading apostrophe`, !!cellValue && cellValue === `'${b.trigger}`, { column: b.column, cellValue, expected: `'${b.trigger}` });
    }

    // Direct unit check of the pure function too — not only via the HTTP round trip.
    check('B19 (unit): sanitizeHumanTextCell leaves safe text untouched', sanitizeHumanTextCell('Normal Name') === 'Normal Name', sanitizeHumanTextCell('Normal Name'));
    check('B19 (unit): sanitizeHumanTextCell guards leading-space-then-trigger', sanitizeHumanTextCell('  =1+1') === "'  =1+1", sanitizeHumanTextCell('  =1+1'));
    check('B19 (unit): only the 3 human-text columns (employee_number/employee_name/site_name) are ever guarded — every other column with the same trigger content is left untouched', (() => {
      // Every one of the 17 cells is the literal same trigger string "=X" — proves by direct
      // positive+negative control that HUMAN_TEXT_COLUMN_INDICES (6/7/9) are the only ones that
      // ever get the leading apostrophe, regardless of content, not just "real" UUID/date columns
      // that happen never to start with a trigger character.
      const content = buildCsvV1Content([Array(17).fill('=X')]).toString('utf8');
      const dataLine = content.split('\r\n')[1];
      const cells = parseCsv(dataLine + '\r\n')[0];
      const guardedIndices = new Set([6, 7, 9]);
      return cells.every((cell, i) => (guardedIndices.has(i) ? cell === "'=X" : cell === '=X'));
    })(), null);
  }

  // ============================================================================
  // C. CORRECTION export
  // ============================================================================

  let correctionFixture: {
    period: Awaited<ReturnType<typeof makePeriod>>;
    siteX: Awaited<ReturnType<typeof makeSite>>;
    siteY: Awaited<ReturnType<typeof makeSite>>;
    empC1: Awaited<ReturnType<typeof makeFinalApprovedWorker>>;
    empC2: Awaited<ReturnType<typeof makeFinalApprovedWorker>>;
    empC3: Awaited<ReturnType<typeof makeFinalApprovedWorker>>;
    dateC1: Date;
    dateC2: Date;
    batch1: any;
    batch2: any;
    batch3: any;
  };
  {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');
    const siteX = await makeSite('CX');
    const siteY = await makeSite('CY');
    const dateC1 = new Date(startDate);
    const dateC2 = new Date(startDate.getTime() + 86400000);

    const empC1 = await makeFinalApprovedWorker('C1', siteX.id, period);
    await addVersionSegment(empC1.version, empC1.employee.id, siteX.id, empC1.assignment.id, dateC1, new Date(dateC1.getTime() + 8 * 3600000), new Date(dateC1.getTime() + 16 * 3600000));
    // dateC2 exists as a zero-segment WORK day for empC1 — the correction draft's base version day
    // set, per patchCorrectionDraftDay's own "not within this correction draft's base version"
    // guard, is exactly the TimesheetDay rows that exist now; a segment-free day still needs its own
    // TimesheetDay row to be patchable later (§C27, "newly added bucket").
    await ensureVersionDay(empC1.version.id, dateC2);

    const empC2 = await makeFinalApprovedWorker('C2', siteY.id, period);
    await addVersionSegment(empC2.version, empC2.employee.id, siteY.id, empC2.assignment.id, dateC1, new Date(dateC1.getTime() + 8 * 3600000), new Date(dateC1.getTime() + 12 * 3600000));

    const empC3 = await makeFinalApprovedWorker('C3', siteX.id, period);
    await addVersionSegment(empC3.version, empC3.employee.id, siteX.id, empC3.assignment.id, dateC1, new Date(dateC1.getTime() + 8 * 3600000), new Date(dateC1.getTime() + 16 * 3600000));

    const full = await postExport(period.id, admin.token);
    check('C: setup FULL export succeeds', full.status === 201 && full.body.batch.kind === 'FULL', full.body);
    const batch1 = full.body.batch;
    const batch1Items = await prisma.exportItem.findMany({ where: { exportBatchId: batch1.id } });
    check('C: batch1 has exactly 3 items (C1/dateC1, C2/dateC1, C3/dateC1)', batch1Items.length === 3, batch1Items.length);

    // --- C22: no pending correction -> NOTHING_TO_EXPORT ---
    const rNothing = await postExport(period.id, admin.token);
    check('C22: EXPORTED period with zero pending corrections -> 409 NOTHING_TO_EXPORT', rNothing.status === 409 && rNothing.body?.error?.code === 'NOTHING_TO_EXPORT', rNothing.body);

    // --- three corrections opened and approved before the next export call (C29: atomic multi-coverage) ---
    // C26: empC3's dateC1 bucket changes (8h -> 6h).
    const corrC3 = await makeApprovedCorrection(empC3.timesheet.id, admin.user.id, admin2.user.id, dateC1, [{ siteId: siteX.id, startAt: new Date(dateC1.getTime() + 8 * 3600000), endAt: new Date(dateC1.getTime() + 14 * 3600000) }]);
    // C28: empC2's only bucket (siteY/dateC1) is deleted (segments -> []).
    const corrC2 = await makeApprovedCorrection(empC2.timesheet.id, admin.user.id, admin2.user.id, dateC1, []);
    // C27: empC1 gains a new bucket at dateC2 (previously zero segments).
    const corrC1 = await makeApprovedCorrection(empC1.timesheet.id, admin.user.id, admin2.user.id, dateC2, [{ siteId: siteX.id, startAt: new Date(dateC2.getTime() + 9 * 3600000), endAt: new Date(dateC2.getTime() + 17 * 3600000) }]);

    for (const [name, corr] of [
      ['C3', corrC3],
      ['C2', corrC2],
      ['C1', corrC1]
    ] as const) {
      const fresh = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: corr.correctionRequestId } });
      check(`C: correction on emp${name} is pendingExport=true immediately after approval (period already EXPORTED)`, fresh.pendingExport === true && fresh.coveredByExportBatchId === null, fresh);
    }

    // --- C23/C24/C25/C26/C27/C28/C29/C30/C31: the covering CORRECTION export ---
    const corrExport = await postExport(period.id, admin.token);
    check('C23: EXPORTED period with pending corrections -> creates CORRECTION batch (201)', corrExport.status === 201 && corrExport.body?.batch?.kind === 'CORRECTION', corrExport.body);
    const batch2 = corrExport.body.batch;
    check('C24: corrects the latest (only) prior batch', batch2.correctsBatchId === batch1.id, { batch2, batch1 });
    check('C29: coveredCorrectionCount = 3 (all three pending corrections covered atomically)', corrExport.body.coveredCorrectionCount === 3, corrExport.body);

    const batch2Items = await prisma.exportItem.findMany({ where: { exportBatchId: batch2.id } });
    // C25: full replacement snapshot — expects empC1 (2 buckets: dateC1 unchanged + new dateC2),
    // empC3 (1 bucket, changed), and NOT empC2 (its only bucket was deleted) = 3 items total.
    check('C25: full replacement snapshot has exactly 3 items (empC1 x2 + empC3 x1; empC2 has none left)', batch2Items.length === 3, batch2Items);

    const c1Dc1 = batch2Items.find((i) => i.employeeId === empC1.employee.id && i.date.getTime() === dateC1.getTime());
    const c1Dc2 = batch2Items.find((i) => i.employeeId === empC1.employee.id && i.date.getTime() === dateC2.getTime());
    const c3Dc1 = batch2Items.find((i) => i.employeeId === empC3.employee.id && i.date.getTime() === dateC1.getTime());
    const c2AnyItem = batch2Items.find((i) => i.employeeId === empC2.employee.id);

    // T10-D automatic unpaid lunch: a day ≥ 6h with no logged break loses 30 min → workedMinutes =
    // grossMinutes − 30. 8h day: 480 gross / 450 worked. 6h day: 360 gross / 330 worked.
    check('C25: empC1 unchanged original bucket (dateC1) still present in the replacement snapshot', !!c1Dc1 && c1Dc1.workedMinutes === 450 && c1Dc1.grossMinutes === 480, c1Dc1);
    check('C27: empC1 newly added bucket (dateC2) present with correct minutes', !!c1Dc2 && c1Dc2.workedMinutes === 450 && c1Dc2.grossMinutes === 480, c1Dc2);
    check('C26: empC3 bucket changed (8h -> 6h = 360 gross / 330 worked)', !!c3Dc1 && c3Dc1.workedMinutes === 330 && c3Dc1.grossMinutes === 360, c3Dc1);
    check('C28: deletion of last bucket is represented by its absence, not a zero row', c2AnyItem === undefined, c2AnyItem);

    // C30/C31: coveredByExportBatchId set correctly; pendingExport cleared ONLY for the covered rows.
    const [freshC1, freshC2, freshC3] = await Promise.all([
      prisma.correctionRequest.findUniqueOrThrow({ where: { id: corrC1.correctionRequestId } }),
      prisma.correctionRequest.findUniqueOrThrow({ where: { id: corrC2.correctionRequestId } }),
      prisma.correctionRequest.findUniqueOrThrow({ where: { id: corrC3.correctionRequestId } })
    ]);
    check('C30/C31: all three covered by batch2, pendingExport cleared', [freshC1, freshC2, freshC3].every((c) => c.coveredByExportBatchId === batch2.id && c.pendingExport === false), { freshC1, freshC2, freshC3 });

    // --- C32: a correction approved AFTER batch2 remains pending for the NEXT batch ---
    const corrC3Late = await makeApprovedCorrection(empC3.timesheet.id, admin.user.id, admin2.user.id, dateC1, [{ siteId: siteX.id, startAt: new Date(dateC1.getTime() + 8 * 3600000), endAt: new Date(dateC1.getTime() + 15 * 3600000) }]);
    const freshLate = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: corrC3Late.correctionRequestId } });
    check('C32: later approval stays pendingExport=true, not covered by the earlier batch2', freshLate.pendingExport === true && freshLate.coveredByExportBatchId === null, freshLate);

    const thirdExport = await postExport(period.id, admin.token);
    check('C: third export (covering the late correction) creates a second CORRECTION batch', thirdExport.status === 201 && thirdExport.body.batch.kind === 'CORRECTION', thirdExport.body);
    const batch3 = thirdExport.body.batch;
    check('C33: correction history forms an immutable chain — batch3 corrects batch2, batch2 corrects batch1', batch3.correctsBatchId === batch2.id && batch2.correctsBatchId === batch1.id && batch1.correctsBatchId === null, { batch1, batch2, batch3 });

    const freshLateAfter = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: corrC3Late.correctionRequestId } });
    check('C32/C33: the late correction is now covered by batch3, not batch2', freshLateAfter.coveredByExportBatchId === batch3.id, freshLateAfter);

    // C33: old batches' own rows are byte/value-identical to what was captured right after creation
    // — immutability holds across a newer correction batch's creation (defense-in-depth alongside
    // the DB trigger tests in section F).
    const batch1ItemsAfter = await prisma.exportItem.findMany({ where: { exportBatchId: batch1.id } });
    check('C33: batch1 items unchanged after later CORRECTION batches were created', JSON.stringify(batch1ItemsAfter.map((i) => ({ ...i, id: undefined }))) === JSON.stringify(batch1Items.map((i) => ({ ...i, id: undefined }))), { before: batch1Items, after: batch1ItemsAfter });

    correctionFixture = { period: await prisma.payrollPeriod.findUniqueOrThrow({ where: { id: period.id } }), siteX, siteY, empC1, empC2, empC3, dateC1, dateC2, batch1, batch2, batch3 };
  }

  // ============================================================================
  // D. Replay / concurrency
  // ============================================================================

  // --- D34/D35: exact idempotency replay + key reuse conflict ---
  {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');
    const key = randomUUID();
    const r1 = await postExport(period.id, admin.token, { idempotencyKey: key });
    check('D34: first request with a fresh key succeeds (201)', r1.status === 201, r1.body);

    const r2 = await postExport(period.id, admin.token, { idempotencyKey: key });
    check('D34: replay with the same key/period/body returns the same 201 status', r2.status === 201, r2.body);
    check('D34: replay body is byte-identical to the original', JSON.stringify(r2.body) === JSON.stringify(r1.body), { r1: r1.body, r2: r2.body });
    const batchCount = await prisma.exportBatch.count({ where: { periodId: period.id } });
    check('D34: replay did not create a second ExportBatch', batchCount === 1, batchCount);

    const { startDate: sd2, endDate: ed2 } = nextPeriodDates();
    const period2 = await makePeriod(sd2, ed2, 'LOCKED');
    const r3 = await postExport(period2.id, admin.token, { idempotencyKey: key });
    check('D35: same key reused against a different period -> 409 IDEMPOTENCY_KEY_REUSED', r3.status === 409 && r3.body?.error?.code === 'IDEMPOTENCY_KEY_REUSED', r3.body);
  }

  // --- D36: same-key race — at most one real batch, no lost/duplicate work ---
  {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');
    const key = randomUUID();
    const [ra, rb] = await Promise.all([postExport(period.id, admin.token, { idempotencyKey: key }), postExport(period.id, admin.token, { idempotencyKey: key })]);
    const statuses = [ra.status, rb.status].sort();
    check('D36: same-key race resolves to (201,201 identical replay) or (201,409 in-progress)', (statuses[0] === 201 && statuses[1] === 201) || (statuses[0] === 201 && statuses[1] === 409), { ra: ra.status, rb: rb.status });
    if (ra.status === 201 && rb.status === 201) {
      check('D36: if both got 201, bodies are byte-identical (one was a real replay)', JSON.stringify(ra.body) === JSON.stringify(rb.body), { ra: ra.body, rb: rb.body });
    } else {
      const conflict = ra.status === 409 ? ra : rb;
      check('D36: the losing concurrent same-key request gets IDEMPOTENCY_KEY_IN_PROGRESS', conflict.body?.error?.code === 'IDEMPOTENCY_KEY_IN_PROGRESS', conflict.body);
    }
    const batchCount = await prisma.exportBatch.count({ where: { periodId: period.id } });
    check('D36: exactly one real ExportBatch exists after the race', batchCount === 1, batchCount);
  }

  // --- D37: different-key FULL race — exactly one FULL batch ---
  {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');
    const site = await makeSite('D37');
    const worker = await makeFinalApprovedWorker('D37', site.id, period);
    await addVersionSegment(worker.version, worker.employee.id, site.id, worker.assignment.id, new Date(startDate), new Date(startDate.getTime() + 8 * 3600000), new Date(startDate.getTime() + 16 * 3600000));

    const [ra, rb] = await Promise.all([postExport(period.id, admin.token), postExport(period.id, admin.token)]);
    const succeeded = [ra, rb].filter((r) => r.status === 201);
    const rejected = [ra, rb].filter((r) => r.status !== 201);
    check('D37: exactly one of the two concurrent FULL requests succeeds', succeeded.length === 1, { ra: ra.status, rb: rb.status });
    check('D37: the other is rejected (NOTHING_TO_EXPORT — period already EXPORTED by the winner by the time it re-checks)', rejected.length === 1 && rejected[0].status === 409 && rejected[0].body?.error?.code === 'NOTHING_TO_EXPORT', { ra: [ra.status, ra.body], rb: [rb.status, rb.body] });
    const fullBatchCount = await prisma.exportBatch.count({ where: { periodId: period.id, kind: 'FULL' } });
    check('D37: exactly one FULL batch exists in the DB', fullBatchCount === 1, fullBatchCount);
  }

  // --- D38: two CORRECTION exporters racing for the same single pending snapshot ---
  {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');
    const site = await makeSite('D38');
    const worker = await makeFinalApprovedWorker('D38', site.id, period);
    const date = new Date(startDate);
    await addVersionSegment(worker.version, worker.employee.id, site.id, worker.assignment.id, date, new Date(date.getTime() + 8 * 3600000), new Date(date.getTime() + 16 * 3600000));
    const full = await postExport(period.id, admin.token);
    check('D38: setup FULL export succeeds', full.status === 201, full.body);

    await makeApprovedCorrection(worker.timesheet.id, admin.user.id, admin2.user.id, date, [{ siteId: site.id, startAt: new Date(date.getTime() + 8 * 3600000), endAt: new Date(date.getTime() + 15 * 3600000) }]);

    const [ra, rb] = await Promise.all([postExport(period.id, admin.token), postExport(period.id, admin.token)]);
    const succeeded = [ra, rb].filter((r) => r.status === 201);
    const rejected = [ra, rb].filter((r) => r.status !== 201);
    check('D38: exactly one of the two concurrent CORRECTION requests succeeds', succeeded.length === 1, { ra: ra.status, rb: rb.status });
    check('D38: the other gets NOTHING_TO_EXPORT (the single pending snapshot was already covered)', rejected.length === 1 && rejected[0].status === 409 && rejected[0].body?.error?.code === 'NOTHING_TO_EXPORT', { ra: [ra.status, ra.body], rb: [rb.status, rb.body] });
    const correctionBatchCount = await prisma.exportBatch.count({ where: { periodId: period.id, kind: 'CORRECTION' } });
    check('D38: exactly one CORRECTION batch exists in the DB', correctionBatchCount === 1, correctionBatchCount);
  }

  // --- D39/D40: explicit ordering — approval-before-export and export-before-approval ---
  {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');
    const site = await makeSite('D3940');
    const worker = await makeFinalApprovedWorker('D3940', site.id, period);
    const date = new Date(startDate);
    await addVersionSegment(worker.version, worker.employee.id, site.id, worker.assignment.id, date, new Date(date.getTime() + 8 * 3600000), new Date(date.getTime() + 16 * 3600000));
    await postExport(period.id, admin.token);

    // D39 — approval fully commits BEFORE the covering export call is made.
    const corr = await makeApprovedCorrection(worker.timesheet.id, admin.user.id, admin2.user.id, date, [{ siteId: site.id, startAt: new Date(date.getTime() + 8 * 3600000), endAt: new Date(date.getTime() + 13 * 3600000) }]);
    const exportAfterApproval = await postExport(period.id, admin.token);
    check('D39: approval-before-export — the correction that already committed is covered', exportAfterApproval.status === 201 && exportAfterApproval.body.coveredCorrectionCount === 1, exportAfterApproval.body);
    const freshCorr = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: corr.correctionRequestId } });
    check('D39: covered correction points at that export batch', freshCorr.coveredByExportBatchId === exportAfterApproval.body.batch.id, freshCorr);

    // D40 — export call commits (with nothing pending) BEFORE a later correction is approved.
    const beforeCount = await prisma.exportBatch.count({ where: { periodId: period.id } });
    const emptyExport = await postExport(period.id, admin.token);
    check('D40: export-before-approval — an export with nothing pending is rejected, not silently empty', emptyExport.status === 409 && emptyExport.body?.error?.code === 'NOTHING_TO_EXPORT', emptyExport.body);
    const corrLate = await makeApprovedCorrection(worker.timesheet.id, admin.user.id, admin2.user.id, date, [{ siteId: site.id, startAt: new Date(date.getTime() + 8 * 3600000), endAt: new Date(date.getTime() + 14 * 3600000) }]);
    const freshCorrLate = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: corrLate.correctionRequestId } });
    check('D40: the later approval is pending and uncovered by any of the earlier batches', freshCorrLate.pendingExport === true && freshCorrLate.coveredByExportBatchId === null, freshCorrLate);
    const afterCount = await prisma.exportBatch.count({ where: { periodId: period.id } });
    check('D40: the rejected NOTHING_TO_EXPORT call created no batch', afterCount === beforeCount, { beforeCount, afterCount });
  }

  // --- D41: real, distinct PostgreSQL backend PIDs — not just Promise.all timing on one connection ---
  {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');

    let releaseHold: () => void = () => {};
    const releaseGate = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let resolveAcquired: (pid: number) => void = () => {};
    const acquired = new Promise<number>((resolve) => {
      resolveAcquired = resolve;
    });
    const holdDone = prisma.$transaction(
      async (tx) => {
        const pidRows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() as pid`;
        await tx.$queryRaw`SELECT id FROM "PayrollPeriod" WHERE id = ${period.id}::uuid FOR UPDATE`;
        resolveAcquired(Number(pidRows[0].pid));
        await releaseGate;
      },
      { timeout: 30_000, maxWait: 30_000 }
    );
    const holderPid = await acquired;

    const racePromise = postExport(period.id, admin.token);

    let blockedPid: number | null = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = await prisma.$queryRaw<{ pid: number }[]>`SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid != ${holderPid}`;
      if (rows.length > 0) {
        blockedPid = Number(rows[0].pid);
        break;
      }
      await new Promise((res) => setTimeout(res, 100));
    }
    check('D41: a real concurrent export request blocks on a genuinely different PostgreSQL backend PID (pg_stat_activity)', blockedPid !== null && blockedPid !== holderPid, { holderPid, blockedPid });

    releaseHold();
    await holdDone;
    const raceResult = await racePromise;
    check('D41: once the holder releases, the blocked export proceeds and succeeds', raceResult.status === 201, raceResult.body);
  }

  // ============================================================================
  // E. Reads / download / security
  // ============================================================================

  // --- E42: list filters/pagination/order ---
  {
    const listAll = await getExportList(admin.token, 'pageSize=100');
    check('E42: list succeeds', listAll.status === 200, listAll.status);
    check('E42: list never includes content', listAll.body.items.every((b: any) => !('content' in b)), listAll.body.items[0]);
    const ids = listAll.body.items.map((b: any) => b.id);
    check('E42: mainFixture batch appears in the unfiltered list', ids.includes(mainFixture.batch.id), null);
    check('E42: list sorted createdAt DESC, id DESC', (() => {
      for (let i = 1; i < listAll.body.items.length; i++) {
        const prev = listAll.body.items[i - 1];
        const cur = listAll.body.items[i];
        if (prev.createdAt < cur.createdAt) return false;
        if (prev.createdAt === cur.createdAt && prev.id < cur.id) return false;
      }
      return true;
    })(), null);

    const listFiltered = await getExportList(admin.token, `periodId=${mainFixture.period.id}`);
    check('E42: periodId filter returns only that period\'s batches', listFiltered.body.items.every((b: any) => b.periodId === mainFixture.period.id) && listFiltered.body.items.length === 1, listFiltered.body);

    const listMalformed = await getExportList(admin.token, 'periodId=not-a-uuid');
    check('E42: malformed periodId filter -> 400 VALIDATION_ERROR', listMalformed.status === 400 && listMalformed.body?.error?.code === 'VALIDATION_ERROR', listMalformed.body);

    const listPage1 = await getExportList(admin.token, 'pageSize=1&page=1');
    const listPage2 = await getExportList(admin.token, 'pageSize=1&page=2');
    check('E42: pagination — page 1 and page 2 return different single items', listPage1.body.items.length === 1 && listPage2.body.items.length === 1 && listPage1.body.items[0].id !== listPage2.body.items[0].id, { p1: listPage1.body.items, p2: listPage2.body.items });
    check('E42: pagination metadata consistent (totalItems/totalPages)', listPage1.body.totalItems >= 2 && listPage1.body.totalPages === Math.ceil(listPage1.body.totalItems / 1), listPage1.body);
  }

  // --- E43: detail/item pagination ---
  {
    const detailFull = await getExportDetail(mainFixture.batch.id, admin.token, 'pageSize=100');
    check('E43: detail succeeds, no content field', detailFull.status === 200 && !('content' in detailFull.body.batch), detailFull.body);
    check('E43: detail totalItems matches ExportItem count', detailFull.body.totalItems === 4, detailFull.body);

    const detailPage1 = await getExportDetail(mainFixture.batch.id, admin.token, 'pageSize=2&page=1');
    const detailPage2 = await getExportDetail(mainFixture.batch.id, admin.token, 'pageSize=2&page=2');
    check('E43: item pagination — 2 items per page, 2 pages', detailPage1.body.items.length === 2 && detailPage2.body.items.length === 2 && detailPage1.body.totalPages === 2, { p1: detailPage1.body, p2: detailPage2.body });
    const unionIds = new Set([...detailPage1.body.items, ...detailPage2.body.items].map((i: any) => i.id));
    check('E43: paginated items union covers all 4 without duplicates', unionIds.size === 4, [...unionIds]);
  }

  // --- E44/E45/E46: exact download stays byte-identical after renames and after a newer batch ---
  {
    const beforeRenameDownload = await getExportDownload(mainFixture.batch.id, admin.token);
    const beforeRenameHash = createHash('sha256').update(beforeRenameDownload.buffer).digest('hex');

    await prisma.employee.update({ where: { id: mainFixture.empA.employee.id }, data: { firstName: 'RenamedFirst', lastName: 'RenamedLast' } });
    await prisma.workSite.update({ where: { id: mainFixture.siteX.id }, data: { name: 'Renamed Site X' } });

    const afterRenameDownload = await getExportDownload(mainFixture.batch.id, admin.token);
    check('E44: download byte-identical after employee/site rename', afterRenameDownload.buffer.equals(beforeRenameDownload.buffer), { beforeLen: beforeRenameDownload.buffer.length, afterLen: afterRenameDownload.buffer.length });
    const afterRenameText = afterRenameDownload.buffer.slice(3).toString('utf8');
    check('E44: CSV still contains the OLD (snapshot) name, not the new one', afterRenameText.includes('RenamedFirst') === false, null);

    // E45/E46 — correctionFixture.batch1 has had two newer CORRECTION batches created against the
    // same period since its own creation; its own bytes/hash must be untouched.
    const oldBatchDownload = await getExportDownload(correctionFixture.batch1.id, admin.token);
    const oldBatchHash = createHash('sha256').update(oldBatchDownload.buffer).digest('hex');
    check('E45/E46: batch1 download hash unchanged after two newer CORRECTION batches were created', oldBatchHash === correctionFixture.batch1.fileHash, { recorded: correctionFixture.batch1.fileHash, actual: oldBatchHash });
    check('E45/E46: batch1 download byte length unchanged', oldBatchDownload.buffer.byteLength === correctionFixture.batch1.fileSizeBytes, { recorded: correctionFixture.batch1.fileSizeBytes, actual: oldBatchDownload.buffer.byteLength });
  }

  // --- E47: download headers ---
  {
    const dl = await getExportDownload(mainFixture.batch.id, admin.token);
    check('E47: Content-Type', dl.headers.get('content-type') === 'text/csv; charset=utf-8', dl.headers.get('content-type'));
    check('E47: Content-Disposition attachment with stored filename', dl.headers.get('content-disposition') === `attachment; filename="${mainFixture.batch.fileName}"`, dl.headers.get('content-disposition'));
    check('E47: Content-Length matches fileSizeBytes', dl.headers.get('content-length') === String(mainFixture.batch.fileSizeBytes), dl.headers.get('content-length'));
    check('E47: Cache-Control private, no-store', dl.headers.get('cache-control') === 'private, no-store', dl.headers.get('cache-control'));
    check('E47: X-Content-Type-Options nosniff', dl.headers.get('x-content-type-options') === 'nosniff', dl.headers.get('x-content-type-options'));
    check('E47: X-Content-SHA256 matches fileHash', dl.headers.get('x-content-sha256') === mainFixture.batch.fileHash, dl.headers.get('x-content-sha256'));
  }

  // --- E48: uniform 404 for malformed/missing batchId ---
  {
    // R07-A (lib/api-guard.requireUuidParam): a malformed [batchId] PATH param gets the route's own
    // EXPORT_BATCH_NOT_FOUND 404 before Prisma — same envelope as a nonexistent id (uniform 404).
    const rMalformedDetail = await getExportDetail('not-a-uuid', admin.token);
    check('E48: malformed batchId (detail) -> 404 EXPORT_BATCH_NOT_FOUND', rMalformedDetail.status === 404 && rMalformedDetail.body?.error?.code === 'EXPORT_BATCH_NOT_FOUND', rMalformedDetail.body);
    const rMissingDetail = await getExportDetail(randomUUID(), admin.token);
    check('E48: nonexistent batchId (detail) -> 404 EXPORT_BATCH_NOT_FOUND', rMissingDetail.status === 404 && rMissingDetail.body?.error?.code === 'EXPORT_BATCH_NOT_FOUND', rMissingDetail.body);

    const rMissingDownload = await getExportDownload(randomUUID(), admin.token);
    check('E48: nonexistent batchId (download) -> 404 EXPORT_BATCH_NOT_FOUND, JSON envelope not HTML', rMissingDownload.status === 404, rMissingDownload.status);
    const downloadErrorBody = JSON.parse(rMissingDownload.buffer.toString('utf8'));
    check('E48: download 404 body is the standard JSON error envelope', downloadErrorBody?.error?.code === 'EXPORT_BATCH_NOT_FOUND', downloadErrorBody);
    const rMalformedDownload = await getExportDownload('also-not-a-uuid', admin.token);
    check('E48: malformed batchId (download) -> same uniform 404, no oracle', rMalformedDownload.status === 404, rMalformedDownload.status);
  }

  // --- E49: forbidden-field scan — JSON responses, CSV content, AuditEvent, logs ---
  {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');
    const site = await makeSite('E49');
    const worker = await makeFinalApprovedWorker('E49', site.id, period, { phone: '+358501234567' });
    const date = new Date(startDate);
    await addVersionSegment(worker.version, worker.employee.id, site.id, worker.assignment.id, date, new Date(date.getTime() + 8 * 3600000), new Date(date.getTime() + 16 * 3600000));

    const r = await postExport(period.id, admin.token);
    check('E49: setup export succeeds', r.status === 201, r.body);
    const forbiddenNeedles = ['+358501234567', 'phone', 'email', 'gps', 'latitude', 'longitude', 'deviceInstallationId', 'clientEventId', 'payloadHash', 'test correction'];
    const responseText = JSON.stringify(r.body);
    for (const needle of forbiddenNeedles) {
      check(`E49: POST response never contains "${needle}"`, !responseText.toLowerCase().includes(needle.toLowerCase()), needle === '+358501234567' ? responseText : undefined);
    }

    const listText = JSON.stringify((await getExportList(admin.token, `periodId=${period.id}`)).body);
    const detailText = JSON.stringify((await getExportDetail(r.body.batch.id, admin.token, 'pageSize=100')).body);
    const dl = await getExportDownload(r.body.batch.id, admin.token);
    const csvText = dl.buffer.toString('utf8');
    for (const needle of ['+358501234567', 'test correction']) {
      check(`E49: list response never contains "${needle}"`, !listText.includes(needle), null);
      check(`E49: detail response never contains "${needle}"`, !detailText.includes(needle), null);
      check(`E49: CSV content never contains "${needle}"`, !csvText.includes(needle), null);
    }

    const auditRow = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: 'EXPORT_CREATED', entityId: r.body.batch.id } });
    const afterValue = auditRow.afterValue as Record<string, unknown>;
    const allowedAuditKeys = new Set(['exportBatchId', 'periodId', 'format', 'kind', 'correctsBatchId', 'rowCount', 'fileSizeBytes', 'fileHash', 'coveredCorrectionCount']);
    check('E49: AuditEvent(EXPORT_CREATED).afterValue has ONLY the allowed keys', Object.keys(afterValue).every((k) => allowedAuditKeys.has(k)) && Object.keys(afterValue).length === allowedAuditKeys.size, afterValue);
    check('E49: AuditEvent never contains the employee/site snapshot values', !JSON.stringify(afterValue).includes(worker.employee.employeeNumber), afterValue);
  }

  // --- E50: GET creates zero mutations / AuditEvent ---
  {
    const auditCountBefore = await prisma.auditEvent.count();
    const batchCountBefore = await prisma.exportBatch.count();
    const itemCountBefore = await prisma.exportItem.count();

    await getExportList(admin.token, 'pageSize=100');
    await getExportDetail(mainFixture.batch.id, admin.token);
    await getExportDownload(mainFixture.batch.id, admin.token);

    const auditCountAfter = await prisma.auditEvent.count();
    const batchCountAfter = await prisma.exportBatch.count();
    const itemCountAfter = await prisma.exportItem.count();
    check('E50: GET list/detail/download create zero AuditEvent rows', auditCountAfter === auditCountBefore, { before: auditCountBefore, after: auditCountAfter });
    check('E50: GET list/detail/download create zero ExportBatch/ExportItem rows', batchCountAfter === batchCountBefore && itemCountAfter === itemCountBefore, { batches: [batchCountBefore, batchCountAfter], items: [itemCountBefore, itemCountAfter] });
  }

  // --- E51: revoked permission takes effect on the next request ---
  {
    const custom = await makeCustomRoleUser('e51', ['export.read']);
    const before = await getExportList(custom.token, 'pageSize=1');
    check('E51: export.read grants list access', before.status === 200, before.body);
    await revokeGrant(custom.grants[0].rolePermissionId);
    const after = await getExportList(custom.token, 'pageSize=1');
    check('E51: revoked export.read blocks the very next list request (403)', after.status === 403, after.body);

    const customDetail = await makeCustomRoleUser('e51d', ['export.read']);
    const beforeD = await getExportDetail(mainFixture.batch.id, customDetail.token);
    check('E51: export.read grants detail access', beforeD.status === 200, beforeD.body);
    await revokeGrant(customDetail.grants[0].rolePermissionId);
    const afterD = await getExportDetail(mainFixture.batch.id, customDetail.token);
    check('E51: revoked export.read blocks the very next detail request (403)', afterD.status === 403, afterD.body);

    const customDl = await makeCustomRoleUser('e51dl', ['export.read']);
    const beforeDl = await getExportDownload(mainFixture.batch.id, customDl.token);
    check('E51: export.read grants download access', beforeDl.status === 200, beforeDl.status);
    await revokeGrant(customDl.grants[0].rolePermissionId);
    const afterDl = await getExportDownload(mainFixture.batch.id, customDl.token);
    check('E51: revoked export.read blocks the very next download request (403)', afterDl.status === 403, afterDl.status);

    const customPost = await makeCustomRoleUser('e51p', ['period.export', 'export.create']);
    const { startDate, endDate } = nextPeriodDates();
    const p = await makePeriod(startDate, endDate, 'LOCKED');
    const beforeP = await postExport(p.id, customPost.token);
    check('E51: both create permissions grant POST access', beforeP.status === 201, beforeP.body);
    await revokeGrant(customPost.grants.find((g) => g.code === 'export.create')!.rolePermissionId);
    const { startDate: sd2, endDate: ed2 } = nextPeriodDates();
    const p2 = await makePeriod(sd2, ed2, 'LOCKED');
    const afterP = await postExport(p2.id, customPost.token);
    check('E51: revoking export.create blocks the very next POST request (403)', afterP.status === 403, afterP.body);
  }

  // ============================================================================
  // F. DB / performance
  // ============================================================================

  // --- F52: immutable triggers still reject UPDATE/DELETE (ExportBatch/ExportItem) ---
  {
    await expectReject('F52: UPDATE ExportBatch rejected', () => prisma.exportBatch.update({ where: { id: mainFixture.batch.id }, data: { fileName: 'hacked.csv' } }), 'EXPORT_BATCH_IMMUTABLE');
    await expectReject('F52: DELETE ExportBatch rejected', () => prisma.exportBatch.delete({ where: { id: mainFixture.batch.id } }), 'EXPORT_BATCH_IMMUTABLE');
    const anyItem = await prisma.exportItem.findFirstOrThrow({ where: { exportBatchId: mainFixture.batch.id } });
    await expectReject('F52: UPDATE ExportItem rejected', () => prisma.exportItem.update({ where: { id: anyItem.id }, data: { grossMinutes: 9999 } }), 'EXPORT_ITEM_IMMUTABLE');
    await expectReject('F52: DELETE ExportItem rejected', () => prisma.exportItem.delete({ where: { id: anyItem.id } }), 'EXPORT_ITEM_IMMUTABLE');
  }

  // --- F53: correction coverage DB invariants (CK-45/CK-46/FN-26/TRG-31) ---
  {
    // Fresh, isolated fixture: a FULL batch, then a real CORRECTION batch on the SAME period (a
    // valid predecessor to reference), plus a second, unrelated period with its own CORRECTION
    // batch (for the period-mismatch case).
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');
    const site = await makeSite('F53');
    const worker = await makeFinalApprovedWorker('F53', site.id, period);
    const date = new Date(startDate);
    await addVersionSegment(worker.version, worker.employee.id, site.id, worker.assignment.id, date, new Date(date.getTime() + 8 * 3600000), new Date(date.getTime() + 16 * 3600000));
    const fullBatch = (await postExport(period.id, admin.token)).body.batch;
    await makeApprovedCorrection(worker.timesheet.id, admin.user.id, admin2.user.id, date, [{ siteId: site.id, startAt: new Date(date.getTime() + 8 * 3600000), endAt: new Date(date.getTime() + 12 * 3600000) }]);
    const correctionBatch = (await postExport(period.id, admin.token)).body.batch;

    // A genuine CORRECTION batch belonging to a DIFFERENT period — needed to isolate the
    // period-mismatch case from the wrong-kind case (referencing a FULL batch would trip
    // WRONG_KIND first, never reaching the period comparison).
    const { startDate: sd2, endDate: ed2 } = nextPeriodDates();
    const otherPeriod = await makePeriod(sd2, ed2, 'LOCKED');
    const otherSite = await makeSite('F53b');
    const otherWorker = await makeFinalApprovedWorker('F53b', otherSite.id, otherPeriod);
    const otherDate = new Date(sd2);
    await addVersionSegment(otherWorker.version, otherWorker.employee.id, otherSite.id, otherWorker.assignment.id, otherDate, new Date(otherDate.getTime() + 8 * 3600000), new Date(otherDate.getTime() + 16 * 3600000));
    const otherFullBatch = (await postExport(otherPeriod.id, admin.token)).body.batch;
    await makeApprovedCorrection(otherWorker.timesheet.id, admin.user.id, admin2.user.id, otherDate, [{ siteId: otherSite.id, startAt: new Date(otherDate.getTime() + 8 * 3600000), endAt: new Date(otherDate.getTime() + 11 * 3600000) }]);
    const otherCorrectionBatch = (await postExport(otherPeriod.id, admin.token)).body.batch;

    // A fresh APPROVED correction request to experiment on directly (its own real Timesheet row,
    // valid resultingVersionId — same fixture shape decideCorrection itself produces).
    async function makeApprovedButUncoveredCorrection() {
      const w = await makeFinalApprovedWorker('F53c', site.id, period);
      await addVersionSegment(w.version, w.employee.id, site.id, w.assignment.id, date, new Date(date.getTime() + 8 * 3600000), new Date(date.getTime() + 12 * 3600000));
      const corr = await makeApprovedCorrection(w.timesheet.id, admin.user.id, admin2.user.id, date, [{ siteId: site.id, startAt: new Date(date.getTime() + 8 * 3600000), endAt: new Date(date.getTime() + 13 * 3600000) }]);
      return { worker: w, correctionRequestId: corr.correctionRequestId };
    }

    // CK-45 ck_correction_request_pending_export_shape, isolated from CK-46: pendingExport=true
    // with status forced away from APPROVED, coveredByExportBatchId left NULL (so CK-46's own
    // predicate — trivially satisfied whenever coveredByExportBatchId IS NULL — never fires here;
    // only CK-45's "pendingExport implies APPROVED" clause is exercised).
    {
      const { correctionRequestId } = await makeApprovedButUncoveredCorrection();
      await expectReject(
        'F53: CK-45 — pendingExport=true with status != APPROVED is rejected',
        () => prisma.$executeRaw`UPDATE "CorrectionRequest" SET "pendingExport" = true, status = 'REJECTED' WHERE id = ${correctionRequestId}::uuid`,
        'ck_correction_request_pending_export_shape'
      );
    }
    // CK-45 and CK-46 both independently reject the OTHER combination (coveredByExportBatchId set
    // while pendingExport is still true) — documented, not a second isolated test: CK-46's own
    // predicate already requires "NOT pendingExport" whenever coveredByExportBatchId is non-NULL, so
    // this exact row shape can never violate only one of the two; either identifier is a correct,
    // expected rejection reason for it.
    {
      const { correctionRequestId } = await makeApprovedButUncoveredCorrection();
      await expectReject(
        'F53: pendingExport=true with coveredByExportBatchId set is rejected (CK-45 and CK-46 both apply)',
        () => prisma.correctionRequest.update({ where: { id: correctionRequestId }, data: { pendingExport: true, coveredByExportBatchId: correctionBatch.id } }),
        ['ck_correction_request_pending_export_shape', 'ck_correction_request_covered_shape']
      );
    }

    // CK-46 ck_correction_request_covered_shape — coveredByExportBatchId set while status is not
    // APPROVED (simulated via a raw update bypassing the normal decide flow, status forced REJECTED).
    {
      const { correctionRequestId } = await makeApprovedButUncoveredCorrection();
      await prisma.$executeRaw`UPDATE "CorrectionRequest" SET "pendingExport" = false WHERE id = ${correctionRequestId}::uuid`;
      await expectReject(
        'F53: CK-46 — coveredByExportBatchId set while status != APPROVED is rejected',
        () =>
          prisma.$executeRaw`UPDATE "CorrectionRequest" SET status = 'REJECTED', "coveredByExportBatchId" = ${correctionBatch.id}::uuid WHERE id = ${correctionRequestId}::uuid`,
        'ck_correction_request_covered_shape'
      );
    }

    // FN-26 / TRG-31 — reference validation, at the NULL -> value transition.
    {
      const { correctionRequestId } = await makeApprovedButUncoveredCorrection();
      await prisma.$executeRaw`UPDATE "CorrectionRequest" SET "pendingExport" = false WHERE id = ${correctionRequestId}::uuid`;
      await expectReject(
        'F53: FN-26 — coveredByExportBatchId referencing a nonexistent batch is rejected',
        () => prisma.correctionRequest.update({ where: { id: correctionRequestId }, data: { coveredByExportBatchId: randomUUID() } }),
        'CORRECTION_REQUEST_COVERED_BATCH_NOT_FOUND'
      );
    }
    {
      const { correctionRequestId } = await makeApprovedButUncoveredCorrection();
      await prisma.$executeRaw`UPDATE "CorrectionRequest" SET "pendingExport" = false WHERE id = ${correctionRequestId}::uuid`;
      await expectReject(
        'F53: FN-26 — coveredByExportBatchId referencing a FULL batch (wrong kind) is rejected',
        () => prisma.correctionRequest.update({ where: { id: correctionRequestId }, data: { coveredByExportBatchId: fullBatch.id } }),
        'CORRECTION_REQUEST_COVERED_BATCH_WRONG_KIND'
      );
    }
    {
      const { correctionRequestId } = await makeApprovedButUncoveredCorrection();
      await prisma.$executeRaw`UPDATE "CorrectionRequest" SET "pendingExport" = false WHERE id = ${correctionRequestId}::uuid`;
      await expectReject(
        'F53: FN-26 — coveredByExportBatchId referencing a CORRECTION batch of a DIFFERENT period is rejected',
        () => prisma.correctionRequest.update({ where: { id: correctionRequestId }, data: { coveredByExportBatchId: otherCorrectionBatch.id } }),
        'CORRECTION_REQUEST_COVERED_BATCH_PERIOD_MISMATCH'
      );
    }
    // Positive: a genuinely valid same-period CORRECTION batch reference succeeds, then attempting
    // to change or clear it afterward is rejected (immutability).
    {
      const { correctionRequestId } = await makeApprovedButUncoveredCorrection();
      await prisma.$executeRaw`UPDATE "CorrectionRequest" SET "pendingExport" = false WHERE id = ${correctionRequestId}::uuid`;
      await prisma.correctionRequest.update({ where: { id: correctionRequestId }, data: { coveredByExportBatchId: correctionBatch.id } });
      const fresh = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: correctionRequestId } });
      check('F53: valid same-period CORRECTION batch reference succeeds', fresh.coveredByExportBatchId === correctionBatch.id, fresh);

      await expectReject(
        'F53: TRG-31 — coveredByExportBatchId cannot be changed to a different batch once set',
        () => prisma.correctionRequest.update({ where: { id: correctionRequestId }, data: { coveredByExportBatchId: fullBatch.id } }),
        'CORRECTION_REQUEST_COVERED_BATCH_IMMUTABLE'
      );
      await expectReject(
        'F53: TRG-31 — coveredByExportBatchId cannot be cleared back to NULL once set',
        () => prisma.correctionRequest.update({ where: { id: correctionRequestId }, data: { coveredByExportBatchId: null } }),
        'CORRECTION_REQUEST_COVERED_BATCH_IMMUTABLE'
      );
    }
  }

  // --- F54: transaction rollback leaves no half-batch/items/state changes ---
  {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');
    // An expected participant with NO Timesheet at all — an invariant violation createExportBatch
    // must throw on (period.lock itself would normally prevent this, but the service re-verifies
    // independently rather than trusting that fact, §BA) — deliberately bypasses
    // makeFinalApprovedWorker to construct exactly this broken state directly.
    const emp = await makeEmployee('F54');
    const site = await makeSite('F54');
    await makeAssignment(emp.id, site.id, period.startDate, period.endDate);
    await makeParticipant(period.id, emp.id, true);

    const batchCountBefore = await prisma.exportBatch.count();
    const itemCountBefore = await prisma.exportItem.count();
    const auditCountBefore = await prisma.auditEvent.count();

    const r = await postExport(period.id, admin.token);
    check('F54: invariant-violating population causes a real failure (500), not a partial success', r.status === 500, r.status);

    const freshPeriod = await prisma.payrollPeriod.findUniqueOrThrow({ where: { id: period.id } });
    check('F54: PayrollPeriod.status was NOT flipped to EXPORTED by the failed attempt', freshPeriod.status === 'LOCKED' && freshPeriod.exportedAt === null, freshPeriod);
    const batchCountAfter = await prisma.exportBatch.count();
    const itemCountAfter = await prisma.exportItem.count();
    const auditCountAfter = await prisma.auditEvent.count();
    check('F54: zero ExportBatch/ExportItem/AuditEvent rows leaked by the rolled-back transaction', batchCountAfter === batchCountBefore && itemCountAfter === itemCountBefore && auditCountAfter === auditCountBefore, {
      batches: [batchCountBefore, batchCountAfter],
      items: [itemCountBefore, itemCountAfter],
      audits: [auditCountBefore, auditCountAfter]
    });
  }

  // ============================================================================
  // G. T8.4B FOLLOW-UP — excluded participant pendingExport lifecycle
  // ============================================================================
  // Root cause: decideCorrection used to set pendingExport = (period.status === 'EXPORTED') alone,
  // with no regard for PayrollPeriodParticipant.expected — an excluded participant's correction
  // could reach pendingExport=true and then stay there forever, since export population (§BA) is
  // always expected=true only and never covers it. Fixed formula:
  //   pendingExport = period.status === 'EXPORTED' AND PayrollPeriodParticipant.expected === true

  // --- G1/G7: expected participant — unchanged behavior (pendingExport=true, then covered) ---
  {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');
    const site = await makeSite('G1');
    const worker = await makeFinalApprovedWorker('G1', site.id, period);
    const date = new Date(startDate);
    await addVersionSegment(worker.version, worker.employee.id, site.id, worker.assignment.id, date, new Date(date.getTime() + 8 * 3600000), new Date(date.getTime() + 16 * 3600000));
    await postExport(period.id, admin.token);

    const corr = await makeApprovedCorrection(worker.timesheet.id, admin.user.id, admin2.user.id, date, [{ siteId: site.id, startAt: new Date(date.getTime() + 8 * 3600000), endAt: new Date(date.getTime() + 13 * 3600000) }]);
    const fresh = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: corr.correctionRequestId } });
    check('G1: expected participant + EXPORTED period + approved correction -> pendingExport=true', fresh.pendingExport === true && fresh.coveredByExportBatchId === null, fresh);

    const cov = await postExport(period.id, admin.token);
    check('G7: expected pending correction still covered by the CORRECTION batch (201)', cov.status === 201 && cov.body.coveredCorrectionCount === 1, cov.body);
    const freshCovered = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: corr.correctionRequestId } });
    check('G7: covered -> pendingExport=false, coveredByExportBatchId=batch.id', freshCovered.pendingExport === false && freshCovered.coveredByExportBatchId === cov.body.batch.id, freshCovered);
  }

  // --- G2/G3/G4/G10: excluded participant ---
  {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');
    const site = await makeSite('G2');

    // Excluded worker — real FINAL_APPROVED timesheet + segment, but expected=false.
    const excludedWorker = await makeFinalApprovedWorker('G2excl', site.id, period, { expected: false });
    await addVersionSegment(excludedWorker.version, excludedWorker.employee.id, site.id, excludedWorker.assignment.id, new Date(startDate), new Date(startDate.getTime() + 8 * 3600000), new Date(startDate.getTime() + 16 * 3600000));

    // Expected worker in the same period, so the initial FULL export has at least one real row.
    const expectedWorker = await makeFinalApprovedWorker('G2exp', site.id, period);
    const expDate = new Date(startDate);
    await addVersionSegment(expectedWorker.version, expectedWorker.employee.id, site.id, expectedWorker.assignment.id, expDate, new Date(expDate.getTime() + 8 * 3600000), new Date(expDate.getTime() + 16 * 3600000));

    const full = await postExport(period.id, admin.token);
    check('G: setup FULL export succeeds', full.status === 201, full.body);

    const batchCountBeforeExcludedApproval = await prisma.exportBatch.count({ where: { periodId: period.id } });
    const itemCountBeforeExcludedApproval = await prisma.exportItem.count();
    const auditCountBeforeExcludedApproval = await prisma.auditEvent.count();

    const excludedCorr = await makeApprovedCorrection(excludedWorker.timesheet.id, admin.user.id, admin2.user.id, new Date(startDate), [{ siteId: site.id, startAt: new Date(startDate.getTime() + 8 * 3600000), endAt: new Date(startDate.getTime() + 12 * 3600000) }]);

    // G2 — the core fix.
    const freshExcluded = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: excludedCorr.correctionRequestId } });
    check('G2: excluded participant + EXPORTED period + approved correction -> pendingExport=false', freshExcluded.pendingExport === false, freshExcluded);
    check('G2: coveredByExportBatchId stays null (never marked pending, so never needs coverage)', freshExcluded.coveredByExportBatchId === null, freshExcluded);

    // G10 — approving an excluded participant's correction must not touch ExportBatch/ExportItem at all.
    const batchCountAfterExcludedApproval = await prisma.exportBatch.count({ where: { periodId: period.id } });
    const itemCountAfterExcludedApproval = await prisma.exportItem.count();
    check('G10: approving excluded participant correction creates zero new ExportBatch rows', batchCountAfterExcludedApproval === batchCountBeforeExcludedApproval, { before: batchCountBeforeExcludedApproval, after: batchCountAfterExcludedApproval });
    check('G10: approving excluded participant correction creates zero new ExportItem rows', itemCountAfterExcludedApproval === itemCountBeforeExcludedApproval, { before: itemCountBeforeExcludedApproval, after: itemCountAfterExcludedApproval });

    // G12 — AuditEvent for the correction approval itself carries no export-lifecycle or PII fields.
    const auditCountAfterExcludedApproval = await prisma.auditEvent.count();
    // makeApprovedCorrection runs the full pipeline (request -> open -> patch -> submit -> decide),
    // and requestCorrection/submitCorrection/decideCorrection each write their own AuditEvent
    // (CORRECTION_REQUESTED/CORRECTION_SUBMITTED/CORRECTION_APPROVED) — not just decideCorrection's.
    check('G10: the excluded-participant approval pipeline creates new AuditEvent rows (request+submit+approve), none of them export-related', auditCountAfterExcludedApproval > auditCountBeforeExcludedApproval, { before: auditCountBeforeExcludedApproval, after: auditCountAfterExcludedApproval });
    const correctionAuditRow = await prisma.auditEvent.findFirstOrThrow({ where: { eventType: 'CORRECTION_APPROVED', entityId: excludedCorr.correctionRequestId } });
    const correctionAfterValue = correctionAuditRow.afterValue as Record<string, unknown>;
    const forbiddenAuditKeys = ['pendingExport', 'coveredByExportBatchId', 'participant', 'expected', 'employeeNumberSnapshot', 'employeeNameSnapshot', 'siteNameSnapshot'];
    check('G12: CORRECTION_APPROVED AuditEvent.afterValue never mentions export-lifecycle fields', forbiddenAuditKeys.every((k) => !(k in correctionAfterValue)), correctionAfterValue);
    check('G12: CORRECTION_APPROVED AuditEvent.reason is null (not populated for a plain, non-override approval)', correctionAuditRow.reason === null, correctionAuditRow.reason);
    const correctionAuditRowText = JSON.stringify({ before: correctionAuditRow.beforeValue, after: correctionAuditRow.afterValue });
    check('G12: CORRECTION_APPROVED AuditEvent before/afterValue never contains the correction reason text', !correctionAuditRowText.includes('test correction'), correctionAuditRowText);
    check('G12: CORRECTION_APPROVED AuditEvent before/afterValue never contains the employee number', !correctionAuditRowText.includes(excludedWorker.employee.employeeNumber), correctionAuditRowText);

    // G3 — excluded-only pending correction never makes a CORRECTION export "needed".
    const onlyExcludedPending = await postExport(period.id, admin.token);
    check('G3: excluded-only pending correction -> 409 NOTHING_TO_EXPORT (not covered, not creating a batch)', onlyExcludedPending.status === 409 && onlyExcludedPending.body?.error?.code === 'NOTHING_TO_EXPORT', onlyExcludedPending.body);
    const freshExcludedStillUncovered = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: excludedCorr.correctionRequestId } });
    check('G3: excluded correction remains pendingExport=false, uncovered, after a NOTHING_TO_EXPORT attempt', freshExcludedStillUncovered.pendingExport === false && freshExcludedStillUncovered.coveredByExportBatchId === null, freshExcludedStillUncovered);

    // G4 — an excluded pending (non-)correction never blocks a genuinely eligible expected correction.
    const expectedCorr = await makeApprovedCorrection(expectedWorker.timesheet.id, admin.user.id, admin2.user.id, expDate, [{ siteId: site.id, startAt: new Date(expDate.getTime() + 8 * 3600000), endAt: new Date(expDate.getTime() + 14 * 3600000) }]);
    const mixedExport = await postExport(period.id, admin.token);
    check('G4: expected correction still exports normally alongside an excluded (never-pending) one', mixedExport.status === 201 && mixedExport.body.batch.kind === 'CORRECTION' && mixedExport.body.coveredCorrectionCount === 1, mixedExport.body);
    const freshExpectedCorr = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: expectedCorr.correctionRequestId } });
    check('G4: expected correction covered by the new batch', freshExpectedCorr.coveredByExportBatchId === mixedExport.body.batch.id, freshExpectedCorr);
    const finalExcludedState = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: excludedCorr.correctionRequestId } });
    check('G4: excluded correction untouched by the expected-correction export (still uncovered, still false)', finalExcludedState.pendingExport === false && finalExcludedState.coveredByExportBatchId === null, finalExcludedState);
  }

  // --- G5/G6: direct SQL negative tests for the new trigger branch ---
  {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');
    const site = await makeSite('G5');

    // A real APPROVED, resultingVersionId-carrying correction on an EXCLUDED participant — satisfies
    // CK-45's own same-row shape entirely, isolating the new trigger branch as the only possible
    // rejection reason. The period is exported FIRST (zero expected participants -> header-only FULL
    // batch, same as the A8 zero-hours case) so PERIOD_NOT_EXPORTED cannot mask
    // PARTICIPANT_EXCLUDED — the trigger checks period status before participant.expected.
    const excludedWorker = await makeFinalApprovedWorker('G5excl', site.id, period, { expected: false });
    await addVersionSegment(excludedWorker.version, excludedWorker.employee.id, site.id, excludedWorker.assignment.id, new Date(startDate), new Date(startDate.getTime() + 8 * 3600000), new Date(startDate.getTime() + 12 * 3600000));
    await postExport(period.id, admin.token); // period -> EXPORTED (zero expected participants, header-only)
    const excludedCorr = await makeApprovedCorrection(excludedWorker.timesheet.id, admin.user.id, admin2.user.id, new Date(startDate), [{ siteId: site.id, startAt: new Date(startDate.getTime() + 8 * 3600000), endAt: new Date(startDate.getTime() + 11 * 3600000) }]);
    // decideCorrection already correctly left pendingExport=false for this excluded participant —
    // confirm the DB itself independently rejects forcing it to true, regardless of what the
    // application would ever send.
    await expectReject(
      'G5: direct SQL pendingExport=true for an excluded participant is rejected by a stable DB identifier',
      () => prisma.$executeRaw`UPDATE "CorrectionRequest" SET "pendingExport" = true WHERE id = ${excludedCorr.correctionRequestId}::uuid`,
      'CORRECTION_REQUEST_PENDING_EXPORT_PARTICIPANT_EXCLUDED'
    );

    // Now export the period (FULL) so it becomes EXPORTED, then build a fresh EXPECTED-participant
    // correction on this same now-EXPORTED period and try to force pendingExport=true while the
    // period status is rewound to LOCKED on a throwaway period instead — isolates "period not
    // EXPORTED" from "participant excluded" by using an expected participant this time.
    const { startDate: sd2, endDate: ed2 } = nextPeriodDates();
    const lockedPeriod = await makePeriod(sd2, ed2, 'LOCKED');
    const site2 = await makeSite('G6');
    const expectedWorker = await makeFinalApprovedWorker('G6exp', site2.id, lockedPeriod);
    await addVersionSegment(expectedWorker.version, expectedWorker.employee.id, site2.id, expectedWorker.assignment.id, new Date(sd2), new Date(sd2.getTime() + 8 * 3600000), new Date(sd2.getTime() + 16 * 3600000));
    const expectedCorrOnLocked = await makeApprovedCorrection(expectedWorker.timesheet.id, admin.user.id, admin2.user.id, new Date(sd2), [{ siteId: site2.id, startAt: new Date(sd2.getTime() + 8 * 3600000), endAt: new Date(sd2.getTime() + 11 * 3600000) }]);
    // lockedPeriod is still LOCKED (never exported) — decideCorrection left pendingExport=false here
    // too (LOCKED never sets it true). Force it directly to prove the DB independently rejects
    // pendingExport=true while the period itself is not EXPORTED, even for an expected participant.
    await expectReject(
      'G6: direct SQL pendingExport=true while period != EXPORTED is rejected by a stable DB identifier',
      () => prisma.$executeRaw`UPDATE "CorrectionRequest" SET "pendingExport" = true WHERE id = ${expectedCorrOnLocked.correctionRequestId}::uuid`,
      'CORRECTION_REQUEST_PENDING_EXPORT_PERIOD_NOT_EXPORTED'
    );
  }

  // --- G8: migration repair logic correctly clears a manually-crafted legacy invalid row ---
  {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');
    const site = await makeSite('G8');
    const excludedWorker = await makeFinalApprovedWorker('G8', site.id, period, { expected: false });
    await addVersionSegment(excludedWorker.version, excludedWorker.employee.id, site.id, excludedWorker.assignment.id, new Date(startDate), new Date(startDate.getTime() + 8 * 3600000), new Date(startDate.getTime() + 12 * 3600000));
    const excludedCorr = await makeApprovedCorrection(excludedWorker.timesheet.id, admin.user.id, admin2.user.id, new Date(startDate), [{ siteId: site.id, startAt: new Date(startDate.getTime() + 8 * 3600000), endAt: new Date(startDate.getTime() + 11 * 3600000) }]);
    await postExport(period.id, admin.token); // period -> EXPORTED

    // Simulate a genuinely pre-existing "legacy" bad row (as the OLD, pre-fix decideCorrection would
    // have left behind) by disabling the new trigger just long enough to force the row into the
    // otherwise-now-unreachable bad state, then re-enabling it — the row itself is real (real
    // APPROVED correction, real resultingVersionId, real excluded participant, real EXPORTED period).
    await prisma.$executeRaw`ALTER TABLE "CorrectionRequest" DISABLE TRIGGER trg_correction_request_covered_batch_check`;
    await prisma.$executeRaw`UPDATE "CorrectionRequest" SET "pendingExport" = true WHERE id = ${excludedCorr.correctionRequestId}::uuid`;
    await prisma.$executeRaw`ALTER TABLE "CorrectionRequest" ENABLE TRIGGER trg_correction_request_covered_batch_check`;
    const forcedBad = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: excludedCorr.correctionRequestId } });
    check('G8: legacy-bad-state fixture actually has pendingExport=true (setup sanity check)', forcedBad.pendingExport === true, forcedBad);

    // The exact repair query from migration 20260819190000's Section A.
    await prisma.$executeRaw`
      UPDATE "CorrectionRequest" cr
      SET "pendingExport" = false, "coveredByExportBatchId" = NULL
      FROM "Timesheet" t
      LEFT JOIN "PayrollPeriodParticipant" ppp
        ON ppp."periodId" = t."periodId" AND ppp."employeeId" = t."employeeId"
      WHERE cr."timesheetId" = t."id"
        AND cr."pendingExport" = true
        AND (ppp."expected" IS NULL OR ppp."expected" = false)
    `;

    const repaired = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: excludedCorr.correctionRequestId } });
    check('G8: migration repair query clears pendingExport back to false', repaired.pendingExport === false, repaired);
    check('G8: migration repair query clears coveredByExportBatchId back to null', repaired.coveredByExportBatchId === null, repaired);
  }

  // --- G9: correction approval vs export race for an EXPECTED participant is not broken by this change ---
  {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');
    const site = await makeSite('G9');
    const worker = await makeFinalApprovedWorker('G9', site.id, period);
    const date = new Date(startDate);
    await addVersionSegment(worker.version, worker.employee.id, site.id, worker.assignment.id, date, new Date(date.getTime() + 8 * 3600000), new Date(date.getTime() + 16 * 3600000));
    await postExport(period.id, admin.token);

    // Approval-before-export ordering (D39-equivalent, re-verified after the trigger extension).
    const corr = await makeApprovedCorrection(worker.timesheet.id, admin.user.id, admin2.user.id, date, [{ siteId: site.id, startAt: new Date(date.getTime() + 8 * 3600000), endAt: new Date(date.getTime() + 12 * 3600000) }]);
    const freshBeforeExport = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: corr.correctionRequestId } });
    check('G9: approval before export still sets pendingExport=true for an expected participant', freshBeforeExport.pendingExport === true, freshBeforeExport);

    const cov = await postExport(period.id, admin.token);
    check('G9: export still covers it normally (201, CORRECTION, coveredCorrectionCount=1)', cov.status === 201 && cov.body.batch.kind === 'CORRECTION' && cov.body.coveredCorrectionCount === 1, cov.body);
    const freshAfterExport = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: corr.correctionRequestId } });
    check('G9: covered correctly — pendingExport=false, coveredByExportBatchId=batch.id', freshAfterExport.pendingExport === false && freshAfterExport.coveredByExportBatchId === cov.body.batch.id, freshAfterExport);
  }

  // --- G11: pre-existing coveredByExportBatchId triggers (immutability/kind/period) still work after the FN-26 extension ---
  {
    const { startDate, endDate } = nextPeriodDates();
    const period = await makePeriod(startDate, endDate, 'LOCKED');
    const site = await makeSite('G11');
    const worker = await makeFinalApprovedWorker('G11', site.id, period);
    const date = new Date(startDate);
    await addVersionSegment(worker.version, worker.employee.id, site.id, worker.assignment.id, date, new Date(date.getTime() + 8 * 3600000), new Date(date.getTime() + 16 * 3600000));
    const fullBatch = (await postExport(period.id, admin.token)).body.batch;

    const corr = await makeApprovedCorrection(worker.timesheet.id, admin.user.id, admin2.user.id, date, [{ siteId: site.id, startAt: new Date(date.getTime() + 8 * 3600000), endAt: new Date(date.getTime() + 12 * 3600000) }]);
    await expectReject(
      'G11: coveredByExportBatchId referencing a FULL batch (wrong kind) still rejected after FN-26 extension',
      () => prisma.correctionRequest.update({ where: { id: corr.correctionRequestId }, data: { coveredByExportBatchId: fullBatch.id } }),
      'CORRECTION_REQUEST_COVERED_BATCH_WRONG_KIND'
    );
    await expectReject(
      'G11: coveredByExportBatchId referencing a nonexistent batch still rejected after FN-26 extension',
      () => prisma.correctionRequest.update({ where: { id: corr.correctionRequestId }, data: { coveredByExportBatchId: randomUUID() } }),
      'CORRECTION_REQUEST_COVERED_BATCH_NOT_FOUND'
    );

    const cov = await postExport(period.id, admin.token);
    const freshCovered = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: corr.correctionRequestId } });
    check('G11: real coverage still succeeds after FN-26 extension', freshCovered.coveredByExportBatchId === cov.body.batch.id, freshCovered);
    await expectReject(
      'G11: coveredByExportBatchId still immutable after FN-26 extension',
      () => prisma.correctionRequest.update({ where: { id: corr.correctionRequestId }, data: { coveredByExportBatchId: fullBatch.id } }),
      'CORRECTION_REQUEST_COVERED_BATCH_IMMUTABLE'
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
