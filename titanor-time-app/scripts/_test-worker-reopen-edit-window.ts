// T12 (owner model, 2026-08-28) — the worker owns the timesheet for the whole cycle + one grace
// day. reopenWorkerTimesheetForEdits takes a SUBMITTED/FOREMAN_APPROVED/FINAL_APPROVED timesheet
// back to DRAFT (draft repopulated from the current version, open admin edits auto-closed, no
// generation bump) while the period is OPEN and now < cutoff; refuses once the window is closed.
// Also checks computeTimesheetEditCutoff.
//
// Needs a disposable PostgreSQL 16 with all migrations applied (DATABASE_URL).
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { submitWorkerTimesheetCore, reopenWorkerTimesheetForEdits } from '../lib/worker-timesheets';
import { requestCorrection, openCorrectionDraft } from '../lib/corrections';
import { computeTimesheetEditCutoff } from '../lib/timesheet-edit-window';
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

async function makeAdmin(): Promise<string> {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const u = await prisma.user.create({ data: { username: `rw_${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } });
  return u.id;
}

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function makeSubmittedTimesheet(adminId: string, periodEndRaw: Date) {
  const periodEnd = utcMidnight(periodEndRaw);
  const site = await prisma.workSite.create({ data: { name: `RW ${randomUUID().slice(0, 5)}` } });
  const emp = await prisma.employee.create({ data: { employeeNumber: `RW-${randomUUID().slice(0, 8)}`, firstName: 'R', lastName: 'W' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: ASG_START } });
  const asg = await prisma.siteAssignment.create({ data: { employeeId: emp.id, siteId: site.id, isPrimary: true, validFrom: ASG_START, validTo: null, assignedByUserId: adminId } });
  const start = new Date(periodEnd.getTime() - 6 * 86400000);
  const period = await prisma.payrollPeriod.create({ data: { startDate: start, endDate: periodEnd, status: 'OPEN', openedByUserId: adminId } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'DRAFT' } });
  const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId: emp.id } });
  const day = new Date(start.getTime() + 2 * 86400000);
  await prisma.timesheetDraftPlannedShift.create({
    data: { draftId: draft.id, employeeId: emp.id, date: day, siteId: site.id, sourceAssignmentId: asg.id, plannedStartAt: new Date(day.getTime() + 7 * 3600000), plannedEndAt: new Date(day.getTime() + 15 * 3600000), plannedBreakMinutes: 30 }
  });
  const dd = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: day, dayType: 'WORK', confirmedZero: false } });
  await prisma.timesheetDraftSegment.create({ data: { draftDayId: dd.id, draftId: draft.id, employeeId: emp.id, date: day, startAt: new Date(day.getTime() + 7 * 3600000), endAt: new Date(day.getTime() + 15 * 3600000), siteId: site.id, sourceAssignmentId: asg.id } });
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${emp.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${ts.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE id = ${draft.id}::uuid FOR UPDATE`;
    await submitWorkerTimesheetCore(tx, emp.id, ts.id, adminId, randomUUID(), SubmissionSource.MANUAL);
  });
  return { timesheetId: ts.id, employeeId: emp.id, periodId: period.id, draftId: draft.id, day };
}

async function main() {
  const admin = await makeAdmin();

  // --- computeTimesheetEditCutoff: periodEnd + 1 day @ 23:59 Helsinki ---
  {
    const end = new Date('2026-08-30T00:00:00.000Z'); // Sun
    const cut = computeTimesheetEditCutoff(end, { cutoffDaysAfterPeriodEnd: 1, cutoffTime: new Date('1970-01-01T23:59:00.000Z') });
    // 2026-08-31 (Mon) 23:59 Helsinki = 20:59Z (EEST, +3)
    check('cutoff = Monday 23:59 Helsinki (20:59Z in summer)', cut.toISOString() === '2026-08-31T20:59:00.000Z', cut.toISOString());
  }

  // --- 1. within window: SUBMITTED -> reopen -> DRAFT, draft repopulated, no generation bump ---
  {
    const t = await makeSubmittedTimesheet(admin, new Date(new Date().getTime() + 2 * 86400000)); // period ends in 2 days -> well within window
    const before = await prisma.timesheet.findUniqueOrThrow({ where: { id: t.timesheetId }, select: { status: true, systemReopenGeneration: true } });
    check('fixture is SUBMITTED', before.status === 'SUBMITTED');

    const r = await reopenWorkerTimesheetForEdits(t.employeeId, t.timesheetId, admin, randomUUID());
    check('reopen ok', 'code' in r && r.code === 'REOPENED', r);
    const after = await prisma.timesheet.findUniqueOrThrow({ where: { id: t.timesheetId }, select: { status: true, systemReopenGeneration: true, lastReturnedReason: true } });
    check('status back to DRAFT', after.status === 'DRAFT', after.status);
    check('systemReopenGeneration NOT bumped (cutoff stays the period boundary)', after.systemReopenGeneration === before.systemReopenGeneration, after.systemReopenGeneration);
    check('lastReturnedReason cleared', after.lastReturnedReason === null);
    const draftDays = await prisma.timesheetDraftDay.count({ where: { draftId: t.draftId } });
    check('draft repopulated from the current version', draftDays >= 1, draftDays);
    const draftSeg = await prisma.timesheetDraftSegment.findFirst({ where: { draftId: t.draftId }, select: { id: true } });
    check('draft has the segment to edit', !!draftSeg);

    const audit = await prisma.auditEvent.findFirst({ where: { entityType: 'TIMESHEET', entityId: t.timesheetId, eventType: 'TIMESHEET_WORKER_REOPENED' }, select: { id: true } });
    check('TIMESHEET_WORKER_REOPENED audit written', !!audit);
  }

  // --- 2. reopen auto-closes an open admin edit ---
  {
    const t = await makeSubmittedTimesheet(admin, new Date(new Date().getTime() + 2 * 86400000));
    const cr = await requestCorrection(t.timesheetId, admin, '', randomUUID(), { directEdit: true });
    const crId = (cr as { id: string }).id;
    await openCorrectionDraft(crId, admin, randomUUID());
    await reopenWorkerTimesheetForEdits(t.employeeId, t.timesheetId, admin, randomUUID());
    const crAfter = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: crId }, select: { status: true } });
    check('open admin edit auto-closed to REJECTED on worker reopen', crAfter.status === 'REJECTED', crAfter);
  }

  // --- 3. past the cutoff: refuse ---
  {
    const t = await makeSubmittedTimesheet(admin, new Date(new Date().getTime() - 5 * 86400000)); // period ended 5 days ago -> cutoff long past
    const r = await reopenWorkerTimesheetForEdits(t.employeeId, t.timesheetId, admin, randomUUID());
    check('reopen refused after the cutoff', 'code' in r && r.code === 'EDIT_WINDOW_CLOSED', r);
    check('  timesheet still SUBMITTED', (await prisma.timesheet.findUniqueOrThrow({ where: { id: t.timesheetId }, select: { status: true } })).status === 'SUBMITTED');
  }

  // --- 4. period not OPEN: refuse ---
  {
    const t = await makeSubmittedTimesheet(admin, new Date(new Date().getTime() + 2 * 86400000));
    await prisma.payrollPeriod.update({ where: { id: t.periodId }, data: { status: 'LOCKED', lockedAt: new Date(), lockedByUserId: admin } });
    const r = await reopenWorkerTimesheetForEdits(t.employeeId, t.timesheetId, admin, randomUUID());
    check('reopen refused when the period is not OPEN', 'code' in r && r.code === 'EDIT_WINDOW_CLOSED', r);
  }

  // --- 5. a DRAFT timesheet: no-op ok ---
  {
    const t = await makeSubmittedTimesheet(admin, new Date(new Date().getTime() + 2 * 86400000));
    await prisma.timesheet.update({ where: { id: t.timesheetId }, data: { status: 'DRAFT' } });
    const r = await reopenWorkerTimesheetForEdits(t.employeeId, t.timesheetId, admin, randomUUID());
    check('reopen on an already-DRAFT timesheet is a no-op ok', 'code' in r && r.code === 'REOPENED', r);
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
