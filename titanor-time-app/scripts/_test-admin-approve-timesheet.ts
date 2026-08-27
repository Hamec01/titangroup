// Task B (2026-08-27) — direct lib-level test for the one-click admin approve + the /admin/review
// queue. Needs a disposable PostgreSQL 16 with all migrations applied (DATABASE_URL).
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { submitWorkerTimesheetCore } from '../lib/worker-timesheets';
import { adminApproveTimesheet, getReviewQueue, getReviewQueueCount, finalApproveTimesheet, returnTimesheetOverride } from '../lib/admin-timesheets';
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

async function makeUser(roleName: string, suffix: string, employeeId?: string): Promise<string> {
  const role = await prisma.role.findFirstOrThrow({ where: { name: roleName } });
  const user = await prisma.user.create({
    data: { username: `bappr_${suffix}_${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', employeeId, userRoles: { create: { roleId: role.id } } }
  });
  return user.id;
}

async function makeSubmittedTimesheet(adminId: string, tag: string, opts: { periodOpen?: boolean } = {}) {
  const site = await prisma.workSite.create({ data: { name: `BAPPR ${tag} ${randomUUID().slice(0, 4)}` } });
  const emp = await prisma.employee.create({ data: { employeeNumber: `BAPPR-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: ASG_START } });
  const asg = await prisma.siteAssignment.create({ data: { employeeId: emp.id, siteId: site.id, isPrimary: true, validFrom: ASG_START, validTo: null, assignedByUserId: adminId } });

  const day = new Date(Date.UTC(2021, 6, 5) + Math.floor(Math.random() * 800) * 7 * 86400000);
  const period = await prisma.payrollPeriod.create({
    data:
      opts.periodOpen === false
        ? { startDate: day, endDate: new Date(day.getTime() + 6 * 86400000), status: 'LOCKED', openedByUserId: adminId, lockedByUserId: adminId, lockedAt: new Date() }
        : { startDate: day, endDate: new Date(day.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminId }
  });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'DRAFT' } });
  const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId: emp.id } });
  await prisma.timesheetDraftPlannedShift.create({
    data: {
      draftId: draft.id,
      employeeId: emp.id,
      date: day,
      siteId: site.id,
      sourceAssignmentId: asg.id,
      plannedStartAt: new Date(day.getTime() + 7 * 3600000),
      plannedEndAt: new Date(day.getTime() + 15.5 * 3600000),
      plannedBreakMinutes: 30
    }
  });
  const dd = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: day, dayType: 'WORK', confirmedZero: false } });
  await prisma.timesheetDraftSegment.create({
    data: { draftDayId: dd.id, draftId: draft.id, employeeId: emp.id, date: day, startAt: new Date(day.getTime() + 7 * 3600000), endAt: new Date(day.getTime() + 15.5 * 3600000), siteId: site.id, sourceAssignmentId: asg.id }
  });
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${emp.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${ts.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE id = ${draft.id}::uuid FOR UPDATE`;
    await submitWorkerTimesheetCore(tx, emp.id, ts.id, adminId, randomUUID(), SubmissionSource.MANUAL);
  });
  return { timesheetId: ts.id, employeeId: emp.id, siteId: site.id, periodId: period.id, adminId };
}

async function main() {
  const admin = await makeUser('ADMIN', 'a');

  // ---- 1. SUBMITTED, no foreman -> one click -> FINAL_APPROVED ----
  {
    const t = await makeSubmittedTimesheet(admin, 'A');
    const vid = (await prisma.timesheet.findUniqueOrThrow({ where: { id: t.timesheetId }, select: { currentVersionId: true } })).currentVersionId!;
    const r = await adminApproveTimesheet(t.timesheetId, admin, null, randomUUID());
    check('adminApproveTimesheet SUBMITTED -> ok', !('code' in r), r);
    const after = await prisma.timesheet.findUniqueOrThrow({ where: { id: t.timesheetId }, select: { status: true } });
    check('timesheet -> FINAL_APPROVED', after.status === 'FINAL_APPROVED', after.status);
    const scopes = await prisma.timesheetReviewScope.findMany({ where: { timesheetVersionId: vid }, select: { status: true, reviewedByUserId: true } });
    check('all scopes APPROVED by the admin', scopes.length > 0 && scopes.every((s) => s.status === 'APPROVED' && s.reviewedByUserId === admin), scopes);
    const audits = await prisma.auditEvent.findMany({ where: { entityId: t.timesheetId, entityType: 'TIMESHEET', eventType: { in: ['FOREMAN_APPROVED', 'FINAL_APPROVED'] } }, select: { eventType: true } });
    check('audit chain has both FOREMAN_APPROVED and FINAL_APPROVED', audits.some((a) => a.eventType === 'FOREMAN_APPROVED') && audits.some((a) => a.eventType === 'FINAL_APPROVED'), audits);
  }

  // ---- 2. SUBMITTED with a foreman on the site -> FOREMAN_REVIEW_PENDING ----
  {
    const t = await makeSubmittedTimesheet(admin, 'F');
    const foremanUser = await makeUser('FOREMAN', 'f');
    await prisma.foremanAssignment.create({ data: { foremanUserId: foremanUser, siteId: t.siteId, validFrom: ASG_START, validTo: null, assignedByUserId: admin } });
    const r = await adminApproveTimesheet(t.timesheetId, admin, null, randomUUID());
    check('adminApproveTimesheet refuses when a foreman covers the site', 'code' in r && r.code === 'FOREMAN_REVIEW_PENDING', r);
    const after = await prisma.timesheet.findUniqueOrThrow({ where: { id: t.timesheetId }, select: { status: true } });
    check('timesheet untouched after FOREMAN_REVIEW_PENDING', after.status === 'SUBMITTED', after.status);
  }

  // ---- 3. FOREMAN_APPROVED -> FINAL_APPROVED ----
  {
    const t = await makeSubmittedTimesheet(admin, 'FA');
    const vid = (await prisma.timesheet.findUniqueOrThrow({ where: { id: t.timesheetId }, select: { currentVersionId: true } })).currentVersionId!;
    await prisma.timesheetReviewScope.updateMany({ where: { timesheetVersionId: vid }, data: { status: 'APPROVED' } });
    await prisma.timesheet.update({ where: { id: t.timesheetId }, data: { status: 'FOREMAN_APPROVED' } });
    const r = await adminApproveTimesheet(t.timesheetId, admin, null, randomUUID());
    check('adminApproveTimesheet FOREMAN_APPROVED -> ok', !('code' in r), r);
    check('-> FINAL_APPROVED', (await prisma.timesheet.findUniqueOrThrow({ where: { id: t.timesheetId }, select: { status: true } })).status === 'FINAL_APPROVED');
  }

  // ---- 4. self-approval forbidden ----
  {
    const t = await makeSubmittedTimesheet(admin, 'S');
    // an admin whose own employeeId is the worker
    const selfAdmin = await makeUser('ADMIN', 's', t.employeeId);
    const r = await adminApproveTimesheet(t.timesheetId, selfAdmin, t.employeeId, randomUUID());
    check('self-approval forbidden', 'code' in r && r.code === 'SELF_APPROVAL_FORBIDDEN', r);
  }

  // ---- 5. getReviewQueue ----
  {
    const openTs = await makeSubmittedTimesheet(admin, 'Q1');
    const closedTs = await makeSubmittedTimesheet(admin, 'Q2', { periodOpen: false });
    // a not-submitted (DRAFT) in an open period
    const draftEmp = await prisma.employee.create({ data: { employeeNumber: `BAPPR-Q3-${randomUUID().slice(0, 8)}`, firstName: 'Q3', lastName: 'Worker' } });
    await prisma.employment.create({ data: { employeeId: draftEmp.id, active: true, startDate: ASG_START } });
    const openPeriodId = openTs.periodId;
    await prisma.payrollPeriodParticipant.create({ data: { periodId: openPeriodId, employeeId: draftEmp.id, expected: true } });
    const draftTs = await prisma.timesheet.create({ data: { employeeId: draftEmp.id, periodId: openPeriodId, status: 'DRAFT' } });
    await prisma.timesheetDraft.create({ data: { timesheetId: draftTs.id, employeeId: draftEmp.id } });

    const queue = await getReviewQueue({});
    const ids = queue.rows.map((r) => r.timesheetId);
    check('getReviewQueue includes an open-period SUBMITTED', ids.includes(openTs.timesheetId), ids);
    check('getReviewQueue excludes a LOCKED-period timesheet', !ids.includes(closedTs.timesheetId), ids);
    check('getReviewQueue.notSubmitted includes the DRAFT', queue.notSubmitted.some((r) => r.timesheetId === draftTs.id));
    const row = queue.rows.find((r) => r.timesheetId === openTs.timesheetId)!;
    check('row has worked hours > 0', row.workedMinutes > 0, row.workedMinutes);
    check('row has a site name', row.siteNames.length === 1);
    check('row hasForeman=false (no foreman on this fixture site)', row.hasForeman === false);

    const filtered = await getReviewQueue({ siteId: openTs.siteId });
    check('site filter keeps the matching row', filtered.rows.some((r) => r.timesheetId === openTs.timesheetId));
    check('site filter drops other sites', filtered.rows.every((r) => r.siteNames.includes(filtered.siteOptions.find((s) => s.id === openTs.siteId)?.name ?? '__none__')));

    const cnt = await getReviewQueueCount();
    check('getReviewQueueCount matches the row count', cnt === (await prisma.timesheet.count({ where: { status: { in: ['SUBMITTED', 'FOREMAN_APPROVED'] }, period: { status: 'OPEN' } } })), cnt);
  }

  // ---- 6. returnTimesheetOverride now also works for SUBMITTED ----
  {
    const t = await makeSubmittedTimesheet(admin, 'R');
    const vid = (await prisma.timesheet.findUniqueOrThrow({ where: { id: t.timesheetId }, select: { currentVersionId: true } })).currentVersionId!;
    const r = await returnTimesheetOverride(t.timesheetId, admin, 'redo it', randomUUID());
    check('returnTimesheetOverride SUBMITTED -> ok', !('code' in r), r);
    check('timesheet -> RETURNED', (await prisma.timesheet.findUniqueOrThrow({ where: { id: t.timesheetId }, select: { status: true } })).status === 'RETURNED');
    const scopes = await prisma.timesheetReviewScope.findMany({ where: { timesheetVersionId: vid }, select: { status: true } });
    check('all scopes RETURNED', scopes.every((s) => s.status === 'RETURNED'), scopes);
  }

  // ---- 7. regression: finalApproveTimesheet is still FOREMAN_APPROVED-only ----
  {
    const t = await makeSubmittedTimesheet(admin, 'RG');
    const r = await finalApproveTimesheet(t.timesheetId, admin, randomUUID());
    check('finalApproveTimesheet refuses a SUBMITTED timesheet', 'code' in r && r.code === 'INVALID_STATE_TRANSITION', r);
  }

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
