// T12 §1b (2026-08-28) — an admin fixes a still-in-review timesheet's hours in ONE click, NO
// reason, and the worker gets NO "Часы исправил администратор" notice. Reuses the correction
// machinery: requestCorrection({ directEdit: true }) -> the frozen version is source=ADMIN_EDIT
// with note=null, audited as TIMESHEET_ADMIN_EDIT. A directEdit is refused against FINAL_APPROVED.
// Regression: a normal correction still freezes source=CORRECTION + shows the worker notice.
//
// Needs a disposable PostgreSQL 16 with all migrations applied (DATABASE_URL).
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { submitWorkerTimesheetCore, getWorkerTimesheetSummary } from '../lib/worker-timesheets';
import { requestCorrection, openCorrectionDraft, patchCorrectionDraftDay, submitCorrection, applyInReviewCorrection } from '../lib/corrections';
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

async function makeUser(roleName: string, suffix: string): Promise<string> {
  const role = await prisma.role.findFirstOrThrow({ where: { name: roleName } });
  const user = await prisma.user.create({
    data: { username: `ade_${suffix}_${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } }
  });
  return user.id;
}

/** A worker with one SUBMITTED timesheet: a single WORK day 07:00-17:30. */
async function makeSubmittedTimesheet(adminId: string, tag: string) {
  const site = await prisma.workSite.create({ data: { name: `ADE ${tag} ${randomUUID().slice(0, 4)}` } });
  const emp = await prisma.employee.create({ data: { employeeNumber: `ADE-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: ASG_START } });
  const asg = await prisma.siteAssignment.create({ data: { employeeId: emp.id, siteId: site.id, isPrimary: true, validFrom: ASG_START, validTo: null, assignedByUserId: adminId } });

  const dayBase = new Date(Date.UTC(2021, 5, 7) + Math.floor(Math.random() * 500) * 7 * 86400000);
  const period = await prisma.payrollPeriod.create({ data: { startDate: dayBase, endDate: new Date(dayBase.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminId } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'DRAFT' } });
  const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId: emp.id } });

  await prisma.timesheetDraftPlannedShift.create({
    data: {
      draftId: draft.id,
      employeeId: emp.id,
      date: dayBase,
      siteId: site.id,
      sourceAssignmentId: asg.id,
      plannedStartAt: new Date(dayBase.getTime() + 7 * 3600000),
      plannedEndAt: new Date(dayBase.getTime() + 17.5 * 3600000),
      plannedBreakMinutes: 30
    }
  });
  const draftDay = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: dayBase, dayType: 'WORK', confirmedZero: false } });
  await prisma.timesheetDraftSegment.create({
    data: {
      draftDayId: draftDay.id,
      draftId: draft.id,
      employeeId: emp.id,
      date: dayBase,
      startAt: new Date(dayBase.getTime() + 7 * 3600000),
      endAt: new Date(dayBase.getTime() + 17.5 * 3600000),
      siteId: site.id,
      sourceAssignmentId: asg.id
    }
  });

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${emp.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${ts.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE id = ${draft.id}::uuid FOR UPDATE`;
    await submitWorkerTimesheetCore(tx, emp.id, ts.id, adminId, randomUUID(), SubmissionSource.MANUAL);
  });

  return { timesheetId: ts.id, employeeId: emp.id, siteId: site.id, assignmentId: asg.id, date: dayBase.toISOString().slice(0, 10) };
}

function at(date: string, hour: number, minute = 0): Date {
  return new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);
}
function atIso(date: string, hour: number, minute = 0): string {
  return at(date, hour, minute).toISOString();
}

async function main() {
  const admin = await makeUser('ADMIN', 'admin');

  // ============ 1. Direct edit: one click, no reason, no worker notice ============
  {
    const t = await makeSubmittedTimesheet(admin, 'H');

    const req = await requestCorrection(t.timesheetId, admin, '', randomUUID(), { directEdit: true });
    check('requestCorrection({ directEdit: true }) ok on SUBMITTED', !('code' in req), req);
    const reqId = (req as { id: string }).id;

    const crRow = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: reqId }, select: { directEdit: true, reason: true } });
    check('CorrectionRequest.directEdit = true', crRow.directEdit === true, crRow);
    check('CorrectionRequest.reason stored empty', crRow.reason === '', JSON.stringify(crRow.reason));

    const startedAudit = await prisma.auditEvent.findFirst({ where: { entityType: 'CORRECTION_REQUEST', entityId: reqId, eventType: 'TIMESHEET_ADMIN_EDIT_STARTED' }, select: { id: true } });
    check('audit TIMESHEET_ADMIN_EDIT_STARTED written', !!startedAudit);

    await openCorrectionDraft(reqId, admin, randomUUID());
    // 17:30 -> 15:00
    const patched = await patchCorrectionDraftDay(reqId, new Date(`${t.date}T00:00:00.000Z`), {
      dayType: 'WORK',
      confirmedZero: false,
      segments: [{ startAt: at(t.date, 7), endAt: at(t.date, 15), siteId: t.siteId, workAreaId: null, breaks: [] }]
    });
    check('patchCorrectionDraftDay ok', !('code' in patched), patched);

    const submitted = await submitCorrection(reqId, randomUUID());
    check('submitCorrection ok', !('code' in submitted), submitted);

    const applied = await applyInReviewCorrection(reqId, admin, randomUUID());
    check('applyInReviewCorrection ok', !('code' in applied), applied);

    const after = await prisma.timesheet.findUniqueOrThrow({
      where: { id: t.timesheetId },
      select: { status: true, currentVersionId: true, currentVersion: { select: { source: true, note: true, createdByUserId: true, versionNumber: true } } }
    });
    check('timesheet back to SUBMITTED', after.status === 'SUBMITTED', after.status);
    check('new version is source=ADMIN_EDIT', after.currentVersion?.source === 'ADMIN_EDIT', after.currentVersion?.source);
    check('new version note is null (no reason)', after.currentVersion?.note === null, after.currentVersion?.note);
    check('new version authored by the admin', after.currentVersion?.createdByUserId === admin);
    check('version number incremented', (after.currentVersion?.versionNumber ?? 0) >= 2, after.currentVersion?.versionNumber);

    const seg = await prisma.workSegment.findFirstOrThrow({ where: { timesheetVersionId: after.currentVersionId! }, select: { endAt: true } });
    check('edited hours frozen (end 15:00)', seg.endAt.toISOString() === atIso(t.date, 15), seg.endAt.toISOString());

    const summary = await getWorkerTimesheetSummary(t.employeeId, t.timesheetId);
    check('worker summary shows NO adminCorrection notice', !('code' in summary) && summary.adminCorrection === null, 'code' in summary ? summary : summary.adminCorrection);

    const audit = await prisma.auditEvent.findFirst({ where: { entityType: 'CORRECTION_REQUEST', entityId: reqId, eventType: 'TIMESHEET_ADMIN_EDIT' }, select: { actorUserId: true, beforeValue: true, afterValue: true } });
    check('audit TIMESHEET_ADMIN_EDIT written for the admin', audit?.actorUserId === admin, audit);
    check('audit carries before/after', !!audit?.beforeValue && !!audit?.afterValue);

    const noApprovedEvent = await prisma.auditEvent.findFirst({ where: { entityType: 'CORRECTION_REQUEST', entityId: reqId, eventType: 'CORRECTION_APPROVED' }, select: { id: true } });
    check('a directEdit does NOT emit CORRECTION_APPROVED', noApprovedEvent === null);
  }

  // ============ 2. directEdit refused against FINAL_APPROVED ============
  {
    const t = await makeSubmittedTimesheet(admin, 'F');
    const v = (await prisma.timesheet.findUniqueOrThrow({ where: { id: t.timesheetId }, select: { currentVersionId: true } })).currentVersionId!;
    await prisma.timesheetReviewScope.updateMany({ where: { timesheetVersionId: v }, data: { status: 'APPROVED' } });
    await prisma.timesheet.update({ where: { id: t.timesheetId }, data: { status: 'FINAL_APPROVED' } });

    const req = await requestCorrection(t.timesheetId, admin, '', randomUUID(), { directEdit: true });
    check('requestCorrection({ directEdit: true }) refuses FINAL_APPROVED', 'code' in req && req.code === 'INVALID_STATE_TRANSITION', req);
  }

  // ============ 3. Regression: a normal correction still shows the worker notice ============
  {
    const t = await makeSubmittedTimesheet(admin, 'R');
    const req = await requestCorrection(t.timesheetId, admin, 'Worker mistyped the end time', randomUUID());
    const reqId = (req as { id: string }).id;
    const crRow = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: reqId }, select: { directEdit: true } });
    check('a normal correction has directEdit = false', crRow.directEdit === false);

    await openCorrectionDraft(reqId, admin, randomUUID());
    await patchCorrectionDraftDay(reqId, new Date(`${t.date}T00:00:00.000Z`), {
      dayType: 'WORK',
      confirmedZero: false,
      segments: [{ startAt: at(t.date, 7), endAt: at(t.date, 16), siteId: t.siteId, workAreaId: null, breaks: [] }]
    });
    await submitCorrection(reqId, randomUUID());
    await applyInReviewCorrection(reqId, admin, randomUUID());

    const after = await prisma.timesheet.findUniqueOrThrow({ where: { id: t.timesheetId }, select: { currentVersion: { select: { source: true, note: true } } } });
    check('normal correction freezes source=CORRECTION', after.currentVersion?.source === 'CORRECTION', after.currentVersion?.source);
    check('normal correction carries the reason as note', after.currentVersion?.note === 'Worker mistyped the end time');

    const summary = await getWorkerTimesheetSummary(t.employeeId, t.timesheetId);
    check('normal correction DOES surface adminCorrection', !('code' in summary) && summary.adminCorrection?.reason === 'Worker mistyped the end time', 'code' in summary ? summary : summary.adminCorrection);
  }

  // ============ 4. T12 — a stale open edit is re-seeded from the current version on re-open ============
  {
    const t = await makeSubmittedTimesheet(admin, 'S');
    const v1 = (await prisma.timesheet.findUniqueOrThrow({ where: { id: t.timesheetId }, select: { currentVersionId: true } })).currentVersionId!;

    const req = await requestCorrection(t.timesheetId, admin, '', randomUUID(), { directEdit: true });
    const reqId = (req as { id: string }).id;
    await openCorrectionDraft(reqId, admin, randomUUID());
    const draft1 = await prisma.correctionDraft.findFirstOrThrow({ where: { correctionRequestId: reqId }, select: { id: true, basedOnVersionId: true } });
    check('draft opened against v1', draft1.basedOnVersionId === v1);

    // Simulate the timesheet advancing to a new version while this edit sat open (worker was
    // returned it and resubmitted): freeze a second version whose single day has different hours.
    await prisma.timesheetReviewScope.updateMany({ where: { timesheetVersionId: v1 }, data: { status: 'RETURNED' } });
    await prisma.timesheet.update({ where: { id: t.timesheetId }, data: { status: 'RETURNED' } });
    const draft = await prisma.timesheetDraft.findFirstOrThrow({ where: { timesheetId: t.timesheetId }, select: { id: true } });
    await prisma.timesheetDraftDay.deleteMany({ where: { draftId: draft.id } });
    await prisma.timesheetDraftPlannedShift.deleteMany({ where: { draftId: draft.id } });
    const dayBase = new Date(`${t.date}T00:00:00.000Z`);
    await prisma.timesheetDraftPlannedShift.create({
      data: { draftId: draft.id, employeeId: t.employeeId, date: dayBase, siteId: t.siteId, sourceAssignmentId: t.assignmentId, plannedStartAt: at(t.date, 7), plannedEndAt: at(t.date, 12), plannedBreakMinutes: 0 }
    });
    const dd = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: dayBase, dayType: 'WORK', confirmedZero: false } });
    await prisma.timesheetDraftSegment.create({ data: { draftDayId: dd.id, draftId: draft.id, employeeId: t.employeeId, date: dayBase, startAt: at(t.date, 7), endAt: at(t.date, 12), siteId: t.siteId, sourceAssignmentId: t.assignmentId } });
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${t.employeeId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${t.timesheetId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE id = ${draft.id}::uuid FOR UPDATE`;
      await submitWorkerTimesheetCore(tx, t.employeeId, t.timesheetId, admin, randomUUID(), SubmissionSource.MANUAL);
    });
    const v2 = (await prisma.timesheet.findUniqueOrThrow({ where: { id: t.timesheetId }, select: { currentVersionId: true } })).currentVersionId!;
    check('timesheet advanced to a new version', v2 !== v1);

    // Re-open the stale edit — it must re-seed from v2.
    await openCorrectionDraft(reqId, admin, randomUUID());
    const draft2 = await prisma.correctionDraft.findFirstOrThrow({ where: { correctionRequestId: reqId }, select: { id: true, basedOnVersionId: true } });
    check('re-open re-points the draft at v2', draft2.basedOnVersionId === v2, draft2.basedOnVersionId);
    const seg = await prisma.correctionDraftSegment.findFirstOrThrow({ where: { draftId: draft2.id }, select: { endAt: true } });
    check('re-seeded draft has v2 hours (end 12:00, not v1 15:00)', seg.endAt.toISOString() === atIso(t.date, 12), seg.endAt.toISOString());
    const reseedAudit = await prisma.auditEvent.findFirst({ where: { entityType: 'CORRECTION_REQUEST', entityId: reqId, eventType: 'CORRECTION_DRAFT_RESEEDED' }, select: { id: true } });
    check('a CORRECTION_DRAFT_RESEEDED audit event was written', !!reseedAudit);
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
