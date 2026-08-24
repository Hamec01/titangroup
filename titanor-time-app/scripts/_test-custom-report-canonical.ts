import { randomUUID } from 'node:crypto';
import type { TimesheetStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { getWorkerTimeReport } from '../lib/worker-time-report';
import { getCustomTimeReport, MAX_CUSTOM_REPORT_DAYS } from '../lib/reporting/custom-time-report';

// Task spec §37F — "Totals custom export должны совпасть с existing T8 report для одинакового
// scope." Fixture helpers mirror scripts/_test-report-rounding-consistency.ts exactly (same
// composite-FK shape for Timesheet/TimesheetVersion/WorkSegment/TimesheetDraft*), but this test
// calls the lib functions directly (getWorkerTimeReport, getCustomTimeReport) — no HTTP server
// needed since both are pure functions, and this test is only about aggregation agreement, not
// route wrapping (T8's own contract for that is scripts/_test-report-rounding-consistency.ts).

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

let adminId: string;

async function makeAdmin() {
  const user = await prisma.user.create({ data: { username: `custom-rpt-admin-${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN' } });
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'ADMIN' } });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return user.id;
}

async function makeEmployee(tag: string) {
  return prisma.employee.create({ data: { employeeNumber: `TEST-CR-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
}
async function makeSite(tag: string) {
  return prisma.workSite.create({ data: { name: `Custom Report Site ${tag} ${randomUUID().slice(0, 4)}` } });
}
async function makeAssignment(employeeId: string, siteId: string) {
  return prisma.siteAssignment.create({ data: { employeeId, siteId, isPrimary: true, validFrom: new Date('2000-01-01T00:00:00.000Z'), validTo: null, assignedByUserId: adminId } });
}
async function makePeriod(startDate: Date, endDate: Date) {
  return prisma.payrollPeriod.create({ data: { startDate, endDate, status: 'OPEN', openedByUserId: adminId } });
}
async function makeParticipant(periodId: string, employeeId: string) {
  return prisma.payrollPeriodParticipant.create({ data: { periodId, employeeId, expected: true } });
}
async function makeTimesheet(employeeId: string, periodId: string, status: TimesheetStatus) {
  return prisma.timesheet.create({ data: { employeeId, periodId, status } });
}
async function attachVersion(timesheetId: string, employeeId: string, setCurrent = true) {
  const existing = await prisma.timesheetVersion.count({ where: { timesheetId } });
  const version = await prisma.timesheetVersion.create({ data: { timesheetId, employeeId, versionNumber: existing + 1, source: 'WORKER', createdByUserId: adminId, submissionSource: 'MANUAL' } });
  if (setCurrent) await prisma.timesheet.update({ where: { id: timesheetId }, data: { currentVersionId: version.id } });
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
async function addVersionSegment(version: { id: string }, employeeId: string, siteId: string, sourceAssignmentId: string, date: Date, startAt: Date, endAt: Date, breaks: BreakInput[] = []) {
  const day = await ensureVersionDay(version.id, date);
  await ensureVersionPlannedShift(version.id, employeeId, date, siteId, sourceAssignmentId);
  const seg = await prisma.workSegment.create({ data: { timesheetDayId: day.id, timesheetVersionId: version.id, employeeId, date, startAt, endAt, siteId, sourceAssignmentId, crossesMidnight: false } });
  for (const b of breaks) await prisma.breakSegment.create({ data: { workSegmentId: seg.id, startAt: b.startAt, endAt: b.endAt, paid: b.paid } });
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
  for (const b of breaks) await prisma.timesheetDraftBreakSegment.create({ data: { draftSegmentId: seg.id, startAt: b.startAt, endAt: b.endAt, paid: b.paid } });
  return seg;
}

async function main() {
  adminId = await makeAdmin();

  // --- 1: FINAL_APPROVED, two days with breaks, single employee/site — totals must match T8.1 exactly. ---
  {
    const period = await makePeriod(new Date('2051-01-01'), new Date('2051-01-14'));
    const site = await makeSite('CR1');
    const emp = await makeEmployee('CR1');
    const asg = await makeAssignment(emp.id, site.id);
    await makeParticipant(period.id, emp.id);
    const ts = await makeTimesheet(emp.id, period.id, 'FINAL_APPROVED');
    const v = await attachVersion(ts.id, emp.id);
    await addVersionSegment(v, emp.id, site.id, asg.id, new Date('2051-01-02'), new Date('2051-01-02T08:00:00.000Z'), new Date('2051-01-02T16:00:00.000Z'), [
      { startAt: new Date('2051-01-02T12:00:00.000Z'), endAt: new Date('2051-01-02T12:30:00.000Z'), paid: false }
    ]);
    await addVersionSegment(v, emp.id, site.id, asg.id, new Date('2051-01-03'), new Date('2051-01-03T08:00:00.000Z'), new Date('2051-01-03T16:00:00.000Z'));

    const t81 = await getWorkerTimeReport(emp.id, period.id);
    if (t81.code !== 'OK') throw new Error('fixture broken: T8.1 report not OK');
    const t81Site = t81.report.sites.find((s) => s.siteId === site.id)!;

    const custom = await getCustomTimeReport({ dateFrom: period.startDate, dateTo: period.endDate, employeeIds: [emp.id], siteIds: null, dataMode: 'FINAL_APPROVED_ONLY' });
    const customEntry = custom.summaryRows.find((r) => r.employee.id === emp.id && r.site.id === site.id)!;

    check('1: custom summary grossMinutes matches T8.1', customEntry.grossMinutes === t81Site.grossMinutes, { custom: customEntry.grossMinutes, t81: t81Site.grossMinutes });
    check('1: custom summary paidBreakMinutes matches T8.1', customEntry.paidBreakMinutes === t81Site.paidBreakMinutes);
    check('1: custom summary unpaidBreakMinutes matches T8.1', customEntry.unpaidBreakMinutes === t81Site.unpaidBreakMinutes, { custom: customEntry.unpaidBreakMinutes, t81: t81Site.unpaidBreakMinutes });
    check('1: custom summary workedMinutes matches T8.1', customEntry.workedMinutes === t81Site.workedMinutes, { custom: customEntry.workedMinutes, t81: t81Site.workedMinutes });
    check('1: custom summary workedDays matches T8.1 workedDayCount', customEntry.workedDays === t81Site.workedDayCount);
    check('1: grand total equals the single summary row (single employee/site scope)', custom.grandTotal.workedMinutes === customEntry.workedMinutes);

    // Detailed rows: two segments, each single-segment-per-bucket-day, so per-segment minutes must
    // equal the bucket's rounded minutes exactly (no multi-segment-same-day ambiguity here).
    check('1: detail row count = 2 (one per segment)', custom.detailRows.length === 2, custom.detailRows.length);
    const sumDetailWorked = custom.detailRows.filter((r) => r.employee.id === emp.id && r.site.id === site.id).reduce((a, r) => a + r.workedMinutes, 0);
    check('1: sum(detail.workedMinutes) = summary.workedMinutes (single segment per bucket-day)', sumDetailWorked === customEntry.workedMinutes, { sumDetailWorked, summary: customEntry.workedMinutes });
    check('1: detail rows sorted by date ASC', custom.detailRows[0].date <= custom.detailRows[1].date);
  }

  // --- 2: DRAFT status + CURRENT_CANONICAL — must read TimesheetDraftSegment, matching T8.1's own DRAFT read. ---
  {
    const period = await makePeriod(new Date('2052-01-01'), new Date('2052-01-14'));
    const site = await makeSite('CR2');
    const emp = await makeEmployee('CR2');
    const asg = await makeAssignment(emp.id, site.id);
    await makeParticipant(period.id, emp.id);
    const ts = await makeTimesheet(emp.id, period.id, 'DRAFT');
    const { draft, day } = await attachDraftWithDay(ts.id, emp.id, new Date('2052-01-02'));
    await addDraftSegment(draft, day, emp.id, site.id, asg.id, new Date('2052-01-02'), new Date('2052-01-02T08:00:00.000Z'), new Date('2052-01-02T08:00:31.000Z'));

    const t81 = await getWorkerTimeReport(emp.id, period.id);
    if (t81.code !== 'OK') throw new Error('fixture broken');
    const t81Site = t81.report.sites.find((s) => s.siteId === site.id)!;

    const customCanonical = await getCustomTimeReport({ dateFrom: period.startDate, dateTo: period.endDate, employeeIds: [emp.id], siteIds: null, dataMode: 'CURRENT_CANONICAL' });
    const entry = customCanonical.summaryRows.find((r) => r.employee.id === emp.id)!;
    check('2: CURRENT_CANONICAL reads DRAFT source, worked matches T8.1', entry.workedMinutes === t81Site.workedMinutes, { custom: entry.workedMinutes, t81: t81Site.workedMinutes });

    const customFinalOnly = await getCustomTimeReport({ dateFrom: period.startDate, dateTo: period.endDate, employeeIds: [emp.id], siteIds: null, dataMode: 'FINAL_APPROVED_ONLY' });
    check('2: FINAL_APPROVED_ONLY excludes a DRAFT-status timesheet entirely', customFinalOnly.summaryRows.length === 0, customFinalOnly.summaryRows);
  }

  // --- 3: FINAL_APPROVED_ONLY vs CURRENT_CANONICAL scope difference across two employees in the same range. ---
  {
    const period = await makePeriod(new Date('2053-01-01'), new Date('2053-01-14'));
    const site = await makeSite('CR3');
    const empFinal = await makeEmployee('CR3F');
    const empDraft = await makeEmployee('CR3D');
    const asgFinal = await makeAssignment(empFinal.id, site.id);
    const asgDraft = await makeAssignment(empDraft.id, site.id);
    await makeParticipant(period.id, empFinal.id);
    await makeParticipant(period.id, empDraft.id);

    const tsFinal = await makeTimesheet(empFinal.id, period.id, 'FINAL_APPROVED');
    const vFinal = await attachVersion(tsFinal.id, empFinal.id);
    await addVersionSegment(vFinal, empFinal.id, site.id, asgFinal.id, new Date('2053-01-02'), new Date('2053-01-02T08:00:00.000Z'), new Date('2053-01-02T09:00:00.000Z'));

    const tsDraft = await makeTimesheet(empDraft.id, period.id, 'DRAFT');
    const { draft, day } = await attachDraftWithDay(tsDraft.id, empDraft.id, new Date('2053-01-02'));
    await addDraftSegment(draft, day, empDraft.id, site.id, asgDraft.id, new Date('2053-01-02'), new Date('2053-01-02T08:00:00.000Z'), new Date('2053-01-02T09:00:00.000Z'));

    const finalOnly = await getCustomTimeReport({ dateFrom: period.startDate, dateTo: period.endDate, employeeIds: null, siteIds: [site.id], dataMode: 'FINAL_APPROVED_ONLY' });
    const finalOnlyIds = finalOnly.summaryRows.map((r) => r.employee.id);
    check('3: FINAL_APPROVED_ONLY includes only the FINAL_APPROVED worker', finalOnlyIds.includes(empFinal.id) && !finalOnlyIds.includes(empDraft.id), finalOnlyIds);

    const canonical = await getCustomTimeReport({ dateFrom: period.startDate, dateTo: period.endDate, employeeIds: null, siteIds: [site.id], dataMode: 'CURRENT_CANONICAL' });
    const canonicalIds = canonical.summaryRows.map((r) => r.employee.id);
    check('3: CURRENT_CANONICAL includes both workers regardless of status', canonicalIds.includes(empFinal.id) && canonicalIds.includes(empDraft.id), canonicalIds);
  }

  // --- 4: multi-site/multi-employee — employeeSubtotals and siteSubtotals reconcile with grandTotal. ---
  {
    const period = await makePeriod(new Date('2054-01-01'), new Date('2054-01-14'));
    const siteA = await makeSite('CR4A');
    const siteB = await makeSite('CR4B');
    const empX = await makeEmployee('CR4X');
    const empY = await makeEmployee('CR4Y');
    const asgXA = await makeAssignment(empX.id, siteA.id);
    const asgXB = await makeAssignment(empX.id, siteB.id);
    const asgYA = await makeAssignment(empY.id, siteA.id);
    await makeParticipant(period.id, empX.id);
    await makeParticipant(period.id, empY.id);

    const tsX = await makeTimesheet(empX.id, period.id, 'FINAL_APPROVED');
    const vX = await attachVersion(tsX.id, empX.id);
    await addVersionSegment(vX, empX.id, siteA.id, asgXA.id, new Date('2054-01-02'), new Date('2054-01-02T08:00:00.000Z'), new Date('2054-01-02T09:00:00.000Z'));
    await addVersionSegment(vX, empX.id, siteB.id, asgXB.id, new Date('2054-01-02'), new Date('2054-01-02T10:00:00.000Z'), new Date('2054-01-02T11:00:00.000Z'));

    const tsY = await makeTimesheet(empY.id, period.id, 'FINAL_APPROVED');
    const vY = await attachVersion(tsY.id, empY.id);
    await addVersionSegment(vY, empY.id, siteA.id, asgYA.id, new Date('2054-01-02'), new Date('2054-01-02T08:00:00.000Z'), new Date('2054-01-02T09:30:00.000Z'));

    const report = await getCustomTimeReport({ dateFrom: period.startDate, dateTo: period.endDate, employeeIds: [empX.id, empY.id], siteIds: [siteA.id, siteB.id], dataMode: 'FINAL_APPROVED_ONLY' });

    const empXSubtotal = report.employeeSubtotals.find((e) => e.employee.id === empX.id)!;
    check('4: employee X subtotal = 60+60 = 120 min', empXSubtotal.totals.workedMinutes === 120, empXSubtotal);
    const siteASubtotal = report.siteSubtotals.find((s) => s.site.id === siteA.id)!;
    check('4: site A subtotal = 60 (X) + 90 (Y) = 150 min', siteASubtotal.totals.workedMinutes === 150, siteASubtotal);
    const sumEmployeeSubtotals = report.employeeSubtotals.reduce((a, e) => a + e.totals.workedMinutes, 0);
    const sumSiteSubtotals = report.siteSubtotals.reduce((a, s) => a + s.totals.workedMinutes, 0);
    check('4: sum(employeeSubtotals) = grandTotal', sumEmployeeSubtotals === report.grandTotal.workedMinutes, { sumEmployeeSubtotals, grand: report.grandTotal.workedMinutes });
    check('4: sum(siteSubtotals) = grandTotal', sumSiteSubtotals === report.grandTotal.workedMinutes, { sumSiteSubtotals, grand: report.grandTotal.workedMinutes });
    check('4: grandTotal.workedMinutes = 60+60+90 = 210', report.grandTotal.workedMinutes === 210, report.grandTotal);
  }

  // --- 5: date-range boundary — a segment just outside [dateFrom, dateTo] is excluded. ---
  {
    const period = await makePeriod(new Date('2055-01-01'), new Date('2055-01-31'));
    const site = await makeSite('CR5');
    const emp = await makeEmployee('CR5');
    const asg = await makeAssignment(emp.id, site.id);
    await makeParticipant(period.id, emp.id);
    const ts = await makeTimesheet(emp.id, period.id, 'FINAL_APPROVED');
    const v = await attachVersion(ts.id, emp.id);
    await addVersionSegment(v, emp.id, site.id, asg.id, new Date('2055-01-05'), new Date('2055-01-05T08:00:00.000Z'), new Date('2055-01-05T09:00:00.000Z'));
    await addVersionSegment(v, emp.id, site.id, asg.id, new Date('2055-01-20'), new Date('2055-01-20T08:00:00.000Z'), new Date('2055-01-20T09:00:00.000Z'));

    const narrow = await getCustomTimeReport({ dateFrom: new Date('2055-01-05'), dateTo: new Date('2055-01-05'), employeeIds: [emp.id], siteIds: null, dataMode: 'FINAL_APPROVED_ONLY' });
    check('5: narrow date range includes only the in-range segment', narrow.detailRows.length === 1 && narrow.detailRows[0].date === '2055-01-05', narrow.detailRows);
  }

  check('MAX_CUSTOM_REPORT_DAYS is 366 (§2 max range)', MAX_CUSTOM_REPORT_DAYS === 366);

  console.log(JSON.stringify({ pass, fail }, null, 2));
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error('SCRIPT ERROR', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
