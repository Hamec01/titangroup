// R15-D7 Deploy F — "Часы заказчику". getCustomerTimeReport + resolveCustomerReadiness scoped by
// workAreaId, the CSV / PDF builders. Needs a disposable PostgreSQL 16 (DATABASE_URL).
//
// Mandatory scenarios (docs/titanor-time/R15_D7_DEPLOY_F_SPEC_RU.md §8):
//   1  one site, two customers, different workers/hours — reports fully separated
//   2  one worker, two customers on different days — minutes split correctly
//   3  worker later transferred — historical hours stay with the OLD customer (by segment workAreaId)
//   4  disabled customer still reportable
//   5  an unapproved timesheet blocks the FINAL export of ITS customer only
//   8  PDF, CSV and the report object agree to the minute
//   9  a foreign workAreaId / spoofed name never mixes data (names resolved by id, filter by id)
//  (6/7/10 — pagination, reload/Back-Forward/RU-EN, "no customer" no client PDF — the browser test)

import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { submitWorkerTimesheetCore } from '../lib/worker-timesheets';
import { getCustomerTimeReport } from '../lib/reporting/customer-time-report';
import { resolveCustomerReadiness } from '../lib/reporting/customer-hours';
import { buildCustomerHoursCsv } from '../lib/reporting/customer-hours-csv';
import { buildCustomerHoursPdf } from '../lib/reporting/customer-hours-pdf';
import { SubmissionSource } from '@prisma/client';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL:', n, x !== undefined ? JSON.stringify(x).slice(0, 400) : '');
  }
};

const at = (day: Date, h: number) => new Date(day.getTime() + h * 3600_000);
let adminId = '';

async function mkSite(tag: string) {
  return prisma.workSite.create({ data: { name: `F-${tag}-${randomUUID().slice(0, 5)}` } });
}
async function mkWorkArea(siteId: string, name: string, active = true) {
  return prisma.workArea.create({ data: { siteId, name: `${name}-${randomUUID().slice(0, 4)}`, active } });
}
async function mkWorker(tag: string) {
  const emp = await prisma.employee.create({ data: { employeeNumber: `F-${tag}-${randomUUID().slice(0, 6)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  return emp;
}
async function mkAssignment(employeeId: string, siteId: string, workAreaId: string | null, isPrimary: boolean, validFrom = new Date('2020-01-01T00:00:00.000Z'), validTo: Date | null = null) {
  return prisma.siteAssignment.create({ data: { employeeId, siteId, workAreaId, isPrimary, validFrom, validTo, assignedByUserId: adminId } });
}

/** N worked days (07:00–15:00 each → 7h30 after the 30-min auto lunch) for one worker, ALL inside
 *  one fresh period/timesheet/draft, ONE submit (materialises WorkSegments carrying workAreaId),
 *  optionally final-approved. Every day must land in the same 7-day window (anchored on days[0]). */
async function workedDays(opts: {
  employeeId: string;
  siteId: string;
  days: { day: Date; workAreaId: string | null; assignmentId: string }[];
  finalApprove?: boolean;
}) {
  const { employeeId, siteId, days } = opts;
  const anchor = days[0].day;
  const period = await prisma.payrollPeriod.create({ data: { startDate: anchor, endDate: new Date(anchor.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminId } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId, periodId: period.id, status: 'DRAFT' } });
  const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId } });

  for (const { day, workAreaId, assignmentId } of days) {
    await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft.id, employeeId, date: day, siteId, sourceAssignmentId: assignmentId, plannedStartAt: at(day, 7), plannedEndAt: at(day, 15), plannedBreakMinutes: 0 } });
    const dd = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: day, dayType: 'WORK', confirmedZero: false } });
    await prisma.timesheetDraftSegment.create({ data: { draftDayId: dd.id, draftId: draft.id, employeeId, date: day, startAt: at(day, 7), endAt: at(day, 15), siteId, workAreaId, sourceAssignmentId: assignmentId } });
  }

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${ts.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE id = ${draft.id}::uuid FOR UPDATE`;
    await submitWorkerTimesheetCore(tx, employeeId, ts.id, adminId, randomUUID(), SubmissionSource.MANUAL);
  });
  if (opts.finalApprove) await prisma.timesheet.update({ where: { id: ts.id }, data: { status: 'FINAL_APPROVED' } });
  return { periodId: period.id, timesheetId: ts.id };
}
const workedDay = (opts: { employeeId: string; siteId: string; workAreaId: string | null; assignmentId: string; day: Date; finalApprove?: boolean }) =>
  workedDays({ employeeId: opts.employeeId, siteId: opts.siteId, finalApprove: opts.finalApprove, days: [{ day: opts.day, workAreaId: opts.workAreaId, assignmentId: opts.assignmentId }] });

async function main() {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  adminId = (await prisma.user.create({ data: { username: `f_${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } })).id;

  const D = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

  // ── Scenario 1 + 9: one SITE, two CUSTOMERS, different workers ──────────────────────────────
  const site = await mkSite('s1');
  const waA = await mkWorkArea(site.id, 'Aros');
  const waB = await mkWorkArea(site.id, 'Beta');
  const wA = await mkWorker('A1');
  const wB = await mkWorker('B1');
  const asgA = await mkAssignment(wA.id, site.id, waA.id, true);
  const asgB = await mkAssignment(wB.id, site.id, waB.id, true);
  const day1 = D(2099, 5, 1);
  await workedDay({ employeeId: wA.id, siteId: site.id, workAreaId: waA.id, assignmentId: asgA.id, day: day1, finalApprove: true });
  await workedDay({ employeeId: wB.id, siteId: site.id, workAreaId: waB.id, assignmentId: asgB.id, day: day1, finalApprove: true });

  const from = D(2099, 5, 1);
  const to = D(2099, 5, 7);
  {
    const rep = await getCustomerTimeReport({ dateFrom: from, dateTo: to, workAreaIds: [waA.id], includeNoCustomer: false, employeeIds: null, dataMode: 'CURRENT_CANONICAL' });
    const empIds = rep.sections.flatMap((s) => s.workers.map((w) => w.employee.id));
    check('1: report(Aros) has exactly one section for Aros', rep.sections.length === 1 && rep.sections[0].workAreaId === waA.id, rep.sections.map((s) => s.workAreaName));
    check('1: report(Aros) contains ONLY worker A — not worker B', empIds.length === 1 && empIds[0] === wA.id, empIds);
    check('1: report(Aros) total = 450 min (7h30), grand = 450', rep.sections[0].totalMinutes === 450 && rep.grandTotalMinutes === 450, { sec: rep.sections[0].totalMinutes, grand: rep.grandTotalMinutes });
    check('1: report(Aros) assignedNow = 1, workedInPeriod = 1', rep.sections[0].assignedNowCount === 1 && rep.sections[0].workedInPeriodCount === 1, rep.sections[0]);

    const csv = buildCustomerHoursCsv(rep).toString();
    check('9: CSV(Aros) has no "Beta" customer + no worker B number', !csv.includes(waB.name) && !csv.includes(wB.employeeNumber), csv.slice(0, 200));
  }
  {
    // both customers -> two sections, grand = 900
    const rep = await getCustomerTimeReport({ dateFrom: from, dateTo: to, workAreaIds: [waA.id, waB.id], includeNoCustomer: false, employeeIds: null, dataMode: 'CURRENT_CANONICAL' });
    check('1: report(Aros+Beta) has 2 sections, grand = 900', rep.sections.length === 2 && rep.grandTotalMinutes === 900, rep.sections.map((s) => s.totalMinutes));
    const csv = buildCustomerHoursCsv(rep).toString();
    check('8: CSV GRAND_TOTAL row = 900 min & 15.00 h', csv.includes('"GRAND_TOTAL"') && csv.includes('"900"') && csv.includes('"15.00"'), csv.split('\r\n').find((l) => l.includes('GRAND_TOTAL')));
    const pdf = await buildCustomerHoursPdf(rep, { generatedAtHelsinki: '01/01/2026, 12:00', preparedBy: 'admin', isFinalApproved: true });
    check('8: PDF builds (%PDF)', pdf.subarray(0, 4).toString() === '%PDF' && pdf.length > 900);
    check('8: report grand = sum of section totals (to the minute)', rep.grandTotalMinutes === rep.sections.reduce((s, x) => s + x.totalMinutes, 0));
  }

  // ── Scenario 2: one worker, two customers on different days — minutes split ─────────────────
  {
    const w2 = await mkWorker('C2');
    const asg2a = await mkAssignment(w2.id, site.id, waA.id, true);
    const asg2b = await mkAssignment(w2.id, site.id, waB.id, false);
    await workedDays({
      employeeId: w2.id,
      siteId: site.id,
      finalApprove: true,
      days: [
        { day: D(2099, 5, 2), workAreaId: waA.id, assignmentId: asg2a.id },
        { day: D(2099, 5, 3), workAreaId: waB.id, assignmentId: asg2b.id }
      ]
    });

    const repA = await getCustomerTimeReport({ dateFrom: from, dateTo: to, workAreaIds: [waA.id], includeNoCustomer: false, employeeIds: [w2.id], dataMode: 'CURRENT_CANONICAL' });
    const repB = await getCustomerTimeReport({ dateFrom: from, dateTo: to, workAreaIds: [waB.id], includeNoCustomer: false, employeeIds: [w2.id], dataMode: 'CURRENT_CANONICAL' });
    check('2: worker C2 has 450 min on Aros (one day only)', repA.sections[0]?.workers[0]?.workedMinutes === 450 && repA.sections[0].workers[0].workDates.length === 1, repA.sections[0]?.workers[0]);
    check('2: worker C2 has 450 min on Beta (the other day)', repB.sections[0]?.workers[0]?.workedMinutes === 450 && repB.sections[0].workers[0].workDates[0] === '2099-06-03', repB.sections[0]?.workers[0]);
    check('2: Aros date != Beta date (minutes not double-counted)', repA.sections[0].workers[0].workDates[0] !== repB.sections[0].workers[0].workDates[0]);
  }

  // ── Scenario 3: worker transferred to another customer — historical hours stay with OLD ─────
  {
    const w3 = await mkWorker('T3');
    // worked for Aros on day 4, THEN transferred to Beta — the old Aros assignment is
    // operationally removed (clockInDisabledAt) so it is no longer "assigned now".
    const asg3a = await mkAssignment(w3.id, site.id, waA.id, true, D(2020, 0, 1), null);
    await workedDay({ employeeId: w3.id, siteId: site.id, workAreaId: waA.id, assignmentId: asg3a.id, day: D(2099, 5, 4), finalApprove: true });
    await prisma.siteAssignment.update({ where: { id: asg3a.id }, data: { clockInDisabledAt: new Date(), isPrimary: false } });
    await mkAssignment(w3.id, site.id, waB.id, true, D(2099, 5, 5), null); // now on Beta

    const repA = await getCustomerTimeReport({ dateFrom: from, dateTo: to, workAreaIds: [waA.id], includeNoCustomer: false, employeeIds: [w3.id], dataMode: 'CURRENT_CANONICAL' });
    const t3rowA = repA.sections[0]?.workers.find((w) => w.employee.id === w3.id);
    check('3: transferred worker T3 STILL in the Aros report for the day worked there (450 min)', t3rowA?.workedMinutes === 450 && t3rowA.workedInPeriod === true, t3rowA);
    check('3: T3 is NOT "assigned now" to Aros (assignment removed)', t3rowA?.assignedNow === false && repA.sections[0].assignedNowCount === 0, repA.sections[0]);
    const repB = await getCustomerTimeReport({ dateFrom: from, dateTo: to, workAreaIds: [waB.id], includeNoCustomer: false, employeeIds: [w3.id], dataMode: 'CURRENT_CANONICAL' });
    check('3: T3 has NO Aros hours leaking into the Beta report', !repB.sections.some((s) => s.workers.some((w) => w.employee.id === w3.id && w.workedMinutes > 0)), repB.sections.map((s) => s.workers));
  }

  // ── Scenario 4: disabled customer still reportable ─────────────────────────────────────────
  {
    const site4 = await mkSite('s4');
    const waDisabled = await mkWorkArea(site4.id, 'Gone', false);
    const w4 = await mkWorker('D4');
    const asg4 = await mkAssignment(w4.id, site4.id, waDisabled.id, true);
    await workedDay({ employeeId: w4.id, siteId: site4.id, workAreaId: waDisabled.id, assignmentId: asg4.id, day: D(2099, 5, 6), finalApprove: true });
    const rep = await getCustomerTimeReport({ dateFrom: from, dateTo: to, workAreaIds: [waDisabled.id], includeNoCustomer: false, employeeIds: null, dataMode: 'CURRENT_CANONICAL' });
    check('4: disabled customer report still returns the section + hours', rep.sections.length === 1 && rep.sections[0].customerActive === false && rep.sections[0].totalMinutes === 450, rep.sections[0]);
  }

  // ── Scenario 5: an unapproved timesheet blocks the FINAL export of ITS customer only ───────
  {
    const site5 = await mkSite('s5');
    const wa5a = await mkWorkArea(site5.id, 'Ready');
    const wa5b = await mkWorkArea(site5.id, 'Pending');
    const w5a = await mkWorker('R5');
    const w5b = await mkWorker('P5');
    const a5a = await mkAssignment(w5a.id, site5.id, wa5a.id, true);
    const a5b = await mkAssignment(w5b.id, site5.id, wa5b.id, true);
    const dd = D(2099, 6, 6);
    await workedDay({ employeeId: w5a.id, siteId: site5.id, workAreaId: wa5a.id, assignmentId: a5a.id, day: dd, finalApprove: true });
    await workedDay({ employeeId: w5b.id, siteId: site5.id, workAreaId: wa5b.id, assignmentId: a5b.id, day: dd, finalApprove: false }); // stays SUBMITTED

    const f5 = D(2099, 6, 6);
    const t5 = D(2099, 6, 12);
    const rReady = await resolveCustomerReadiness({ dateFrom: f5, dateTo: t5, employeeIds: null, workAreaIds: [wa5a.id], includeNoCustomer: false });
    check('5: readiness(Ready only) = CUSTOMER_FINAL (no blocker)', rReady.level === 'CUSTOMER_FINAL' && rReady.blockers.length === 0, rReady);
    const rPending = await resolveCustomerReadiness({ dateFrom: f5, dateTo: t5, employeeIds: null, workAreaIds: [wa5b.id], includeNoCustomer: false });
    check('5: readiness(Pending only) = INTERNAL_PREVIEW_ONLY, 1 blocker linking the timesheet', rPending.level === 'INTERNAL_PREVIEW_ONLY' && rPending.blockers.length === 1 && rPending.blockers[0].link.includes('/admin/timesheets/'), rPending);
    const rBoth = await resolveCustomerReadiness({ dateFrom: f5, dateTo: t5, employeeIds: null, workAreaIds: [wa5a.id, wa5b.id], includeNoCustomer: false });
    check('5: readiness(Ready+Pending) is blocked (the pending one carries over)', rBoth.level === 'INTERNAL_PREVIEW_ONLY' && rBoth.blockers.length === 1, rBoth);

    // Regression: readiness must not overlook a matching customer segment after an arbitrary
    // relation cap. The selected-customer segment is deliberately appended after 200 others.
    const w5c = await mkWorker('L5');
    const a5c = await mkAssignment(w5c.id, site5.id, wa5a.id, true);
    const dense = await workedDay({ employeeId: w5c.id, siteId: site5.id, workAreaId: wa5a.id, assignmentId: a5c.id, day: dd, finalApprove: false });
    const seedSegment = await prisma.workSegment.findFirstOrThrow({ where: { timesheetVersion: { timesheetId: dense.timesheetId } } });
    await prisma.workSegment.createMany({
      data: [
        ...Array.from({ length: 200 }, () => ({
          timesheetDayId: seedSegment.timesheetDayId,
          timesheetVersionId: seedSegment.timesheetVersionId,
          employeeId: seedSegment.employeeId,
          date: seedSegment.date,
          startAt: seedSegment.startAt,
          endAt: seedSegment.endAt,
          siteId: seedSegment.siteId,
          workAreaId: wa5a.id,
          sourceAssignmentId: seedSegment.sourceAssignmentId,
          crossesMidnight: seedSegment.crossesMidnight
        })),
        {
          timesheetDayId: seedSegment.timesheetDayId,
          timesheetVersionId: seedSegment.timesheetVersionId,
          employeeId: seedSegment.employeeId,
          date: seedSegment.date,
          startAt: seedSegment.startAt,
          endAt: seedSegment.endAt,
          siteId: seedSegment.siteId,
          workAreaId: wa5b.id,
          sourceAssignmentId: seedSegment.sourceAssignmentId,
          crossesMidnight: seedSegment.crossesMidnight
        }
      ]
    });
    const rLate = await resolveCustomerReadiness({ dateFrom: f5, dateTo: t5, employeeIds: [w5c.id], workAreaIds: [wa5b.id], includeNoCustomer: false });
    check('5: readiness finds the selected customer after 200 foreign segments', rLate.level === 'INTERNAL_PREVIEW_ONLY' && rLate.blockers.length === 1, rLate);
  }

  // ── Scenario 10 (server flag): includeNoCustomer marks the report so the route can refuse ──
  {
    const site10 = await mkSite('s10');
    const w10 = await mkWorker('N10');
    const asg10 = await mkAssignment(w10.id, site10.id, null, true); // NO customer
    await workedDay({ employeeId: w10.id, siteId: site10.id, workAreaId: null, assignmentId: asg10.id, day: D(2099, 7, 6), finalApprove: true });
    const rep = await getCustomerTimeReport({ dateFrom: D(2099, 7, 6), dateTo: D(2099, 7, 12), workAreaIds: [], includeNoCustomer: true, employeeIds: null, dataMode: 'CURRENT_CANONICAL' });
    check('10: no-customer report has includesNoCustomer=true + a NULL-workArea section', rep.includesNoCustomer === true && rep.sections.length === 1 && rep.sections[0].workAreaId === null, rep.sections);
  }

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
