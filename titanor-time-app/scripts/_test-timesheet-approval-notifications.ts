// T12 §1a (2026-08-28) — the Admin Notification Center gets a "нужно утвердить" alert per pending
// timesheet: ensureTimesheetApprovalNotifications() creates one active AdminNotification per
// SUBMITTED/FOREMAN_APPROVED timesheet in an OPEN period, is idempotent, resolves the row once the
// timesheet leaves that state (and re-creates it on a resubmit), and getReviewQueueWeeks() groups
// the queue per open period for the header calendar drawer.
//
// Needs a disposable PostgreSQL 16 with all migrations applied (DATABASE_URL).
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { submitWorkerTimesheetCore } from '../lib/worker-timesheets';
import { listActiveNotificationsForAdmin } from '../lib/qualification-notifications';
import { ensureTimesheetApprovalNotifications } from '../lib/timesheet-approval-notifications';
import { getReviewQueueWeeks, getReviewQueueCount } from '../lib/admin-timesheets';
import { SubmissionSource } from '@prisma/client';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL: ${name}`, extra ?? '');
  }
}

const ASG_START = new Date('2020-01-01T00:00:00.000Z');

async function makeAdmin(): Promise<string> {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const user = await prisma.user.create({ data: { username: `tan_admin_${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } });
  return user.id;
}

async function makeSubmittedTimesheet(adminId: string, weekOffset: number) {
  const site = await prisma.workSite.create({ data: { name: `TAN ${randomUUID().slice(0, 5)}` } });
  const emp = await prisma.employee.create({ data: { employeeNumber: `TAN-${randomUUID().slice(0, 8)}`, firstName: 'T', lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: ASG_START } });
  const asg = await prisma.siteAssignment.create({ data: { employeeId: emp.id, siteId: site.id, isPrimary: true, validFrom: ASG_START, validTo: null, assignedByUserId: adminId } });

  const dayBase = new Date(Date.UTC(2099, 0, 5) + weekOffset * 7 * 86400000);
  const period = await prisma.payrollPeriod.create({ data: { startDate: dayBase, endDate: new Date(dayBase.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminId } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'DRAFT' } });
  const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId: emp.id } });
  await prisma.timesheetDraftPlannedShift.create({
    data: { draftId: draft.id, employeeId: emp.id, date: dayBase, siteId: site.id, sourceAssignmentId: asg.id, plannedStartAt: new Date(dayBase.getTime() + 7 * 3600000), plannedEndAt: new Date(dayBase.getTime() + 15 * 3600000), plannedBreakMinutes: 0 }
  });
  const draftDay = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: dayBase, dayType: 'WORK', confirmedZero: false } });
  await prisma.timesheetDraftSegment.create({
    data: { draftDayId: draftDay.id, draftId: draft.id, employeeId: emp.id, date: dayBase, startAt: new Date(dayBase.getTime() + 7 * 3600000), endAt: new Date(dayBase.getTime() + 15 * 3600000), siteId: site.id, sourceAssignmentId: asg.id }
  });
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${emp.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${ts.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE id = ${draft.id}::uuid FOR UPDATE`;
    await submitWorkerTimesheetCore(tx, emp.id, ts.id, adminId, randomUUID(), SubmissionSource.MANUAL);
  });
  return { timesheetId: ts.id, employeeId: emp.id, periodId: period.id, start: dayBase.toISOString().slice(0, 10) };
}

async function activeCountFor(timesheetId: string): Promise<number> {
  return prisma.adminNotification.count({ where: { timesheetId, type: 'TIMESHEET_AWAITING_APPROVAL', resolvedAt: null } });
}

async function main() {
  const admin = await makeAdmin();
  const baselineWeeks = await getReviewQueueWeeks();
  const baselineTsIds = new Set<string>();

  // 1. A SUBMITTED timesheet gets exactly one active notification.
  const a = await makeSubmittedTimesheet(admin, 0);
  await ensureTimesheetApprovalNotifications();
  check('one active TIMESHEET_AWAITING_APPROVAL after submit', (await activeCountFor(a.timesheetId)) === 1);

  // 2. Idempotent — running again does not create a second.
  await ensureTimesheetApprovalNotifications();
  await ensureTimesheetApprovalNotifications();
  check('still exactly one after re-running the ensure pass', (await activeCountFor(a.timesheetId)) === 1);

  // 3. listActiveNotificationsForAdmin surfaces it with the week + link target.
  const list = await listActiveNotificationsForAdmin(admin);
  const item = list.find((n) => n.timesheetId === a.timesheetId);
  check('notification is in the admin feed', !!item, list.map((n) => n.type));
  check('  type is TIMESHEET_AWAITING_APPROVAL', item?.type === 'TIMESHEET_AWAITING_APPROVAL');
  check('  carries the period start/end for the week label', item?.periodStartDate === a.start && !!item?.periodEndDate, item);
  check('  first submission -> timesheetIsRevision false', item?.timesheetIsRevision === false, item?.timesheetIsRevision);
  check('  severity WARNING', item?.severity === 'WARNING');
  check('  eventAt is the submission time (a valid recent timestamp)', !!item?.eventAt && !Number.isNaN(Date.parse(item!.eventAt)) && Date.now() - Date.parse(item!.eventAt) < 5 * 60 * 1000, item?.eventAt);

  // 4. Approving (status change away from SUBMITTED/FOREMAN_APPROVED) resolves it.
  await prisma.timesheet.update({ where: { id: a.timesheetId }, data: { status: 'FINAL_APPROVED' } });
  await ensureTimesheetApprovalNotifications();
  check('notification resolved once the timesheet is FINAL_APPROVED', (await activeCountFor(a.timesheetId)) === 0);

  // 5. Returning it to SUBMITTED starts a fresh notification cycle.
  await prisma.timesheet.update({ where: { id: a.timesheetId }, data: { status: 'SUBMITTED' } });
  await ensureTimesheetApprovalNotifications();
  check('a fresh notification appears when the timesheet is back to SUBMITTED', (await activeCountFor(a.timesheetId)) === 1);

  // 6. Closing the period resolves it (period no longer OPEN).
  await prisma.payrollPeriod.update({ where: { id: a.periodId }, data: { status: 'LOCKED', lockedAt: new Date(), lockedByUserId: admin } });
  await ensureTimesheetApprovalNotifications();
  check('notification resolved once the period is no longer OPEN', (await activeCountFor(a.timesheetId)) === 0);

  // 7. getReviewQueueWeeks groups per open period.
  await prisma.payrollPeriod.update({ where: { id: a.periodId }, data: { status: 'OPEN', lockedAt: null, lockedByUserId: null } });
  const b = await makeSubmittedTimesheet(admin, 1);
  const c = await makeSubmittedTimesheet(admin, 1); // NOT same period — makeSubmittedTimesheet makes its own period each call
  const weeks = await getReviewQueueWeeks();
  const newWeeks = weeks.filter((w) => !baselineWeeks.some((bw) => bw.periodId === w.periodId));
  check('getReviewQueueWeeks returns a row per open period with pending timesheets', newWeeks.length >= 2, newWeeks);
  check('  each row has a count >= 1 and a start/end', newWeeks.every((w) => w.count >= 1 && w.startDate && w.endDate), newWeeks);
  const total = weeks.reduce((s, w) => s + w.count, 0);
  check('  week counts sum to the flat getReviewQueueCount()', total === (await getReviewQueueCount()), { total });
  void b;
  void c;
  void baselineTsIds;

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
