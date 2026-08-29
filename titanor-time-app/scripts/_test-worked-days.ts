// T13.7 (2026-08-29) — workedDays across sites (docs/titanor-time/T13 §12). The custom report's
// employee subtotal and grand total must be COUNT DISTINCT date / COUNT DISTINCT (employeeId,
// date), NOT the sum of the per-(employee, site) row counts. Worked example: one worker, one
// calendar date, two sites -> employee = 1, grand = 1, each site subtotal = 1.
//
// Needs a disposable PostgreSQL 16 with all migrations applied (DATABASE_URL).
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { getCustomTimeReport } from '../lib/reporting/custom-time-report';
import { submitWorkerTimesheetCore } from '../lib/worker-timesheets';
import { SubmissionSource } from '@prisma/client';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else {
    fail++;
    console.log('FAIL:', n, x ?? '');
  }
};

const ASG_START = new Date('2020-01-01T00:00:00.000Z');
const at = (day: Date, hour: number) => new Date(day.getTime() + hour * 3600_000);

async function main() {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const admin = (await prisma.user.create({ data: { username: `wd_${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } })).id;

  const siteA = await prisma.workSite.create({ data: { name: `WD-A ${randomUUID().slice(0, 4)}` } });
  const siteB = await prisma.workSite.create({ data: { name: `WD-B ${randomUUID().slice(0, 4)}` } });
  const emp = await prisma.employee.create({ data: { employeeNumber: `WD-${randomUUID().slice(0, 8)}`, firstName: 'Worked', lastName: 'Days' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: ASG_START } });
  const asgA = await prisma.siteAssignment.create({ data: { employeeId: emp.id, siteId: siteA.id, isPrimary: true, validFrom: ASG_START, validTo: null, assignedByUserId: admin } });
  const asgB = await prisma.siteAssignment.create({ data: { employeeId: emp.id, siteId: siteB.id, isPrimary: false, validFrom: ASG_START, validTo: null, assignedByUserId: admin } });

  const dayBase = new Date(Date.UTC(2099, 2, 2)); // one calendar date
  const period = await prisma.payrollPeriod.create({ data: { startDate: dayBase, endDate: new Date(dayBase.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: admin } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'DRAFT' } });
  const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId: emp.id } });

  for (const [site, asg, hours] of [[siteA, asgA, [7, 11]], [siteB, asgB, [12, 16]]] as const) {
    await prisma.timesheetDraftPlannedShift.create({
      data: { draftId: draft.id, employeeId: emp.id, date: dayBase, siteId: site.id, sourceAssignmentId: asg.id, plannedStartAt: at(dayBase, hours[0]), plannedEndAt: at(dayBase, hours[1]), plannedBreakMinutes: 0 }
    });
    const draftDay = await prisma.timesheetDraftDay.upsert({
      where: { draftId_date: { draftId: draft.id, date: dayBase } },
      create: { draftId: draft.id, date: dayBase, dayType: 'WORK', confirmedZero: false },
      update: {}
    });
    await prisma.timesheetDraftSegment.create({
      data: { draftDayId: draftDay.id, draftId: draft.id, employeeId: emp.id, date: dayBase, startAt: at(dayBase, hours[0]), endAt: at(dayBase, hours[1]), siteId: site.id, sourceAssignmentId: asg.id }
    });
  }
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${emp.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${ts.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE id = ${draft.id}::uuid FOR UPDATE`;
    await submitWorkerTimesheetCore(tx, emp.id, ts.id, admin, randomUUID(), SubmissionSource.MANUAL);
  });

  const report = await getCustomTimeReport({ dateFrom: dayBase, dateTo: new Date(dayBase.getTime() + 6 * 86400000), employeeIds: [emp.id], siteIds: null, dataMode: 'CURRENT_CANONICAL' });

  check('two summary rows (one per site)', report.summaryRows.length === 2, report.summaryRows.map((r) => r.site.name));
  check('each summary row workedDays = 1', report.summaryRows.every((r) => r.workedDays === 1), report.summaryRows.map((r) => r.workedDays));

  const empSub = report.employeeSubtotals.find((e) => e.employee.id === emp.id);
  check('employee subtotal workedDays = 1 (one calendar date across two sites)', empSub?.totals.workedDays === 1, empSub?.totals.workedDays);

  check('grand total workedDays = 1', report.grandTotal.workedDays === 1, report.grandTotal.workedDays);

  const siteSubA = report.siteSubtotals.find((s) => s.site.id === siteA.id);
  const siteSubB = report.siteSubtotals.find((s) => s.site.id === siteB.id);
  check('site A subtotal workedDays = 1', siteSubA?.totals.workedDays === 1, siteSubA?.totals.workedDays);
  check('site B subtotal workedDays = 1', siteSubB?.totals.workedDays === 1, siteSubB?.totals.workedDays);

  // minutes still add up: 4h + 4h = 8h = 480 min worked
  check('grand total workedMinutes = 480 (4h + 4h)', report.grandTotal.workedMinutes === 480, report.grandTotal.workedMinutes);
  check('employee subtotal workedMinutes = sum of its summary rows', empSub?.totals.workedMinutes === report.summaryRows.reduce((s, r) => s + r.workedMinutes, 0), empSub?.totals.workedMinutes);

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
