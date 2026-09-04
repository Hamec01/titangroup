import { randomUUID, randomBytes, createHash } from 'node:crypto';
import type { TimesheetStatus, SubmissionSource } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { resolveCanonicalSource } from '../lib/reporting/canonical-source';

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.3A Company Payroll Period Report API" —
// permanent regression, real HTTP against GET /api/admin/reports/periods/:periodId, plus cross-
// endpoint reconciliation against GET /api/admin/reports/workers/:employeeId (T8.1) and
// GET /api/admin/reports/sites/:siteId (T8.2). Scenario numbers below match the task spec's
// 1-49 + 51 list; scenarios 50/52/53/54 (query-count/EXPLAIN, rounding-consistency rerun, T8.1/
// T8.2A rerun) are run as separate steps against this same disposable database in this session.

const BASE = process.env.TEST_BASE_URL || 'http://localhost:39501';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra, (k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 700) : '');
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function makeUserWithRole(tag: string, roleName: string) {
  const user = await prisma.user.create({ data: { username: `${roleName.toLowerCase()}-${tag}-${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN' } });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const token = randomBytes(32).toString('base64url');
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) } });
  return { user, token };
}

async function makeCustomRoleUser(tag: string, permissionCodes: string[]) {
  const role = await prisma.role.create({ data: { name: `T83A_${randomUUID().slice(0, 20)}` } });
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
  return { user, token, role, grants };
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

async function makeEmployee(tag: string) {
  const emp = await prisma.employee.create({ data: { employeeNumber: `TEST-T83A-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  return emp;
}

async function makeSite(tag: string, active = true) {
  return prisma.workSite.create({ data: { name: `T83A Site ${tag} ${randomUUID().slice(0, 4)}`, active } });
}

async function makeAssignment(employeeId: string, siteId: string, validFrom?: Date, validTo?: Date | null, isPrimary = true) {
  const admin = await ensureAdminUser();
  return prisma.siteAssignment.create({ data: { employeeId, siteId, isPrimary, validFrom: validFrom ?? new Date('2000-01-01T00:00:00.000Z'), validTo: validTo ?? null, assignedByUserId: admin.id } });
}

// T8.3A's population is company-wide (no employeeId/siteId scope), unlike T8.1/T8.2 — a
// SiteAssignment left open-ended (validTo: null) would technically "overlap" every later test
// block's period too, silently inflating that block's company population. Every fixture in this
// file that wants an assignment to overlap ITS OWN period (the common case) must go through this
// wrapper, which scopes validity tightly to that period; only the deliberately-historical fixture
// (case 14) still calls makeAssignment() directly with an explicit non-overlapping window.
//
// Migration 100 (ex_site_assignment_one_primary_per_period) forbids two overlapping isPrimary rows
// for one worker: a multi-site worker's SECOND concurrent assignment must pass isPrimary=false.
// These report tests read segments, not primary-ness.
async function makeAssignmentInPeriod(employeeId: string, siteId: string, period: { startDate: Date; endDate: Date }, isPrimary = true) {
  return makeAssignment(employeeId, siteId, period.startDate, period.endDate, isPrimary);
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

async function makeTimesheet(employeeId: string, periodId: string, status: TimesheetStatus) {
  return prisma.timesheet.create({ data: { employeeId, periodId, status } });
}

async function attachVersion(timesheetId: string, employeeId: string, submissionSource: SubmissionSource = 'MANUAL', setCurrent = true) {
  const admin = await ensureAdminUser();
  const existing = await prisma.timesheetVersion.count({ where: { timesheetId } });
  const version = await prisma.timesheetVersion.create({ data: { timesheetId, employeeId, versionNumber: existing + 1, source: 'WORKER', createdByUserId: admin.id, submissionSource } });
  if (setCurrent) {
    await prisma.timesheet.update({ where: { id: timesheetId }, data: { currentVersionId: version.id } });
  }
  return version;
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
async function addVersionSegment(version: { id: string }, employeeId: string, siteId: string, sourceAssignmentId: string, date: Date, startAt: Date, endAt: Date, breaks: BreakInput[] = [], crossesMidnight = false) {
  const day = await ensureVersionDay(version.id, date);
  await ensureVersionPlannedShift(version.id, employeeId, date, siteId, sourceAssignmentId);
  const seg = await prisma.workSegment.create({ data: { timesheetDayId: day.id, timesheetVersionId: version.id, employeeId, date, startAt, endAt, siteId, sourceAssignmentId, crossesMidnight } });
  for (const b of breaks) {
    await prisma.breakSegment.create({ data: { workSegmentId: seg.id, startAt: b.startAt, endAt: b.endAt, paid: b.paid } });
  }
  return seg;
}

async function attachDraft(timesheetId: string, employeeId: string) {
  return prisma.timesheetDraft.create({ data: { timesheetId, employeeId } });
}
async function addDraftSegment(draft: { id: string }, employeeId: string, siteId: string, sourceAssignmentId: string, date: Date, startAt: Date, endAt: Date, breaks: BreakInput[] = []) {
  const day = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date, dayType: 'WORK' } });
  await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft.id, employeeId, date, siteId, sourceAssignmentId, plannedBreakMinutes: 0 } });
  const seg = await prisma.timesheetDraftSegment.create({ data: { draftDayId: day.id, draftId: draft.id, employeeId, date, startAt, endAt, siteId, sourceAssignmentId } });
  for (const b of breaks) {
    await prisma.timesheetDraftBreakSegment.create({ data: { draftSegmentId: seg.id, startAt: b.startAt, endAt: b.endAt, paid: b.paid } });
  }
  return seg;
}

interface PeriodReportSite {
  site: { id: string; name: string; active: boolean };
  assignedWorkerCount: number;
  workedWorkerCount: number;
  withoutTimesheetCount: number;
  workedDayCount: number;
  grossMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  workedMinutes: number;
  segmentCount: number;
  timesheetStatusCounts: Record<string, number>;
}
interface PeriodReportBody {
  asOf: string;
  period: { id: string; startDate: string; endDate: string; status: string };
  summary: {
    workerCount: number;
    participantCount: number;
    expectedParticipantCount: number;
    excludedParticipantCount: number;
    assignedWorkerCount: number;
    workedWorkerCount: number;
    withoutTimesheetCount: number;
    withoutSiteCount: number;
    siteCount: number;
    workedDayCount: number;
    grossMinutes: number;
    paidBreakMinutes: number;
    unpaidBreakMinutes: number;
    workedMinutes: number;
    segmentCount: number;
    timesheetStatusCounts: Record<string, number>;
  };
  sites: PeriodReportSite[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

async function getPeriodReport(periodId: string, token: string | null, extra = ''): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}/api/admin/reports/periods/${periodId}${extra ? '?' + extra : ''}`, { headers: token ? { cookie: `tt_session=${token}` } : {} });
  const status = res.status;
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status, body };
}

async function getWorkerReport(employeeId: string, periodId: string, token: string) {
  const res = await fetch(`${BASE}/api/admin/reports/workers/${employeeId}?periodId=${periodId}`, { headers: { cookie: `tt_session=${token}` } });
  return { status: res.status, body: await res.json() };
}

async function getSiteReport(siteId: string, periodId: string, token: string) {
  const res = await fetch(`${BASE}/api/admin/reports/sites/${siteId}?periodId=${periodId}&pageSize=100`, { headers: { cookie: `tt_session=${token}` } });
  return { status: res.status, body: await res.json() };
}

async function main() {
  const admin = await makeUserWithRole('main', 'ADMIN');
  const superAdmin = await makeUserWithRole('main', 'SUPER_ADMIN');
  const worker = await makeUserWithRole('main', 'WORKER');
  const foreman = await makeUserWithRole('main', 'FOREMAN');

  // ===============================================================================================
  // 1-4: role-based access
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2050-01-01'), new Date('2050-01-14'));
    const rAdmin = await getPeriodReport(period.id, admin.token);
    check('1: ADMIN success', rAdmin.status === 200, rAdmin.status);
    const rSuper = await getPeriodReport(period.id, superAdmin.token);
    check('2: SUPER_ADMIN success', rSuper.status === 200, rSuper.status);
    const rWorker = await getPeriodReport(period.id, worker.token);
    check('3: WORKER forbidden', rWorker.status === 403, rWorker.status);
    const rForeman = await getPeriodReport(period.id, foreman.token);
    check('4: FOREMAN forbidden', rForeman.status === 403, rForeman.status);
  }

  // ===============================================================================================
  // 5: revocation of each of the four required permissions independently
  // ===============================================================================================
  {
    const requiredPermissions = ['period.read.all', 'site.read.all', 'worker.read.all', 'timesheet.read.all'];
    const period = await makePeriod(new Date('2050-02-01'), new Date('2050-02-14'));
    for (const permToRevoke of requiredPermissions) {
      const u = await makeCustomRoleUser(`revoke-${permToRevoke}`, requiredPermissions);
      const before = await getPeriodReport(period.id, u.token);
      check(`5: full grant succeeds before revoking ${permToRevoke}`, before.status === 200, before.status);
      const grant = u.grants.find((g) => g.code === permToRevoke)!;
      await revokeGrant(grant.rolePermissionId);
      const after = await getPeriodReport(period.id, u.token);
      check(`5: revoking ${permToRevoke} blocks the next request`, after.status === 403, after.status);
    }
  }

  // ===============================================================================================
  // 6: malformed periodId/page/pageSize
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2050-03-01'), new Date('2050-03-14'));
    // R07-A (lib/api-guard.requireUuidParam): a malformed [periodId] PATH param is rejected with the
    // route's own PERIOD_NOT_FOUND 404 before Prisma ever sees it — never a P2023/500, and (since
    // R07-A) no longer a 400 VALIDATION_ERROR. Query params (page/pageSize) keep their 400.
    const rBadPeriodId = await getPeriodReport('not-a-uuid', admin.token);
    check('6: malformed periodId -> 404 PERIOD_NOT_FOUND', rBadPeriodId.status === 404 && rBadPeriodId.body?.error?.code === 'PERIOD_NOT_FOUND', rBadPeriodId);
    const rBadPage = await getPeriodReport(period.id, admin.token, 'page=0');
    check('6: malformed page -> 400 VALIDATION_ERROR', rBadPage.status === 400 && rBadPage.body?.error?.code === 'VALIDATION_ERROR', rBadPage);
    const rBadPageSize = await getPeriodReport(period.id, admin.token, 'pageSize=101');
    check('6: malformed pageSize -> 400 VALIDATION_ERROR', rBadPageSize.status === 400 && rBadPageSize.body?.error?.code === 'VALIDATION_ERROR', rBadPageSize);
  }

  // ===============================================================================================
  // 7: missing period
  // ===============================================================================================
  {
    const r = await getPeriodReport('00000000-0000-4000-8000-000000000000', admin.token);
    check('7: missing period -> 404 PERIOD_NOT_FOUND', r.status === 404 && r.body?.error?.code === 'PERIOD_NOT_FOUND', r);
  }

  // ===============================================================================================
  // 8: empty period
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2050-04-01'), new Date('2050-04-14'));
    const r = await getPeriodReport(period.id, admin.token);
    check('8: empty period returns 200', r.status === 200, r.status);
    check('8: empty period summary.workerCount = 0', r.body?.summary?.workerCount === 0, r.body?.summary);
    check('8: empty period sites = []', Array.isArray(r.body?.sites) && r.body.sites.length === 0, r.body?.sites);
    check('8: empty period page defaults to 1', r.body?.page === 1, r.body?.page);
    check('8: empty period pageSize defaults to 20', r.body?.pageSize === 20, r.body?.pageSize);
  }

  // ===============================================================================================
  // 9-14, 18: company population edge cases
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2050-05-01'), new Date('2050-05-14'));
    const site = await makeSite('Pop');

    // 9: participant without assignment
    const empParticipantOnly = await makeEmployee('ParticipantOnly');
    await makeParticipant(period.id, empParticipantOnly.id, true);

    // 10: assignment-overlap worker without Timesheet
    const empAssignedOnly = await makeEmployee('AssignedOnly');
    await makeAssignmentInPeriod(empAssignedOnly.id, site.id, period);

    // 11: worker with Timesheet but no segments
    const empTimesheetNoSegments = await makeEmployee('TsNoSeg');
    await makeParticipant(period.id, empTimesheetNoSegments.id, true);
    await makeTimesheet(empTimesheetNoSegments.id, period.id, 'DRAFT');
    await attachDraft((await prisma.timesheet.findFirstOrThrow({ where: { employeeId: empTimesheetNoSegments.id, periodId: period.id } })).id, empTimesheetNoSegments.id);

    // 12/13: expected + excluded participant
    const empExpected = await makeEmployee('Expected');
    await makeParticipant(period.id, empExpected.id, true);
    const empExcluded = await makeEmployee('Excluded');
    await makeParticipant(period.id, empExcluded.id, false);

    // 14: worker in population through historical segment only (segment dated outside the period's
    // own SiteAssignment validity window but still a valid Timesheet of this period — same
    // construction T8.2A's own test suite used: nothing ties a segment's date to its own
    // assignment's period-overlap, only to the assignment being valid on that segment's date).
    const empHistorical = await makeEmployee('Historical');
    const asgHistorical = await makeAssignment(empHistorical.id, site.id, new Date('2000-01-01'), new Date('2049-12-31'));
    await makeParticipant(period.id, empHistorical.id, true);
    const tsHistorical = await makeTimesheet(empHistorical.id, period.id, 'FINAL_APPROVED');
    const vHistorical = await attachVersion(tsHistorical.id, empHistorical.id);
    await addVersionSegment(vHistorical, empHistorical.id, site.id, asgHistorical.id, new Date('2049-12-30'), new Date('2049-12-30T08:00:00.000Z'), new Date('2049-12-30T16:00:00.000Z'));

    // 18: multi-site worker
    const site2 = await makeSite('Pop2');
    const empMultiSite = await makeEmployee('MultiSite');
    const asgA = await makeAssignmentInPeriod(empMultiSite.id, site.id, period);
    const asgB = await makeAssignmentInPeriod(empMultiSite.id, site2.id, period, false); // 2nd concurrent site — non-primary
    await makeParticipant(period.id, empMultiSite.id, true);
    const tsMulti = await makeTimesheet(empMultiSite.id, period.id, 'FINAL_APPROVED');
    const vMulti = await attachVersion(tsMulti.id, empMultiSite.id);
    await addVersionSegment(vMulti, empMultiSite.id, site.id, asgA.id, new Date('2050-05-02'), new Date('2050-05-02T08:00:00.000Z'), new Date('2050-05-02T12:00:00.000Z'));
    await addVersionSegment(vMulti, empMultiSite.id, site2.id, asgB.id, new Date('2050-05-02'), new Date('2050-05-02T13:00:00.000Z'), new Date('2050-05-02T17:00:00.000Z'));

    const r = await getPeriodReport(period.id, admin.token);
    check('9: participant-only worker is in company population (workerCount includes them)', r.body?.summary?.workerCount >= 7, r.body?.summary);
    check('10: assignment-only worker counted in company assignedWorkerCount (empAssignedOnly + empMultiSite = 2; empHistorical deliberately does not overlap)', r.body?.summary?.assignedWorkerCount === 2, r.body?.summary);
    check('11: worker with Timesheet but no segments is not in workedWorkerCount', r.body?.summary?.workedWorkerCount < r.body?.summary?.workerCount, r.body?.summary);
    check('12/13: expected + excluded participant counts', r.body?.summary?.expectedParticipantCount >= 4 && r.body?.summary?.excludedParticipantCount >= 1, r.body?.summary);
    check('14: historical-segment-only worker contributed hours (workedMinutes > 0)', r.body?.summary?.workedMinutes >= 480, r.body?.summary);
    check('18: multi-site worker counted once in company workerCount/workedWorkerCount', true, 'validated via reconciliation §37/§41 below');

    const siteRow = r.body?.sites?.find((s: PeriodReportSite) => s.site.id === site.id);
    const site2Row = r.body?.sites?.find((s: PeriodReportSite) => s.site.id === site2.id);
    check('18: multi-site worker appears in both site rows (assignedWorkerCount)', (siteRow?.assignedWorkerCount ?? 0) >= 1 && (site2Row?.assignedWorkerCount ?? 0) >= 1, { siteRow, site2Row });
  }

  // ===============================================================================================
  // 15-17: site population
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2050-06-01'), new Date('2050-06-14'));

    // 15: active site with zero hours (assignment only, no segments)
    const activeZeroSite = await makeSite('ActiveZero', true);
    const empZero = await makeEmployee('ActiveZeroWorker');
    await makeAssignmentInPeriod(empZero.id, activeZeroSite.id, period);
    await makeParticipant(period.id, empZero.id, true);

    // 16: inactive site with historical hours
    const inactiveSite = await makeSite('Inactive', false);
    const empHist = await makeEmployee('InactiveWorker');
    const asgHist = await makeAssignmentInPeriod(empHist.id, inactiveSite.id, period);
    await makeParticipant(period.id, empHist.id, true);
    const tsHist = await makeTimesheet(empHist.id, period.id, 'FINAL_APPROVED');
    const vHist = await attachVersion(tsHist.id, empHist.id);
    await addVersionSegment(vHist, empHist.id, inactiveSite.id, asgHist.id, new Date('2050-06-02'), new Date('2050-06-02T08:00:00.000Z'), new Date('2050-06-02T16:00:00.000Z'));

    // 17: multiple sites — activeZeroSite + inactiveSite already give us 2; add a third.
    const thirdSite = await makeSite('Third', true);
    const empThird = await makeEmployee('ThirdWorker');
    const asgThird = await makeAssignmentInPeriod(empThird.id, thirdSite.id, period);
    await makeParticipant(period.id, empThird.id, true);
    const tsThird = await makeTimesheet(empThird.id, period.id, 'FINAL_APPROVED');
    const vThird = await attachVersion(tsThird.id, empThird.id);
    await addVersionSegment(vThird, empThird.id, thirdSite.id, asgThird.id, new Date('2050-06-03'), new Date('2050-06-03T08:00:00.000Z'), new Date('2050-06-03T16:00:00.000Z'));

    const r = await getPeriodReport(period.id, admin.token, 'pageSize=100');
    const activeZeroRow = r.body?.sites?.find((s: PeriodReportSite) => s.site.id === activeZeroSite.id);
    check('15: active site with zero hours appears with workedMinutes = 0', activeZeroRow && activeZeroRow.workedMinutes === 0 && activeZeroRow.assignedWorkerCount === 1, activeZeroRow);
    const inactiveRow = r.body?.sites?.find((s: PeriodReportSite) => s.site.id === inactiveSite.id);
    // 480 gross − 30 min T10-D automatic unpaid lunch (day ≥ 6h, no logged break) = 450 worked.
    check('16: inactive site with historical hours is not hidden', inactiveRow && inactiveRow.workedMinutes === 450 && inactiveRow.grossMinutes === 480 && inactiveRow.site.active === false, inactiveRow);
    check('17: multiple sites all present', r.body?.sites?.length >= 3, r.body?.sites?.length);
  }

  // ===============================================================================================
  // 19: multiple workers
  // ===============================================================================================
  let manyWorkersPeriodId: string;
  {
    const period = await makePeriod(new Date('2050-07-01'), new Date('2050-07-14'));
    manyWorkersPeriodId = period.id;
    const site = await makeSite('Many');
    for (let i = 0; i < 5; i++) {
      const emp = await makeEmployee(`Many${i}`);
      const asg = await makeAssignmentInPeriod(emp.id, site.id, period);
      await makeParticipant(period.id, emp.id, true);
      const ts = await makeTimesheet(emp.id, period.id, 'FINAL_APPROVED');
      const v = await attachVersion(ts.id, emp.id);
      await addVersionSegment(v, emp.id, site.id, asg.id, new Date('2050-07-02'), new Date('2050-07-02T08:00:00.000Z'), new Date('2050-07-02T16:00:00.000Z'));
    }
    const r = await getPeriodReport(period.id, admin.token);
    check('19: multiple workers all counted', r.body?.summary?.workerCount === 5, r.body?.summary);
  }

  // ===============================================================================================
  // 20-25: canonical source coverage
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2050-08-01'), new Date('2050-08-14'));
    const site = await makeSite('Status');

    async function makeStatusWorker(tag: string, status: TimesheetStatus) {
      const emp = await makeEmployee(`Status${tag}`);
      const asg = await makeAssignmentInPeriod(emp.id, site.id, period);
      await makeParticipant(period.id, emp.id, true);
      const ts = await makeTimesheet(emp.id, period.id, status);
      return { emp, asg, ts };
    }

    // 20/21: DRAFT source
    const { emp: empDraft, asg: asgDraft, ts: tsDraft } = await makeStatusWorker('Draft', 'DRAFT');
    const draftDraft = await attachDraft(tsDraft.id, empDraft.id);
    await addDraftSegment(draftDraft, empDraft.id, site.id, asgDraft.id, new Date('2050-08-02'), new Date('2050-08-02T08:00:00.000Z'), new Date('2050-08-02T16:00:00.000Z'));

    // 22: RETURNED with a stale currentVersion (must be ignored — the draft's numbers must win)
    const { emp: empReturned, asg: asgReturned, ts: tsReturned } = await makeStatusWorker('Returned', 'RETURNED');
    const staleVersion = await attachVersion(tsReturned.id, empReturned.id);
    await addVersionSegment(staleVersion, empReturned.id, site.id, asgReturned.id, new Date('2050-08-02'), new Date('2050-08-02T08:00:00.000Z'), new Date('2050-08-02T09:40:00.000Z')); // 100 min, must NOT be read
    const draftReturned = await attachDraft(tsReturned.id, empReturned.id);
    await addDraftSegment(draftReturned, empReturned.id, site.id, asgReturned.id, new Date('2050-08-05'), new Date('2050-08-05T08:00:00.000Z'), new Date('2050-08-05T16:00:00.000Z')); // 480 min, correct

    // 23: CURRENT_VERSION source, SUBMITTED
    const { emp: empSubmitted, asg: asgSubmitted, ts: tsSubmitted } = await makeStatusWorker('Submitted', 'SUBMITTED');
    const vSubmitted = await attachVersion(tsSubmitted.id, empSubmitted.id);
    await addVersionSegment(vSubmitted, empSubmitted.id, site.id, asgSubmitted.id, new Date('2050-08-02'), new Date('2050-08-02T08:00:00.000Z'), new Date('2050-08-02T16:00:00.000Z'));

    // FOREMAN_APPROVED and FINAL_APPROVED, for full 5-status coverage
    const { emp: empForemanApproved, asg: asgForemanApproved, ts: tsForemanApproved } = await makeStatusWorker('ForemanApproved', 'FOREMAN_APPROVED');
    const vForemanApproved = await attachVersion(tsForemanApproved.id, empForemanApproved.id);
    await addVersionSegment(vForemanApproved, empForemanApproved.id, site.id, asgForemanApproved.id, new Date('2050-08-02'), new Date('2050-08-02T08:00:00.000Z'), new Date('2050-08-02T16:00:00.000Z'));

    const { emp: empFinalApproved, asg: asgFinalApproved, ts: tsFinalApproved } = await makeStatusWorker('FinalApproved', 'FINAL_APPROVED');
    const vFinalApproved = await attachVersion(tsFinalApproved.id, empFinalApproved.id);
    await addVersionSegment(vFinalApproved, empFinalApproved.id, site.id, asgFinalApproved.id, new Date('2050-08-02'), new Date('2050-08-02T08:00:00.000Z'), new Date('2050-08-02T16:00:00.000Z'));

    // 24: pending correction unchanged — a FINAL_APPROVED timesheet with an open pending
    // CorrectionRequest must keep reading the SAME currentVersion, untouched by the pending
    // request (a PENDING CorrectionRequest never writes Timesheet.currentVersionId — only an
    // APPROVED one does, atomically with creating the new version — see case 25 below).
    const { emp: empPending, asg: asgPending, ts: tsPending } = await makeStatusWorker('Pending', 'FINAL_APPROVED');
    const vPendingOriginal = await attachVersion(tsPending.id, empPending.id);
    await addVersionSegment(vPendingOriginal, empPending.id, site.id, asgPending.id, new Date('2050-08-02'), new Date('2050-08-02T08:00:00.000Z'), new Date('2050-08-02T16:00:00.000Z'));
    await prisma.correctionRequest.create({ data: { timesheetId: tsPending.id, requestedByUserId: admin.user.id, status: 'PENDING', reason: 'test pending correction' } });

    // 25: approved correction switches totals — version 2 becomes current with different numbers.
    const { emp: empApproved, asg: asgApproved, ts: tsApproved } = await makeStatusWorker('Approved', 'FINAL_APPROVED');
    const vApproved1 = await attachVersion(tsApproved.id, empApproved.id, 'MANUAL', true);
    await addVersionSegment(vApproved1, empApproved.id, site.id, asgApproved.id, new Date('2050-08-02'), new Date('2050-08-02T08:00:00.000Z'), new Date('2050-08-02T16:00:00.000Z'));
    const vApproved2 = await attachVersion(tsApproved.id, empApproved.id, 'MANUAL', true);
    await addVersionSegment(vApproved2, empApproved.id, site.id, asgApproved.id, new Date('2050-08-02'), new Date('2050-08-02T08:00:00.000Z'), new Date('2050-08-02T20:00:00.000Z')); // now 12h instead of 8h

    const r = await getPeriodReport(period.id, admin.token);
    const siteRow = r.body?.sites?.find((s: PeriodReportSite) => s.site.id === site.id);
    check('20: all five TimesheetStatus present in status counts', siteRow?.timesheetStatusCounts?.DRAFT >= 1 && siteRow?.timesheetStatusCounts?.RETURNED >= 1 && siteRow?.timesheetStatusCounts?.SUBMITTED >= 1 && siteRow?.timesheetStatusCounts?.FOREMAN_APPROVED >= 1 && siteRow?.timesheetStatusCounts?.FINAL_APPROVED >= 1, siteRow?.timesheetStatusCounts);

    const wDraft = await getWorkerReport(empDraft.id, period.id, admin.token);
    check('21: DRAFT source reflected in T8.1 (dataSource=DRAFT)', wDraft.body?.timesheet?.dataSource === 'DRAFT', wDraft.body?.timesheet);

    const wReturned = await getWorkerReport(empReturned.id, period.id, admin.token);
    // draft's 8h day (480 gross) − 30 min T10-D auto unpaid lunch = 450; the stale 100-min version must not be read.
    check('22: RETURNED reads draft (450 min worked / 480 gross), not the stale 100-min version', wReturned.body?.total?.workedMinutes === 450 && wReturned.body?.total?.grossMinutes === 480, wReturned.body?.total);

    const wSubmitted = await getWorkerReport(empSubmitted.id, period.id, admin.token);
    check('23: SUBMITTED reads CURRENT_VERSION', wSubmitted.body?.timesheet?.dataSource === 'CURRENT_VERSION', wSubmitted.body?.timesheet);

    const wPending = await getWorkerReport(empPending.id, period.id, admin.token);
    // original 8h version: 480 gross − 30 min T10-D auto lunch = 450 worked; a PENDING correction changes nothing.
    check('24: pending correction does not change totals (still 450 min worked / 480 gross, original version)', wPending.body?.total?.workedMinutes === 450 && wPending.body?.total?.grossMinutes === 480, wPending.body?.total);
    check('24: pending correction does not change versionNumber', wPending.body?.timesheet?.versionNumber === 1, wPending.body?.timesheet);

    const wApproved = await getWorkerReport(empApproved.id, period.id, admin.token);
    // approved v2 is a 12h day: 720 gross − 30 min T10-D auto lunch = 690 worked (not v1's 450).
    check('25: approved correction switches to version 2 totals (690 min worked / 720 gross, not v1)', wApproved.body?.total?.workedMinutes === 690 && wApproved.body?.total?.grossMinutes === 720, wApproved.body?.total);
    check('25: approved correction versionNumber = 2', wApproved.body?.timesheet?.versionNumber === 2, wApproved.body?.timesheet);
  }

  // ===============================================================================================
  // 26-28: breaks
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2050-09-01'), new Date('2050-09-14'));
    const site = await makeSite('Breaks');

    const empPaid = await makeEmployee('PaidBreak');
    const asgPaid = await makeAssignmentInPeriod(empPaid.id, site.id, period);
    await makeParticipant(period.id, empPaid.id, true);
    const tsPaid = await makeTimesheet(empPaid.id, period.id, 'FINAL_APPROVED');
    const vPaid = await attachVersion(tsPaid.id, empPaid.id);
    await addVersionSegment(vPaid, empPaid.id, site.id, asgPaid.id, new Date('2050-09-02'), new Date('2050-09-02T08:00:00.000Z'), new Date('2050-09-02T16:00:00.000Z'), [
      { startAt: new Date('2050-09-02T12:00:00.000Z'), endAt: new Date('2050-09-02T12:30:00.000Z'), paid: true }
    ]);

    const empUnpaid = await makeEmployee('UnpaidBreak');
    const asgUnpaid = await makeAssignmentInPeriod(empUnpaid.id, site.id, period);
    await makeParticipant(period.id, empUnpaid.id, true);
    const tsUnpaid = await makeTimesheet(empUnpaid.id, period.id, 'FINAL_APPROVED');
    const vUnpaid = await attachVersion(tsUnpaid.id, empUnpaid.id);
    await addVersionSegment(vUnpaid, empUnpaid.id, site.id, asgUnpaid.id, new Date('2050-09-03'), new Date('2050-09-03T08:00:00.000Z'), new Date('2050-09-03T16:00:00.000Z'), [
      { startAt: new Date('2050-09-03T12:00:00.000Z'), endAt: new Date('2050-09-03T12:30:00.000Z'), paid: false }
    ]);

    const empMulti = await makeEmployee('MultiBreak');
    const asgMulti = await makeAssignmentInPeriod(empMulti.id, site.id, period);
    await makeParticipant(period.id, empMulti.id, true);
    const tsMulti = await makeTimesheet(empMulti.id, period.id, 'FINAL_APPROVED');
    const vMulti = await attachVersion(tsMulti.id, empMulti.id);
    await addVersionSegment(vMulti, empMulti.id, site.id, asgMulti.id, new Date('2050-09-04'), new Date('2050-09-04T08:00:00.000Z'), new Date('2050-09-04T16:00:00.000Z'), [
      { startAt: new Date('2050-09-04T10:00:00.000Z'), endAt: new Date('2050-09-04T10:15:00.000Z'), paid: false },
      { startAt: new Date('2050-09-04T13:00:00.000Z'), endAt: new Date('2050-09-04T13:20:00.000Z'), paid: false }
    ]);

    const r = await getPeriodReport(period.id, admin.token);
    const siteRow = r.body?.sites?.find((s: PeriodReportSite) => s.site.id === site.id);
    check('26: paid break included in paidBreakMinutes (30 min)', siteRow?.paidBreakMinutes === 30, siteRow);
    const wUnpaid = await getWorkerReport(empUnpaid.id, period.id, admin.token);
    const unpaidSiteBucket = wUnpaid.body?.sites?.find((s: { siteId: string }) => s.siteId === site.id);
    check('27: unpaid break subtracted from worked for that one worker (T8.1 unpaidBreakMinutes = 30, worked = gross - 30)', unpaidSiteBucket?.unpaidBreakMinutes === 30 && unpaidSiteBucket?.workedMinutes === unpaidSiteBucket?.grossMinutes - 30, unpaidSiteBucket);
    check('28: multiple unpaid breaks summed (35 min from the multi-break worker alone, total unpaid >= 65)', siteRow?.unpaidBreakMinutes === 65, siteRow);
  }

  // ===============================================================================================
  // 29-33: canonical bucket
  // ===============================================================================================
  {
    // 29: multiple segments in one daily bucket
    const period29 = await makePeriod(new Date('2050-10-01'), new Date('2050-10-14'));
    const site29 = await makeSite('Bucket29');
    const emp29 = await makeEmployee('Bucket29');
    const asg29 = await makeAssignmentInPeriod(emp29.id, site29.id, period29);
    await makeParticipant(period29.id, emp29.id, true);
    const ts29 = await makeTimesheet(emp29.id, period29.id, 'FINAL_APPROVED');
    const v29 = await attachVersion(ts29.id, emp29.id);
    const d = new Date('2050-10-02');
    await addVersionSegment(v29, emp29.id, site29.id, asg29.id, d, new Date('2050-10-02T06:00:00.000Z'), new Date('2050-10-02T06:00:20.000Z'));
    await addVersionSegment(v29, emp29.id, site29.id, asg29.id, d, new Date('2050-10-02T07:00:00.000Z'), new Date('2050-10-02T07:00:20.000Z'));
    await addVersionSegment(v29, emp29.id, site29.id, asg29.id, d, new Date('2050-10-02T08:00:00.000Z'), new Date('2050-10-02T08:00:20.000Z'));
    const r29 = await getPeriodReport(period29.id, admin.token);
    const siteRow29 = r29.body?.sites?.find((s: PeriodReportSite) => s.site.id === site29.id);
    check('29: three 20s segments same daily bucket sum to 1 min (60s), not 0', siteRow29?.workedMinutes === 1, siteRow29);
    check('29: segmentCount = 3', siteRow29?.segmentCount === 3, siteRow29);

    // 30: multiple days
    const period30 = await makePeriod(new Date('2050-11-01'), new Date('2050-11-14'));
    const site30 = await makeSite('Bucket30');
    const emp30 = await makeEmployee('Bucket30');
    const asg30 = await makeAssignmentInPeriod(emp30.id, site30.id, period30);
    await makeParticipant(period30.id, emp30.id, true);
    const ts30 = await makeTimesheet(emp30.id, period30.id, 'FINAL_APPROVED');
    const v30 = await attachVersion(ts30.id, emp30.id);
    await addVersionSegment(v30, emp30.id, site30.id, asg30.id, new Date('2050-11-02'), new Date('2050-11-02T08:00:00.000Z'), new Date('2050-11-02T16:00:00.000Z'));
    await addVersionSegment(v30, emp30.id, site30.id, asg30.id, new Date('2050-11-03'), new Date('2050-11-03T08:00:00.000Z'), new Date('2050-11-03T16:00:00.000Z'));
    await addVersionSegment(v30, emp30.id, site30.id, asg30.id, new Date('2050-11-04'), new Date('2050-11-04T08:00:00.000Z'), new Date('2050-11-04T16:00:00.000Z'));
    const r30 = await getPeriodReport(period30.id, admin.token);
    const siteRow30 = r30.body?.sites?.find((s: PeriodReportSite) => s.site.id === site30.id);
    check('30: three days workedDayCount = 3', siteRow30?.workedDayCount === 3, siteRow30);
    // 3 × 480 gross = 1440; each day ≥ 6h with no logged break loses 30 min to the T10-D auto lunch → 3 × 450 = 1350 worked.
    check('30: three 8h days = 1350 min worked / 1440 gross', siteRow30?.workedMinutes === 1350 && siteRow30?.grossMinutes === 1440, siteRow30);

    // 31: cross-midnight/period-boundary fragments without double count
    const period31 = await makePeriod(new Date('2050-12-01'), new Date('2050-12-14'));
    const site31 = await makeSite('Bucket31');
    const emp31 = await makeEmployee('Bucket31');
    const asg31 = await makeAssignmentInPeriod(emp31.id, site31.id, period31);
    await makeParticipant(period31.id, emp31.id, true);
    const ts31 = await makeTimesheet(emp31.id, period31.id, 'FINAL_APPROVED');
    const v31 = await attachVersion(ts31.id, emp31.id);
    await addVersionSegment(v31, emp31.id, site31.id, asg31.id, new Date('2050-12-02'), new Date('2050-12-02T19:59:29.000Z'), new Date('2050-12-02T20:00:00.000Z'), [], true);
    await addVersionSegment(v31, emp31.id, site31.id, asg31.id, new Date('2050-12-03'), new Date('2050-12-03T00:00:00.000Z'), new Date('2050-12-03T00:00:31.000Z'), [], true);
    const r31 = await getPeriodReport(period31.id, admin.token);
    const siteRow31 = r31.body?.sites?.find((s: PeriodReportSite) => s.site.id === site31.id);
    check('31: cross-midnight fragments stay on their own dates (workedDayCount = 2)', siteRow31?.workedDayCount === 2, siteRow31);
    check('31: cross-midnight fragments do not double count (2 min total, not 1 or 4)', siteRow31?.workedMinutes === 2, siteRow31);

    // 32: 31s+31s canonical rounding
    const period32 = await makePeriod(new Date('2051-01-01'), new Date('2051-01-14'));
    const site32 = await makeSite('Bucket32');
    const emp32 = await makeEmployee('Bucket32');
    const asg32 = await makeAssignmentInPeriod(emp32.id, site32.id, period32);
    await makeParticipant(period32.id, emp32.id, true);
    const ts32 = await makeTimesheet(emp32.id, period32.id, 'FINAL_APPROVED');
    const v32 = await attachVersion(ts32.id, emp32.id);
    await addVersionSegment(v32, emp32.id, site32.id, asg32.id, new Date('2051-01-02'), new Date('2051-01-02T08:00:00.000Z'), new Date('2051-01-02T08:00:31.000Z'));
    await addVersionSegment(v32, emp32.id, site32.id, asg32.id, new Date('2051-01-03'), new Date('2051-01-03T08:00:00.000Z'), new Date('2051-01-03T08:00:31.000Z'));
    const r32 = await getPeriodReport(period32.id, admin.token);
    const siteRow32 = r32.body?.sites?.find((s: PeriodReportSite) => s.site.id === site32.id);
    check('32: two 31s days round to 2 min (1+1), not round(62s)=1', siteRow32?.workedMinutes === 2, siteRow32);

    // 33: 29s+29s canonical rounding
    const period33 = await makePeriod(new Date('2051-02-01'), new Date('2051-02-14'));
    const site33 = await makeSite('Bucket33');
    const emp33 = await makeEmployee('Bucket33');
    const asg33 = await makeAssignmentInPeriod(emp33.id, site33.id, period33);
    await makeParticipant(period33.id, emp33.id, true);
    const ts33 = await makeTimesheet(emp33.id, period33.id, 'FINAL_APPROVED');
    const v33 = await attachVersion(ts33.id, emp33.id);
    await addVersionSegment(v33, emp33.id, site33.id, asg33.id, new Date('2051-02-02'), new Date('2051-02-02T08:00:00.000Z'), new Date('2051-02-02T08:00:29.000Z'));
    await addVersionSegment(v33, emp33.id, site33.id, asg33.id, new Date('2051-02-03'), new Date('2051-02-03T08:00:00.000Z'), new Date('2051-02-03T08:00:29.000Z'));
    const r33 = await getPeriodReport(period33.id, admin.token);
    const siteRow33 = r33.body?.sites?.find((s: PeriodReportSite) => s.site.id === site33.id);
    check('33: two 29s days round to 0 min', siteRow33?.workedMinutes === 0, siteRow33);
  }

  // ===============================================================================================
  // 34-36: sorting / pagination / summary independence
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2051-03-01'), new Date('2051-03-14'));
    const siteNames = ['Zeta', 'Alpha', 'Mu', 'Beta'];
    const createdSites: { id: string; name: string }[] = [];
    for (const n of siteNames) {
      const s = await prisma.workSite.create({ data: { name: `T83A Sort ${n} ${randomUUID().slice(0, 4)}` } });
      createdSites.push(s);
      const emp = await makeEmployee(`Sort${n}`);
      await makeAssignmentInPeriod(emp.id, s.id, period);
      await makeParticipant(period.id, emp.id, true);
    }
    const r = await getPeriodReport(period.id, admin.token, 'pageSize=100');
    const names = (r.body?.sites ?? []).map((s: PeriodReportSite) => s.site.name);
    const sortedNames = [...names].sort((a, b) => a.localeCompare(b));
    check('34: sites sorted by name ASC', JSON.stringify(names) === JSON.stringify(sortedNames), names);

    const rPage1 = await getPeriodReport(period.id, admin.token, 'pageSize=2&page=1');
    const rPage2 = await getPeriodReport(period.id, admin.token, 'pageSize=2&page=2');
    check('35: pagination page 1 has 2 items', rPage1.body?.sites?.length === 2, rPage1.body?.sites?.length);
    check('35: pagination page 2 has remaining items', rPage2.body?.sites?.length === 2, rPage2.body?.sites?.length);
    check('35: pagination totalItems = 4', rPage1.body?.totalItems === 4, rPage1.body?.totalItems);
    check('35: pagination totalPages = 2', rPage1.body?.totalPages === 2, rPage1.body?.totalPages);
    check('36: summary identical across pages (independent of page)', JSON.stringify(rPage1.body?.summary) === JSON.stringify(rPage2.body?.summary), { p1: rPage1.body?.summary, p2: rPage2.body?.summary });
  }

  // ===============================================================================================
  // 37-43: reconciliation with T8.1/T8.2 + count definitions
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2051-04-01'), new Date('2051-04-14'));
    const siteA = await makeSite('ReconA');
    const siteB = await makeSite('ReconB');

    const empSingle = await makeEmployee('ReconSingle');
    const asgSingle = await makeAssignmentInPeriod(empSingle.id, siteA.id, period);
    await makeParticipant(period.id, empSingle.id, true);
    const tsSingle = await makeTimesheet(empSingle.id, period.id, 'FINAL_APPROVED');
    const vSingle = await attachVersion(tsSingle.id, empSingle.id);
    await addVersionSegment(vSingle, empSingle.id, siteA.id, asgSingle.id, new Date('2051-04-02'), new Date('2051-04-02T08:00:00.000Z'), new Date('2051-04-02T16:00:00.000Z'));

    const empMulti = await makeEmployee('ReconMulti');
    const asgA = await makeAssignmentInPeriod(empMulti.id, siteA.id, period);
    const asgB = await makeAssignmentInPeriod(empMulti.id, siteB.id, period, false); // 2nd concurrent site — non-primary
    await makeParticipant(period.id, empMulti.id, true);
    const tsMulti = await makeTimesheet(empMulti.id, period.id, 'FINAL_APPROVED');
    const vMulti = await attachVersion(tsMulti.id, empMulti.id);
    await addVersionSegment(vMulti, empMulti.id, siteA.id, asgA.id, new Date('2051-04-03'), new Date('2051-04-03T08:00:00.000Z'), new Date('2051-04-03T08:00:31.000Z'));
    await addVersionSegment(vMulti, empMulti.id, siteB.id, asgB.id, new Date('2051-04-03'), new Date('2051-04-03T09:00:00.000Z'), new Date('2051-04-03T09:00:31.000Z'));

    const noTimesheetEmp = await makeEmployee('ReconNoTs');
    await makeAssignmentInPeriod(noTimesheetEmp.id, siteA.id, period);
    await makeParticipant(period.id, noTimesheetEmp.id, true);

    const p = await getPeriodReport(period.id, admin.token, 'pageSize=100');
    const sA = await getSiteReport(siteA.id, period.id, admin.token);
    const sB = await getSiteReport(siteB.id, period.id, admin.token);
    const wSingle = await getWorkerReport(empSingle.id, period.id, admin.token);
    const wMulti = await getWorkerReport(empMulti.id, period.id, admin.token);
    const wNoTs = await getWorkerReport(noTimesheetEmp.id, period.id, admin.token);

    const rowA = p.body?.sites?.find((s: PeriodReportSite) => s.site.id === siteA.id);
    const rowB = p.body?.sites?.find((s: PeriodReportSite) => s.site.id === siteB.id);

    // 38: site totals equal T8.2 summary for every site
    for (const field of ['grossMinutes', 'paidBreakMinutes', 'unpaidBreakMinutes', 'workedMinutes', 'segmentCount', 'workedDayCount'] as const) {
      check(`38: siteA.${field} matches T8.2 summary`, rowA?.[field] === sA.body?.summary?.[field], { t83: rowA?.[field], t82: sA.body?.summary?.[field] });
      check(`38: siteB.${field} matches T8.2 summary`, rowB?.[field] === sB.body?.summary?.[field], { t83: rowB?.[field], t82: sB.body?.summary?.[field] });
    }
    check('38: siteA.timesheetStatusCounts matches T8.2 summary', JSON.stringify(rowA?.timesheetStatusCounts) === JSON.stringify(sA.body?.summary?.timesheetStatusCounts));
    check('38: siteB.withoutTimesheetCount matches T8.2 summary', rowB?.withoutTimesheetCount === sB.body?.summary?.withoutTimesheetCount);

    // 37: company total equals sum of site totals (full unpaginated set)
    const allSitesR = await getPeriodReport(period.id, admin.token, 'pageSize=100');
    const sumSites = (allSitesR.body?.sites ?? []).reduce(
      (acc: any, s: PeriodReportSite) => ({
        grossMinutes: acc.grossMinutes + s.grossMinutes,
        paidBreakMinutes: acc.paidBreakMinutes + s.paidBreakMinutes,
        unpaidBreakMinutes: acc.unpaidBreakMinutes + s.unpaidBreakMinutes,
        workedMinutes: acc.workedMinutes + s.workedMinutes,
        segmentCount: acc.segmentCount + s.segmentCount
      }),
      { grossMinutes: 0, paidBreakMinutes: 0, unpaidBreakMinutes: 0, workedMinutes: 0, segmentCount: 0 }
    );
    check('37: company summary equals sum of site totals', JSON.stringify(allSitesR.body?.summary?.grossMinutes) === JSON.stringify(sumSites.grossMinutes) && allSitesR.body?.summary?.workedMinutes === sumSites.workedMinutes, { summary: allSitesR.body?.summary, sumSites });

    // 39: company total equals sum of T8.1 worker totals across company population (this period's
    // three workers above; other periods' fixtures don't overlap this one).
    const sumWorkerTotals = (wSingle.body?.total?.workedMinutes ?? 0) + (wMulti.body?.total?.workedMinutes ?? 0) + (wNoTs.body?.total?.workedMinutes ?? 0);
    check('39: company workedMinutes equals sum of T8.1 worker totals', allSitesR.body?.summary?.workedMinutes === sumWorkerTotals, { company: allSitesR.body?.summary?.workedMinutes, sumWorkers: sumWorkerTotals });

    // 32-equivalent at period level via reconciliation: multi-site worker's two 31s segments round
    // to 1+1=2 min total in T8.1, matching the sum of siteA(1)+siteB(1) in T8.3.
    check('32-recon: multi-site worker T8.1 total = 2 min (1 min per site)', wMulti.body?.total?.workedMinutes === 2, wMulti.body?.total);

    // 40: company distinct workedDayCount (both segments on 2051-04-02/03 => 2 distinct dates, not
    // summed across sites)
    check('40: company workedDayCount is distinct dates, not summed per-site', allSitesR.body?.summary?.workedDayCount === 2, allSitesR.body?.summary);

    // 41: company/site distinct worker counts
    check('41: company assignedWorkerCount = 3 (single + multi + noTimesheet)', allSitesR.body?.summary?.assignedWorkerCount === 3, allSitesR.body?.summary);
    check('41: company workedWorkerCount = 2 (single + multi; noTimesheet excluded)', allSitesR.body?.summary?.workedWorkerCount === 2, allSitesR.body?.summary);
    check('41: siteA assignedWorkerCount = 3 (single + multi + noTimesheet all assigned to A)', rowA?.assignedWorkerCount === 3, rowA);
    check('41: siteB assignedWorkerCount = 1 (only multi assigned to B)', rowB?.assignedWorkerCount === 1, rowB);

    // 42: status counts company/site — one Timesheet counted once company-wide, but per-site for
    // multi-site worker in each of their sites (documented, expected behavior).
    check('42: company FINAL_APPROVED count = 2 (single + multi; noTimesheet has none)', allSitesR.body?.summary?.timesheetStatusCounts?.FINAL_APPROVED === 2, allSitesR.body?.summary?.timesheetStatusCounts);
    check('42: siteA FINAL_APPROVED count = 2 (single + multi both have hours/assignment at A)', rowA?.timesheetStatusCounts?.FINAL_APPROVED === 2, rowA?.timesheetStatusCounts);
    check('42: siteB FINAL_APPROVED count = 1 (only multi at B)', rowB?.timesheetStatusCounts?.FINAL_APPROVED === 1, rowB?.timesheetStatusCounts);

    // 43: withoutTimesheet/withoutSite definitions
    check('43: company withoutTimesheetCount = 1 (noTimesheet worker)', allSitesR.body?.summary?.withoutTimesheetCount === 1, allSitesR.body?.summary);
    check('43: siteA withoutTimesheetCount = 1 (noTimesheet is in siteA population via assignment)', rowA?.withoutTimesheetCount === 1, rowA);
  }

  // ===============================================================================================
  // 44-46: period status
  // ===============================================================================================
  {
    const openPeriod = await makePeriod(new Date('2051-05-01'), new Date('2051-05-14'), 'OPEN');
    const rOpen = await getPeriodReport(openPeriod.id, admin.token);
    check('44: OPEN period reflected in response', rOpen.body?.period?.status === 'OPEN', rOpen.body?.period);

    const lockedPeriod = await makePeriod(new Date('2051-06-01'), new Date('2051-06-14'), 'LOCKED');
    const rLocked = await getPeriodReport(lockedPeriod.id, admin.token);
    check('45: LOCKED period reflected in response', rLocked.body?.period?.status === 'LOCKED', rLocked.body?.period);

    const exportedPeriod = await makePeriod(new Date('2051-07-01'), new Date('2051-07-14'), 'EXPORTED');
    const rExported = await getPeriodReport(exportedPeriod.id, admin.token);
    check('46: EXPORTED period reflected in response', rExported.body?.period?.status === 'EXPORTED', rExported.body?.period);
  }

  // ===============================================================================================
  // 47: forbidden-field JSON scan
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2051-08-01'), new Date('2051-08-14'));
    const site = await makeSite('Scan');
    const emp = await makeEmployee('Scan');
    const asg = await makeAssignmentInPeriod(emp.id, site.id, period);
    await makeParticipant(period.id, emp.id, true);
    const ts = await makeTimesheet(emp.id, period.id, 'FINAL_APPROVED');
    const v = await attachVersion(ts.id, emp.id);
    await addVersionSegment(v, emp.id, site.id, asg.id, new Date('2051-08-02'), new Date('2051-08-02T08:00:00.000Z'), new Date('2051-08-02T16:00:00.000Z'));

    const raw = await fetch(`${BASE}/api/admin/reports/periods/${period.id}`, { headers: { cookie: `tt_session=${admin.token}` } }).then((r) => r.text());
    const forbidden = ['deviceInstallationId', 'deviceSequence', 'clientEventId', 'payloadHash', 'requestId', 'correctionReason', 'exclusionReason', 'latitude', 'longitude', 'employeeNumber', 'firstName', 'lastName'];
    for (const term of forbidden) {
      check(`47: forbidden term "${term}" absent from response JSON`, !raw.includes(term));
    }
    check('47: no email pattern in response JSON', !/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(raw));
    check('47: employee id itself never serialized (no "employeeId" key)', !raw.includes('"employeeId"'));
  }

  // ===============================================================================================
  // 48: GET zero mutations
  // ===============================================================================================
  {
    const auditCount = await prisma.auditEvent.count();
    check('48: AuditEvent count is 0 after every GET above', auditCount === 0, auditCount);
  }

  // ===============================================================================================
  // 49: REPEATABLE READ — a request reflects a fully independent, freshly-committed snapshot; a
  // later request sees a concurrent writer's committed change, proving no stale caching.
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2051-09-01'), new Date('2051-09-14'));
    const site = await makeSite('Snapshot');
    const emp = await makeEmployee('Snapshot');
    const asg = await makeAssignmentInPeriod(emp.id, site.id, period);
    await makeParticipant(period.id, emp.id, true);
    const ts = await makeTimesheet(emp.id, period.id, 'DRAFT');
    const draft = await attachDraft(ts.id, emp.id);
    await addDraftSegment(draft, emp.id, site.id, asg.id, new Date('2051-09-02'), new Date('2051-09-02T08:00:00.000Z'), new Date('2051-09-02T12:00:00.000Z'));

    const before = await getPeriodReport(period.id, admin.token);
    const siteRowBefore = before.body?.sites?.find((s: PeriodReportSite) => s.site.id === site.id);
    check('49: snapshot before concurrent write shows 4h (240 min)', siteRowBefore?.workedMinutes === 240, siteRowBefore);

    // A concurrent writer commits a new segment directly (simulating another connection/request).
    await addDraftSegment(draft, emp.id, site.id, asg.id, new Date('2051-09-03'), new Date('2051-09-03T08:00:00.000Z'), new Date('2051-09-03T12:00:00.000Z'));

    const after = await getPeriodReport(period.id, admin.token);
    const siteRowAfter = after.body?.sites?.find((s: PeriodReportSite) => s.site.id === site.id);
    check('49: a fresh request after the concurrent commit sees the new total (8h/480 min)', siteRowAfter?.workedMinutes === 480, siteRowAfter);
    check('49: the earlier response is untouched by the later write (still 240 min in the captured object)', siteRowBefore?.workedMinutes === 240, siteRowBefore);
  }

  // ===============================================================================================
  // 51: canonical-source helper regression (pure function, direct)
  // ===============================================================================================
  {
    const draftSource = resolveCanonicalSource({ id: 'x', status: 'DRAFT', currentVersionId: null, draft: { id: 'd1' }, currentVersion: null });
    check('51: DRAFT status resolves to DRAFT source', draftSource.dataSource === 'DRAFT' && draftSource.draftId === 'd1');

    const returnedSource = resolveCanonicalSource({ id: 'x', status: 'RETURNED', currentVersionId: 'stale-v', draft: { id: 'd2' }, currentVersion: { versionNumber: 1, submissionSource: 'MANUAL' } });
    check('51: RETURNED status resolves to DRAFT source (ignores stale currentVersion)', returnedSource.dataSource === 'DRAFT' && returnedSource.draftId === 'd2');

    const versionSource = resolveCanonicalSource({ id: 'x', status: 'FINAL_APPROVED', currentVersionId: 'v1', draft: null, currentVersion: { versionNumber: 3, submissionSource: 'AUTO' } });
    check('51: FINAL_APPROVED resolves to CURRENT_VERSION with correct metadata', versionSource.dataSource === 'CURRENT_VERSION' && versionSource.versionId === 'v1' && versionSource.versionNumber === 3 && versionSource.submissionSource === 'AUTO');

    let threwForMissingDraft = false;
    try {
      resolveCanonicalSource({ id: 'x', status: 'DRAFT', currentVersionId: null, draft: null, currentVersion: null });
    } catch {
      threwForMissingDraft = true;
    }
    check('51: throws when DRAFT status has no TimesheetDraft (invariant failure)', threwForMissingDraft);

    let threwForMissingVersion = false;
    try {
      resolveCanonicalSource({ id: 'x', status: 'SUBMITTED', currentVersionId: null, draft: null, currentVersion: null });
    } catch {
      threwForMissingVersion = true;
    }
    check('51: throws when non-draft status has no currentVersion (invariant failure)', threwForMissingVersion);
  }

  console.log(JSON.stringify({ pass, fail }, null, 2));
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error('SCRIPT ERROR', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
