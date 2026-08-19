import { randomUUID, randomBytes, createHash } from 'node:crypto';
import type { TimesheetStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';

// docs/titanor-time/T8_REPORTS_DESIGN.md §2-3 + "T8 ROUNDING FOLLOW-UP" (2026-08-19) — permanent
// regression proving T8.1 (lib/worker-time-report.ts) and T8.2 (lib/site-time-report.ts) reconcile
// on the shared canonical bucket (employeeId, siteId, date), including on sub-minute segments where
// bucket-then-round vs round-then-sum used to disagree. Exercises both real HTTP endpoints —
// GET /api/admin/reports/workers/:employeeId and GET /api/admin/reports/sites/:siteId — never the
// pure lib functions directly, so a regression in either route wrapper is caught too.

const BASE = process.env.TEST_BASE_URL || 'http://localhost:39491';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra, (k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 600) : '');
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function makeAdmin() {
  const user = await prisma.user.create({ data: { username: `round-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'ADMIN' } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const token = randomBytes(32).toString('base64url');
  await prisma.userSession.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) } });
  return { user, token };
}

let admin: { user: { id: string }; token: string };

async function makeEmployee(tag: string) {
  const emp = await prisma.employee.create({ data: { employeeNumber: `TEST-RND-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  return emp;
}

async function makeSite(tag: string) {
  return prisma.workSite.create({ data: { name: `Round Site ${tag} ${randomUUID().slice(0, 4)}` } });
}

async function makeAssignment(employeeId: string, siteId: string) {
  return prisma.siteAssignment.create({ data: { employeeId, siteId, isPrimary: true, validFrom: new Date('2000-01-01T00:00:00.000Z'), validTo: null, assignedByUserId: admin.user.id } });
}

async function makePeriod(startDate: Date, endDate: Date) {
  return prisma.payrollPeriod.create({ data: { startDate, endDate, status: 'OPEN', openedByUserId: admin.user.id } });
}

async function makeParticipant(periodId: string, employeeId: string) {
  return prisma.payrollPeriodParticipant.create({ data: { periodId, employeeId, expected: true } });
}

async function makeTimesheet(employeeId: string, periodId: string, status: TimesheetStatus) {
  return prisma.timesheet.create({ data: { employeeId, periodId, status } });
}

async function attachVersion(timesheetId: string, employeeId: string, setCurrent = true) {
  const existing = await prisma.timesheetVersion.count({ where: { timesheetId } });
  const version = await prisma.timesheetVersion.create({ data: { timesheetId, employeeId, versionNumber: existing + 1, source: 'WORKER', createdByUserId: admin.user.id, submissionSource: 'MANUAL' } });
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

const dayCache = new Map<string, { id: string }>();
async function ensureVersionDay(versionId: string, date: Date) {
  const key = `${versionId}:${date.toISOString().slice(0, 10)}`;
  const cached = dayCache.get(key);
  if (cached) return cached;
  const day = await prisma.timesheetDay.create({ data: { timesheetVersionId: versionId, date, dayType: 'WORK', confirmedZero: false } });
  dayCache.set(key, day);
  return day;
}

const planCache = new Map<string, { id: string }>();
async function ensureVersionPlannedShift(versionId: string, employeeId: string, date: Date, siteId: string, sourceAssignmentId: string) {
  const key = `${versionId}:${date.toISOString().slice(0, 10)}:${sourceAssignmentId}`;
  const cached = planCache.get(key);
  if (cached) return cached;
  const ps = await prisma.timesheetPlannedShift.create({ data: { timesheetVersionId: versionId, employeeId, date, siteId, sourceAssignmentId, plannedBreakMinutes: 0 } });
  planCache.set(key, ps);
  return ps;
}

async function addVersionSegment(version: { id: string }, employeeId: string, siteId: string, sourceAssignmentId: string, date: Date, startAt: Date, endAt: Date, breaks: BreakInput[] = [], crossesMidnight = false) {
  const day = await ensureVersionDay(version.id, date);
  await ensureVersionPlannedShift(version.id, employeeId, date, siteId, sourceAssignmentId);
  const seg = await prisma.workSegment.create({
    data: { timesheetDayId: day.id, timesheetVersionId: version.id, employeeId, date, startAt, endAt, siteId, sourceAssignmentId, crossesMidnight }
  });
  for (const b of breaks) {
    await prisma.breakSegment.create({ data: { workSegmentId: seg.id, startAt: b.startAt, endAt: b.endAt, paid: b.paid } });
  }
  return seg;
}

async function attachDraftWithDay(timesheetId: string, employeeId: string, date: Date) {
  const draft = await prisma.timesheetDraft.create({ data: { timesheetId, employeeId } });
  const day = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date, dayType: 'WORK' } });
  return { draft, day };
}

async function addDraftSegment(draft: { id: string }, day: { id: string }, employeeId: string, siteId: string, sourceAssignmentId: string, date: Date, startAt: Date, endAt: Date, breaks: BreakInput[] = []) {
  await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft.id, employeeId, date, siteId, sourceAssignmentId, plannedBreakMinutes: 0 } });
  const seg = await prisma.timesheetDraftSegment.create({ data: { draftDayId: day.id, draftId: draft.id, employeeId, date, startAt, endAt, siteId, sourceAssignmentId } });
  for (const b of breaks) {
    await prisma.timesheetDraftBreakSegment.create({ data: { draftSegmentId: seg.id, startAt: b.startAt, endAt: b.endAt, paid: b.paid } });
  }
  return seg;
}

interface WorkerReportSite {
  siteId: string;
  siteName: string;
  grossMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  workedMinutes: number;
  segmentCount: number;
  workedDayCount: number;
}
interface ReportTimesheetDto {
  dataSource: 'DRAFT' | 'CURRENT_VERSION';
  versionNumber: number | null;
}
interface WorkerReportBody {
  timesheet: ReportTimesheetDto | null;
  sites: WorkerReportSite[];
  total: WorkerReportSite & { siteCount: number };
}
interface SiteReportItemTotal {
  workedDayCount: number;
  grossMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  workedMinutes: number;
  segmentCount: number;
}
interface SiteReportBody {
  summary: { workedMinutes: number; grossMinutes: number; paidBreakMinutes: number; unpaidBreakMinutes: number };
  items: { employee: { id: string }; timesheet: ReportTimesheetDto | null; total: SiteReportItemTotal }[];
}

async function getWorkerReport(employeeId: string, periodId: string): Promise<{ status: number; body: WorkerReportBody }> {
  const res = await fetch(`${BASE}/api/admin/reports/workers/${employeeId}?periodId=${periodId}`, { headers: { cookie: `tt_session=${admin.token}` } });
  return { status: res.status, body: (await res.json()) as WorkerReportBody };
}

async function getSiteReport(siteId: string, periodId: string): Promise<{ status: number; body: SiteReportBody }> {
  const res = await fetch(`${BASE}/api/admin/reports/sites/${siteId}?periodId=${periodId}&pageSize=100`, { headers: { cookie: `tt_session=${admin.token}` } });
  return { status: res.status, body: (await res.json()) as SiteReportBody };
}

// Task's own core assertion (п.13): T8.1's per-site row and T8.2's matching worker row must agree
// on all four minute fields, field by field — not just on one aggregate number.
function reconcile(name: string, t81Site: WorkerReportSite, t82Total: SiteReportItemTotal) {
  check(`${name}: gross reconciles T8.1<->T8.2`, t81Site.grossMinutes === t82Total.grossMinutes, { t81: t81Site.grossMinutes, t82: t82Total.grossMinutes });
  check(`${name}: paidBreak reconciles T8.1<->T8.2`, t81Site.paidBreakMinutes === t82Total.paidBreakMinutes, { t81: t81Site.paidBreakMinutes, t82: t82Total.paidBreakMinutes });
  check(`${name}: unpaidBreak reconciles T8.1<->T8.2`, t81Site.unpaidBreakMinutes === t82Total.unpaidBreakMinutes, { t81: t81Site.unpaidBreakMinutes, t82: t82Total.unpaidBreakMinutes });
  check(`${name}: worked reconciles T8.1<->T8.2`, t81Site.workedMinutes === t82Total.workedMinutes, { t81: t81Site.workedMinutes, t82: t82Total.workedMinutes });
}

async function main() {
  admin = await makeAdmin();

  // ===============================================================================================
  // 1: two days of 31 seconds each, same worker/site — the exact incident scenario. Pre-fix, T8.1
  // rounded round(31000ms*2 / 60000) = round(62000/60000) = round(1.0333) = 1 min (one big
  // per-site sum), while T8.2 already rounded round(31000/60000)=1 per day, summing to 2. Post-fix
  // T8.1 buckets by (siteId, date) first too: round(31000/60000)=1 per day, 1+1=2 — matches T8.2.
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2031-01-01'), new Date('2031-01-14'));
    const site = await makeSite('C1');
    const emp = await makeEmployee('C1');
    const asg = await makeAssignment(emp.id, site.id);
    await makeParticipant(period.id, emp.id);
    const ts = await makeTimesheet(emp.id, period.id, 'FINAL_APPROVED');
    const v = await attachVersion(ts.id, emp.id);
    await addVersionSegment(v, emp.id, site.id, asg.id, new Date('2031-01-02'), new Date('2031-01-02T08:00:00.000Z'), new Date('2031-01-02T08:00:31.000Z'));
    await addVersionSegment(v, emp.id, site.id, asg.id, new Date('2031-01-03'), new Date('2031-01-03T08:00:00.000Z'), new Date('2031-01-03T08:00:31.000Z'));

    const w = await getWorkerReport(emp.id, period.id);
    const s = await getSiteReport(site.id, period.id);
    const t81Site = w.body.sites.find((x) => x.siteId === site.id)!;
    const t82Item = s.body.items.find((x) => x.employee.id === emp.id)!;
    check('1: T8.1 site total = 2 min (two 31s days)', t81Site.workedMinutes === 2, t81Site);
    check('1: T8.2 worker total = 2 min (two 31s days)', t82Item.total.workedMinutes === 2, t82Item.total);
    reconcile('1', t81Site, t82Item.total);
  }

  // ===============================================================================================
  // 2: two days of 29 seconds each — both round to 0 per day, both reports total 0.
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2032-01-01'), new Date('2032-01-14'));
    const site = await makeSite('C2');
    const emp = await makeEmployee('C2');
    const asg = await makeAssignment(emp.id, site.id);
    await makeParticipant(period.id, emp.id);
    const ts = await makeTimesheet(emp.id, period.id, 'FINAL_APPROVED');
    const v = await attachVersion(ts.id, emp.id);
    await addVersionSegment(v, emp.id, site.id, asg.id, new Date('2032-01-02'), new Date('2032-01-02T08:00:00.000Z'), new Date('2032-01-02T08:00:29.000Z'));
    await addVersionSegment(v, emp.id, site.id, asg.id, new Date('2032-01-03'), new Date('2032-01-03T08:00:00.000Z'), new Date('2032-01-03T08:00:29.000Z'));

    const w = await getWorkerReport(emp.id, period.id);
    const s = await getSiteReport(site.id, period.id);
    const t81Site = w.body.sites.find((x) => x.siteId === site.id)!;
    const t82Item = s.body.items.find((x) => x.employee.id === emp.id)!;
    check('2: T8.1 site total = 0 min (two 29s days)', t81Site.workedMinutes === 0, t81Site);
    check('2: T8.2 worker total = 0 min (two 29s days)', t82Item.total.workedMinutes === 0, t82Item.total);
    reconcile('2', t81Site, t82Item.total);
  }

  // ===============================================================================================
  // 3 + 14: two sites in one day — T8.1's own site rows reconcile with each site's own T8.2 report,
  // and T8.1's total is exactly the sum of its two site rows.
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2033-01-01'), new Date('2033-01-14'));
    const siteA = await makeSite('C3A');
    const siteB = await makeSite('C3B');
    const emp = await makeEmployee('C3');
    const asgA = await makeAssignment(emp.id, siteA.id);
    const asgB = await makeAssignment(emp.id, siteB.id);
    await makeParticipant(period.id, emp.id);
    const ts = await makeTimesheet(emp.id, period.id, 'FINAL_APPROVED');
    const v = await attachVersion(ts.id, emp.id);
    await addVersionSegment(v, emp.id, siteA.id, asgA.id, new Date('2033-01-02'), new Date('2033-01-02T06:00:00.000Z'), new Date('2033-01-02T06:00:45.000Z'));
    await addVersionSegment(v, emp.id, siteB.id, asgB.id, new Date('2033-01-02'), new Date('2033-01-02T14:00:00.000Z'), new Date('2033-01-02T14:00:45.000Z'));

    const w = await getWorkerReport(emp.id, period.id);
    const sA = await getSiteReport(siteA.id, period.id);
    const sB = await getSiteReport(siteB.id, period.id);
    const t81SiteA = w.body.sites.find((x) => x.siteId === siteA.id)!;
    const t81SiteB = w.body.sites.find((x) => x.siteId === siteB.id)!;
    const t82ItemA = sA.body.items.find((x) => x.employee.id === emp.id)!;
    const t82ItemB = sB.body.items.find((x) => x.employee.id === emp.id)!;
    reconcile('3A', t81SiteA, t82ItemA.total);
    reconcile('3B', t81SiteB, t82ItemB.total);

    check(
      '14: T8.1 total.grossMinutes = sum(sites[].grossMinutes)',
      w.body.total.grossMinutes === w.body.sites.reduce((a, s) => a + s.grossMinutes, 0),
      w.body.total
    );
    check(
      '14: T8.1 total.workedMinutes = sum(sites[].workedMinutes)',
      w.body.total.workedMinutes === w.body.sites.reduce((a, s) => a + s.workedMinutes, 0),
      w.body.total
    );
    check(
      '14: T8.1 total.paidBreakMinutes = sum(sites[].paidBreakMinutes)',
      w.body.total.paidBreakMinutes === w.body.sites.reduce((a, s) => a + s.paidBreakMinutes, 0)
    );
    check(
      '14: T8.1 total.unpaidBreakMinutes = sum(sites[].unpaidBreakMinutes)',
      w.body.total.unpaidBreakMinutes === w.body.sites.reduce((a, s) => a + s.unpaidBreakMinutes, 0)
    );
  }

  // ===============================================================================================
  // 4: multiple segments, same site/date — summed in ms inside the bucket before a single round.
  // Three 20-second segments same day/site = 60000ms gross = exactly 1 min, not 3x round(20s/60s)=0.
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2034-01-01'), new Date('2034-01-14'));
    const site = await makeSite('C4');
    const emp = await makeEmployee('C4');
    const asg = await makeAssignment(emp.id, site.id);
    await makeParticipant(period.id, emp.id);
    const ts = await makeTimesheet(emp.id, period.id, 'FINAL_APPROVED');
    const v = await attachVersion(ts.id, emp.id);
    const d = new Date('2034-01-02');
    await addVersionSegment(v, emp.id, site.id, asg.id, d, new Date('2034-01-02T06:00:00.000Z'), new Date('2034-01-02T06:00:20.000Z'));
    await addVersionSegment(v, emp.id, site.id, asg.id, d, new Date('2034-01-02T07:00:00.000Z'), new Date('2034-01-02T07:00:20.000Z'));
    await addVersionSegment(v, emp.id, site.id, asg.id, d, new Date('2034-01-02T08:00:00.000Z'), new Date('2034-01-02T08:00:20.000Z'));

    const w = await getWorkerReport(emp.id, period.id);
    const s = await getSiteReport(site.id, period.id);
    const t81Site = w.body.sites.find((x) => x.siteId === site.id)!;
    const t82Item = s.body.items.find((x) => x.employee.id === emp.id)!;
    check('4: three 20s segments same day/site sum to 1 min (60s), not 0', t81Site.workedMinutes === 1, t81Site);
    check('4: segmentCount = 3', t81Site.segmentCount === 3, t81Site.segmentCount);
    reconcile('4', t81Site, t82Item.total);
  }

  // ===============================================================================================
  // 5: paid break — stays inside workedMinutes, shown separately.
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2035-01-01'), new Date('2035-01-14'));
    const site = await makeSite('C5');
    const emp = await makeEmployee('C5');
    const asg = await makeAssignment(emp.id, site.id);
    await makeParticipant(period.id, emp.id);
    const ts = await makeTimesheet(emp.id, period.id, 'FINAL_APPROVED');
    const v = await attachVersion(ts.id, emp.id);
    await addVersionSegment(v, emp.id, site.id, asg.id, new Date('2035-01-02'), new Date('2035-01-02T08:00:00.000Z'), new Date('2035-01-02T16:00:00.000Z'), [
      { startAt: new Date('2035-01-02T12:00:00.000Z'), endAt: new Date('2035-01-02T12:30:00.000Z'), paid: true }
    ]);

    const w = await getWorkerReport(emp.id, period.id);
    const s = await getSiteReport(site.id, period.id);
    const t81Site = w.body.sites.find((x) => x.siteId === site.id)!;
    const t82Item = s.body.items.find((x) => x.employee.id === emp.id)!;
    check('5: paidBreakMinutes = 30', t81Site.paidBreakMinutes === 30, t81Site);
    check('5: worked = gross (paid break stays inside worked)', t81Site.workedMinutes === t81Site.grossMinutes, t81Site);
    reconcile('5', t81Site, t82Item.total);
  }

  // ===============================================================================================
  // 6: unpaid break — subtracted from worked exactly once.
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2036-01-01'), new Date('2036-01-14'));
    const site = await makeSite('C6');
    const emp = await makeEmployee('C6');
    const asg = await makeAssignment(emp.id, site.id);
    await makeParticipant(period.id, emp.id);
    const ts = await makeTimesheet(emp.id, period.id, 'FINAL_APPROVED');
    const v = await attachVersion(ts.id, emp.id);
    await addVersionSegment(v, emp.id, site.id, asg.id, new Date('2036-01-02'), new Date('2036-01-02T08:00:00.000Z'), new Date('2036-01-02T16:00:00.000Z'), [
      { startAt: new Date('2036-01-02T12:00:00.000Z'), endAt: new Date('2036-01-02T12:30:00.000Z'), paid: false }
    ]);

    const w = await getWorkerReport(emp.id, period.id);
    const s = await getSiteReport(site.id, period.id);
    const t81Site = w.body.sites.find((x) => x.siteId === site.id)!;
    const t82Item = s.body.items.find((x) => x.employee.id === emp.id)!;
    check('6: unpaidBreakMinutes = 30', t81Site.unpaidBreakMinutes === 30, t81Site);
    check('6: worked = gross - unpaid', t81Site.workedMinutes === t81Site.grossMinutes - 30, t81Site);
    reconcile('6', t81Site, t82Item.total);
  }

  // ===============================================================================================
  // 7: multiple unpaid breaks — each subtracted independently, summed.
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2037-01-01'), new Date('2037-01-14'));
    const site = await makeSite('C7');
    const emp = await makeEmployee('C7');
    const asg = await makeAssignment(emp.id, site.id);
    await makeParticipant(period.id, emp.id);
    const ts = await makeTimesheet(emp.id, period.id, 'FINAL_APPROVED');
    const v = await attachVersion(ts.id, emp.id);
    await addVersionSegment(v, emp.id, site.id, asg.id, new Date('2037-01-02'), new Date('2037-01-02T08:00:00.000Z'), new Date('2037-01-02T16:00:00.000Z'), [
      { startAt: new Date('2037-01-02T10:00:00.000Z'), endAt: new Date('2037-01-02T10:15:00.000Z'), paid: false },
      { startAt: new Date('2037-01-02T13:00:00.000Z'), endAt: new Date('2037-01-02T13:20:00.000Z'), paid: false }
    ]);

    const w = await getWorkerReport(emp.id, period.id);
    const s = await getSiteReport(site.id, period.id);
    const t81Site = w.body.sites.find((x) => x.siteId === site.id)!;
    const t82Item = s.body.items.find((x) => x.employee.id === emp.id)!;
    check('7: two unpaid breaks sum to 35', t81Site.unpaidBreakMinutes === 35, t81Site);
    check('7: worked = gross - 35', t81Site.workedMinutes === t81Site.grossMinutes - 35, t81Site);
    reconcile('7', t81Site, t82Item.total);
  }

  // ===============================================================================================
  // 8: cross-midnight fragments, already split by date (as the schema requires — a segment's own
  // date must equal the Helsinki-local date of its startAt). Same sub-minute reconciliation as
  // case 1, but explicitly modeling two fragments of what was operationally one overnight shift.
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2038-01-01'), new Date('2038-01-14'));
    const site = await makeSite('C8');
    const emp = await makeEmployee('C8');
    const asg = await makeAssignment(emp.id, site.id);
    await makeParticipant(period.id, emp.id);
    const ts = await makeTimesheet(emp.id, period.id, 'FINAL_APPROVED');
    const v = await attachVersion(ts.id, emp.id);
    // fragment 1: late evening of day 1 (Helsinki-local still day 1)
    await addVersionSegment(v, emp.id, site.id, asg.id, new Date('2038-01-02'), new Date('2038-01-02T19:59:29.000Z'), new Date('2038-01-02T20:00:00.000Z'), [], true);
    // fragment 2: first thing on day 2 (Helsinki-local day 2) — same overnight shift, other half
    await addVersionSegment(v, emp.id, site.id, asg.id, new Date('2038-01-03'), new Date('2038-01-03T00:00:00.000Z'), new Date('2038-01-03T00:00:31.000Z'), [], true);

    const w = await getWorkerReport(emp.id, period.id);
    const s = await getSiteReport(site.id, period.id);
    const t81Site = w.body.sites.find((x) => x.siteId === site.id)!;
    const t82Item = s.body.items.find((x) => x.employee.id === emp.id)!;
    check('8: two workedDayCount (fragments stay on their own dates)', t81Site.workedDayCount === 2, t81Site);
    check('8: cross-midnight fragments total 2 min (31s+31s rounds per day, 1+1)', t81Site.workedMinutes === 2, t81Site);
    reconcile('8', t81Site, t82Item.total);
  }

  // ===============================================================================================
  // 9: DRAFT source — both T8.1 and T8.2 must read TimesheetDraftSegment, not any stale version.
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2039-01-01'), new Date('2039-01-14'));
    const site = await makeSite('C9');
    const emp = await makeEmployee('C9');
    const asg = await makeAssignment(emp.id, site.id);
    await makeParticipant(period.id, emp.id);
    const ts = await makeTimesheet(emp.id, period.id, 'DRAFT');
    const { draft, day } = await attachDraftWithDay(ts.id, emp.id, new Date('2039-01-02'));
    await addDraftSegment(draft, day, emp.id, site.id, asg.id, new Date('2039-01-02'), new Date('2039-01-02T08:00:00.000Z'), new Date('2039-01-02T08:00:31.000Z'));

    const w = await getWorkerReport(emp.id, period.id);
    const s = await getSiteReport(site.id, period.id);
    check('9: T8.1 reads DRAFT dataSource', w.body.timesheet?.dataSource === 'DRAFT', w.body.timesheet);
    const t82Item = s.body.items.find((x) => x.employee.id === emp.id)!;
    check('9: T8.2 reads DRAFT dataSource', t82Item.timesheet?.dataSource === 'DRAFT', t82Item.timesheet);
    const t81Site = w.body.sites.find((x) => x.siteId === site.id)!;
    check('9: T8.1 DRAFT worked = 1 min', t81Site.workedMinutes === 1, t81Site);
    reconcile('9', t81Site, t82Item.total);
  }

  // ===============================================================================================
  // 10: RETURNED source — stale currentVersionId with WRONG numbers must be ignored; both reports
  // must read the draft's correct numbers instead.
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2040-01-01'), new Date('2040-01-14'));
    const site = await makeSite('C10');
    const emp = await makeEmployee('C10');
    const asg = await makeAssignment(emp.id, site.id);
    await makeParticipant(period.id, emp.id);
    const ts = await makeTimesheet(emp.id, period.id, 'RETURNED');
    // Stale version — a full 100-minute day. This must NEVER be read once status is RETURNED.
    const staleVersion = await attachVersion(ts.id, emp.id);
    await addVersionSegment(staleVersion, emp.id, site.id, asg.id, new Date('2040-01-02'), new Date('2040-01-02T08:00:00.000Z'), new Date('2040-01-02T09:40:00.000Z'));
    // The actual draft — two 31s days, 2 minutes.
    const { draft, day } = await attachDraftWithDay(ts.id, emp.id, new Date('2040-01-05'));
    await addDraftSegment(draft, day, emp.id, site.id, asg.id, new Date('2040-01-05'), new Date('2040-01-05T08:00:00.000Z'), new Date('2040-01-05T08:00:31.000Z'));
    const day2 = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: new Date('2040-01-06'), dayType: 'WORK' } });
    await addDraftSegment(draft, day2, emp.id, site.id, asg.id, new Date('2040-01-06'), new Date('2040-01-06T08:00:00.000Z'), new Date('2040-01-06T08:00:31.000Z'));

    const w = await getWorkerReport(emp.id, period.id);
    const s = await getSiteReport(site.id, period.id);
    check('10: T8.1 reads DRAFT dataSource despite stale currentVersionId', w.body.timesheet?.dataSource === 'DRAFT', w.body.timesheet);
    const t81Site = w.body.sites.find((x) => x.siteId === site.id)!;
    check('10: T8.1 RETURNED worked = 2 min (draft, not the stale 100-min version)', t81Site.workedMinutes === 2, t81Site);
    const t82Item = s.body.items.find((x) => x.employee.id === emp.id)!;
    check('10: T8.2 RETURNED worked = 2 min (draft, not the stale 100-min version)', t82Item.total.workedMinutes === 2, t82Item.total);
    reconcile('10', t81Site, t82Item.total);
  }

  // ===============================================================================================
  // 11: CURRENT_VERSION source, explicit FOREMAN_APPROVED status (diversifies status coverage
  // beyond FINAL_APPROVED used elsewhere in this file).
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2041-01-01'), new Date('2041-01-14'));
    const site = await makeSite('C11');
    const emp = await makeEmployee('C11');
    const asg = await makeAssignment(emp.id, site.id);
    await makeParticipant(period.id, emp.id);
    const ts = await makeTimesheet(emp.id, period.id, 'FOREMAN_APPROVED');
    const v = await attachVersion(ts.id, emp.id);
    await addVersionSegment(v, emp.id, site.id, asg.id, new Date('2041-01-02'), new Date('2041-01-02T08:00:00.000Z'), new Date('2041-01-02T08:00:31.000Z'));
    await addVersionSegment(v, emp.id, site.id, asg.id, new Date('2041-01-03'), new Date('2041-01-03T08:00:00.000Z'), new Date('2041-01-03T08:00:31.000Z'));

    const w = await getWorkerReport(emp.id, period.id);
    const s = await getSiteReport(site.id, period.id);
    check('11: T8.1 reads CURRENT_VERSION dataSource for FOREMAN_APPROVED', w.body.timesheet?.dataSource === 'CURRENT_VERSION', w.body.timesheet);
    const t81Site = w.body.sites.find((x) => x.siteId === site.id)!;
    const t82Item = s.body.items.find((x) => x.employee.id === emp.id)!;
    check('11: T8.1 FOREMAN_APPROVED worked = 2 min', t81Site.workedMinutes === 2, t81Site);
    reconcile('11', t81Site, t82Item.total);
  }

  // ===============================================================================================
  // 12: approved correction — version 2 became current (the exact data shape an approved
  // correction produces); both reports must read version 2, not the original version 1.
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2042-01-01'), new Date('2042-01-14'));
    const site = await makeSite('C12');
    const emp = await makeEmployee('C12');
    const asg = await makeAssignment(emp.id, site.id);
    await makeParticipant(period.id, emp.id);
    const ts = await makeTimesheet(emp.id, period.id, 'FINAL_APPROVED');
    // Version 1 — original, no break, 8h.
    const v1 = await attachVersion(ts.id, emp.id, true);
    await addVersionSegment(v1, emp.id, site.id, asg.id, new Date('2042-01-02'), new Date('2042-01-02T08:00:00.000Z'), new Date('2042-01-02T16:00:00.000Z'));
    // Version 2 — the approved correction: same day, now with a 30-minute unpaid break, becomes current.
    const v2 = await attachVersion(ts.id, emp.id, true);
    await addVersionSegment(v2, emp.id, site.id, asg.id, new Date('2042-01-02'), new Date('2042-01-02T08:00:00.000Z'), new Date('2042-01-02T16:00:00.000Z'), [
      { startAt: new Date('2042-01-02T12:00:00.000Z'), endAt: new Date('2042-01-02T12:30:00.000Z'), paid: false }
    ]);

    const w = await getWorkerReport(emp.id, period.id);
    const s = await getSiteReport(site.id, period.id);
    check('12: T8.1 reads versionNumber 2 (the approved correction)', w.body.timesheet?.versionNumber === 2, w.body.timesheet);
    const t81Site = w.body.sites.find((x) => x.siteId === site.id)!;
    const t82Item = s.body.items.find((x) => x.employee.id === emp.id)!;
    check('12: T8.1 reflects the correction (unpaidBreak=30, not version 1s 0)', t81Site.unpaidBreakMinutes === 30, t81Site);
    reconcile('12', t81Site, t82Item.total);
  }

  // ===============================================================================================
  // 15: T8.2 summary = sum over the full worker set at one site (3 workers, sub-minute + break
  // mixes), independent of the T8.1-side cases above.
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2043-01-01'), new Date('2043-01-14'));
    const site = await makeSite('C15');

    async function addWorker(tag: string, breaks: BreakInput[]) {
      const emp = await makeEmployee(`C15${tag}`);
      const asg = await makeAssignment(emp.id, site.id);
      await makeParticipant(period.id, emp.id);
      const ts = await makeTimesheet(emp.id, period.id, 'FINAL_APPROVED');
      const v = await attachVersion(ts.id, emp.id);
      await addVersionSegment(v, emp.id, site.id, asg.id, new Date('2043-01-02'), new Date('2043-01-02T08:00:00.000Z'), new Date('2043-01-02T16:00:00.000Z'), breaks);
      return emp;
    }

    await addWorker('A', []);
    await addWorker('B', [{ startAt: new Date('2043-01-02T12:00:00.000Z'), endAt: new Date('2043-01-02T12:30:00.000Z'), paid: true }]);
    await addWorker('C', [{ startAt: new Date('2043-01-02T12:00:00.000Z'), endAt: new Date('2043-01-02T12:30:00.000Z'), paid: false }]);

    const s = await getSiteReport(site.id, period.id);
    const summedWorked = s.body.items.reduce((a, it) => a + it.total.workedMinutes, 0);
    const summedGross = s.body.items.reduce((a, it) => a + it.total.grossMinutes, 0);
    const summedPaid = s.body.items.reduce((a, it) => a + it.total.paidBreakMinutes, 0);
    const summedUnpaid = s.body.items.reduce((a, it) => a + it.total.unpaidBreakMinutes, 0);
    check('15: T8.2 summary.workedMinutes = sum(items[].total.workedMinutes)', s.body.summary.workedMinutes === summedWorked, { summary: s.body.summary.workedMinutes, sum: summedWorked });
    check('15: T8.2 summary.grossMinutes = sum(items[].total.grossMinutes)', s.body.summary.grossMinutes === summedGross);
    check('15: T8.2 summary.paidBreakMinutes = sum(items[].total.paidBreakMinutes)', s.body.summary.paidBreakMinutes === summedPaid);
    check('15: T8.2 summary.unpaidBreakMinutes = sum(items[].total.unpaidBreakMinutes)', s.body.summary.unpaidBreakMinutes === summedUnpaid);
  }

  // ===============================================================================================
  // Zero mutations — GET requests above must not have created a single AuditEvent.
  // ===============================================================================================
  {
    const auditCount = await prisma.auditEvent.count();
    check('zero mutations: AuditEvent count is 0 after every GET above', auditCount === 0, auditCount);
  }

  // ===============================================================================================
  // Forbidden-field scan on both endpoints' raw JSON — the T8.1/T8.2 DTOs must stay redaction-safe
  // through this rounding refactor (it touched aggregation only, but this is cheap insurance).
  // ===============================================================================================
  {
    const period = await makePeriod(new Date('2044-01-01'), new Date('2044-01-14'));
    const site = await makeSite('C16');
    const emp = await makeEmployee('C16');
    const asg = await makeAssignment(emp.id, site.id);
    await makeParticipant(period.id, emp.id);
    const ts = await makeTimesheet(emp.id, period.id, 'FINAL_APPROVED');
    const v = await attachVersion(ts.id, emp.id);
    await addVersionSegment(v, emp.id, site.id, asg.id, new Date('2044-01-02'), new Date('2044-01-02T08:00:00.000Z'), new Date('2044-01-02T16:00:00.000Z'));

    const wRaw = await fetch(`${BASE}/api/admin/reports/workers/${emp.id}?periodId=${period.id}`, { headers: { cookie: `tt_session=${admin.token}` } }).then((r) => r.text());
    const sRaw = await fetch(`${BASE}/api/admin/reports/sites/${site.id}?periodId=${period.id}`, { headers: { cookie: `tt_session=${admin.token}` } }).then((r) => r.text());
    const forbidden = ['deviceInstallationId', 'deviceSequence', 'clientEventId', 'payloadHash', 'requestId', 'correctionReason', 'exclusionReason', 'latitude', 'longitude'];
    for (const term of forbidden) {
      check(`forbidden-field scan: "${term}" absent from T8.1 JSON`, !wRaw.includes(term));
      check(`forbidden-field scan: "${term}" absent from T8.2 JSON`, !sRaw.includes(term));
    }
    check('forbidden-field scan: no email pattern in T8.1 JSON', !/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(wRaw));
    check('forbidden-field scan: no email pattern in T8.2 JSON', !/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(sRaw));
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
