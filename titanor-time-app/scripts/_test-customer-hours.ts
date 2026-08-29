// T13.11 (2026-08-29) — Customer Project Working Hours: resolveCustomerReadiness (FINAL /
// blocker / noData), the daily rows, and the PDF / CSV builders (row_type column, decimal hours,
// no UUID / PII / money).
//
// Needs a disposable PostgreSQL 16 with all migrations applied (DATABASE_URL).
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { submitWorkerTimesheetCore } from '../lib/worker-timesheets';
import { getCustomTimeReport } from '../lib/reporting/custom-time-report';
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
    console.log('FAIL:', n, x ?? '');
  }
};

const ASG_START = new Date('2020-01-01T00:00:00.000Z');
const at = (day: Date, h: number) => new Date(day.getTime() + h * 3600_000);

async function buildTimesheet(adminId: string, weekOffset: number, finalApprove: boolean, empty = false) {
  const site = await prisma.workSite.create({ data: { name: `CH ${randomUUID().slice(0, 5)}` } });
  const emp = await prisma.employee.create({ data: { employeeNumber: `CH-${randomUUID().slice(0, 8)}`, firstName: 'C', lastName: `H${weekOffset}` } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: ASG_START } });
  const asg = await prisma.siteAssignment.create({ data: { employeeId: emp.id, siteId: site.id, isPrimary: true, validFrom: ASG_START, validTo: null, assignedByUserId: adminId } });
  const dayBase = new Date(Date.UTC(2099, 3, 6) + weekOffset * 7 * 86400000);
  const period = await prisma.payrollPeriod.create({ data: { startDate: dayBase, endDate: new Date(dayBase.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminId } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'DRAFT' } });
  const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId: emp.id } });

  if (!empty) {
    await prisma.timesheetDraftPlannedShift.create({ data: { draftId: draft.id, employeeId: emp.id, date: dayBase, siteId: site.id, sourceAssignmentId: asg.id, plannedStartAt: at(dayBase, 7), plannedEndAt: at(dayBase, 15), plannedBreakMinutes: 0 } });
    const dd = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: dayBase, dayType: 'WORK', confirmedZero: false } });
    await prisma.timesheetDraftSegment.create({ data: { draftDayId: dd.id, draftId: draft.id, employeeId: emp.id, date: dayBase, startAt: at(dayBase, 7), endAt: at(dayBase, 15), siteId: site.id, sourceAssignmentId: asg.id } });
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${emp.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${ts.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE id = ${draft.id}::uuid FOR UPDATE`;
      await submitWorkerTimesheetCore(tx, emp.id, ts.id, adminId, randomUUID(), SubmissionSource.MANUAL);
    });
    if (finalApprove) {
      await prisma.timesheet.update({ where: { id: ts.id }, data: { status: 'FINAL_APPROVED' } });
    }
  }
  return { employeeId: emp.id, timesheetId: ts.id, dayBase, siteId: site.id, periodEnd: new Date(dayBase.getTime() + 6 * 86400000) };
}

async function main() {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const admin = (await prisma.user.create({ data: { username: `ch_${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } })).id;

  const finalTs = await buildTimesheet(admin, 0, true);
  const submittedTs = await buildTimesheet(admin, 1, false);
  const emptyTs = await buildTimesheet(admin, 2, false, true);

  const from = new Date(Date.UTC(2099, 3, 6));
  const to = new Date(finalTs.periodEnd.getTime());

  // 1. readiness for the FINAL-only worker -> CUSTOMER_FINAL
  {
    const r = await resolveCustomerReadiness({ dateFrom: from, dateTo: to, employeeIds: [finalTs.employeeId], siteIds: null });
    check('FINAL-only scope -> CUSTOMER_FINAL, no blockers', r.level === 'CUSTOMER_FINAL' && r.blockers.length === 0, r);
  }

  // 2. readiness including the SUBMITTED worker -> blocked, with a link
  {
    const wideTo = new Date(submittedTs.periodEnd.getTime());
    const r = await resolveCustomerReadiness({ dateFrom: from, dateTo: wideTo, employeeIds: [finalTs.employeeId, submittedTs.employeeId], siteIds: null });
    check('scope with a SUBMITTED timesheet -> INTERNAL_PREVIEW_ONLY', r.level === 'INTERNAL_PREVIEW_ONLY', r.level);
    check('  blocker names the worker + links to the timesheet', r.blockers.length === 1 && r.blockers[0].timesheetId === submittedTs.timesheetId && r.blockers[0].link.includes(submittedTs.timesheetId), r.blockers);
  }

  // 3. empty draft worker -> noData, not a hard blocker
  {
    const wideTo = new Date(emptyTs.periodEnd.getTime());
    const r = await resolveCustomerReadiness({ dateFrom: from, dateTo: wideTo, employeeIds: [finalTs.employeeId, emptyTs.employeeId], siteIds: null });
    check('empty draft worker -> noData, still CUSTOMER_FINAL', r.level === 'CUSTOMER_FINAL' && r.noData.length === 1 && r.noData[0].employeeNumber !== '', r);
  }

  // 4. site filter narrows the readiness scope
  {
    const wideTo = new Date(submittedTs.periodEnd.getTime());
    const r = await resolveCustomerReadiness({ dateFrom: from, dateTo: wideTo, employeeIds: null, siteIds: [finalTs.siteId] });
    check('site filter -> only the FINAL site is in scope -> CUSTOMER_FINAL', r.level === 'CUSTOMER_FINAL', r);
  }

  // 5. report daily rows + PDF/CSV
  {
    const report = await getCustomTimeReport({ dateFrom: from, dateTo: to, employeeIds: [finalTs.employeeId], siteIds: null, dataMode: 'FINAL_APPROVED_ONLY' });
    check('report has 1 daily row (one worker, one day, one site)', report.dailyRows.length === 1, report.dailyRows);
    // 8h gross, minus the automatic 30-min unpaid lunch (T10-D) -> 450 worked minutes = 7.50 h.
    check('  daily row: 7.5h worked (8h - 30min auto lunch), first/last time set', report.dailyRows[0].workedMinutes === 450 && !!report.dailyRows[0].firstStartAt && !!report.dailyRows[0].lastEndAt, report.dailyRows[0]);

    const csv = buildCustomerHoursCsv(report);
    const text = csv.toString();
    check('CSV: BOM + row_type header + DETAIL + GRAND_TOTAL', csv.subarray(0, 3).toString('hex') === 'efbbbf' && text.includes('row_type') && text.includes('"DETAIL"') && text.includes('"GRAND_TOTAL"'), text.slice(0, 120));
    check('  CSV decimal hours with a dot, no UUID, no henkilötunnus/address', /"7\.50"/.test(text) && !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(text) && !/personalIdentity|addressStreet/i.test(text));

    const pdfFinal = await buildCustomerHoursPdf(report, { customer: 'Meyer Turku', projectReference: 'PO-42', generatedAtHelsinki: '01/01/2026, 12:00', preparedBy: 'admin', isFinalApproved: true });
    check('final PDF builds (%PDF)', pdfFinal.subarray(0, 4).toString() === '%PDF' && pdfFinal.length > 900);
    const pdfPreview = await buildCustomerHoursPdf(report, { customer: '', projectReference: '', generatedAtHelsinki: '01/01/2026, 12:00', preparedBy: 'admin', isFinalApproved: false });
    check('preview PDF builds', pdfPreview.subarray(0, 4).toString() === '%PDF');
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
