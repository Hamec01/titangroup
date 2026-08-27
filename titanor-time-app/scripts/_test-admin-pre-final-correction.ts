// Task A (2026-08-27) — direct lib-level test for applyInReviewCorrection: an ADMIN edits a
// worker's SUBMITTED / FOREMAN_APPROVED timesheet in place, producing a CORRECTION version
// authored by the admin, sending the timesheet back to SUBMITTED with every review scope PENDING,
// and surfacing "Часы исправил администратор" to the worker. Also covers: requestCorrection now
// accepts pre-final statuses; decideCorrection still refuses a pre-final correction; discard
// marks it REJECTED without freezing anything; a no-op edit is rejected.
//
// Needs a disposable PostgreSQL 16 with all migrations applied (DATABASE_URL).
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { submitWorkerTimesheetCore, getWorkerTimesheetSummary } from '../lib/worker-timesheets';
import { requestCorrection, openCorrectionDraft, patchCorrectionDraftDay, submitCorrection, applyInReviewCorrection, discardInReviewCorrection, decideCorrection } from '../lib/corrections';
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
    data: { username: `aprc_${suffix}_${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } }
  });
  return user.id;
}

/** A worker with one SUBMITTED timesheet: a single WORK day 07:00-17:30 (no recorded break). */
async function makeSubmittedTimesheet(adminId: string, tag: string) {
  const site = await prisma.workSite.create({ data: { name: `APRC ${tag} ${randomUUID().slice(0, 4)}` } });
  const emp = await prisma.employee.create({ data: { employeeNumber: `APRC-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
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
  const admin2 = await makeUser('ADMIN', 'admin2');

  // ============ 1. Happy path: admin edits a SUBMITTED timesheet ============
  {
    const t = await makeSubmittedTimesheet(admin, 'H');

    const beforeVersion = await prisma.timesheet.findUniqueOrThrow({ where: { id: t.timesheetId }, select: { currentVersionId: true, status: true } });
    check('fixture timesheet is SUBMITTED', beforeVersion.status === 'SUBMITTED');
    const beforeScopes = await prisma.timesheetReviewScope.findMany({ where: { timesheetVersionId: beforeVersion.currentVersionId! }, select: { status: true } });
    // manually approve all scopes -> FOREMAN_APPROVED, to prove an edit resets them
    await prisma.timesheetReviewScope.updateMany({ where: { timesheetVersionId: beforeVersion.currentVersionId! }, data: { status: 'APPROVED' } });
    await prisma.timesheet.update({ where: { id: t.timesheetId }, data: { status: 'FOREMAN_APPROVED' } });
    check('fixture created review scopes', beforeScopes.length > 0);

    const req = await requestCorrection(t.timesheetId, admin, 'Worker entered the wrong end time', randomUUID());
    check('requestCorrection accepts a FOREMAN_APPROVED timesheet', !('code' in req), req);
    const reqId = (req as { id: string }).id;

    const opened = await openCorrectionDraft(reqId, admin, randomUUID());
    check('openCorrectionDraft ok', !('code' in opened), opened);

    // change end time 17:30 -> 16:00
    const patched = await patchCorrectionDraftDay(reqId, new Date(`${t.date}T00:00:00.000Z`), {
      dayType: 'WORK',
      confirmedZero: false,
      segments: [{ startAt: at(t.date, 7), endAt: at(t.date, 16), siteId: t.siteId, workAreaId: null, breaks: [] }]
    });
    check('patchCorrectionDraftDay ok', !('code' in patched), patched);

    const submitted = await submitCorrection(reqId, randomUUID());
    check('submitCorrection ok (real change)', !('code' in submitted), submitted);

    const applied = await applyInReviewCorrection(reqId, admin, randomUUID());
    check('applyInReviewCorrection ok', !('code' in applied), applied);

    const after = await prisma.timesheet.findUniqueOrThrow({
      where: { id: t.timesheetId },
      select: { status: true, currentVersionId: true, currentVersion: { select: { source: true, createdByUserId: true, note: true, versionNumber: true } } }
    });
    check('timesheet back to SUBMITTED (обратно в очередь)', after.status === 'SUBMITTED', after.status);
    check('new current version is source=CORRECTION', after.currentVersion?.source === 'CORRECTION', after.currentVersion?.source);
    check('new version authored by the admin', after.currentVersion?.createdByUserId === admin);
    check('new version carries the reason as note', after.currentVersion?.note === 'Worker entered the wrong end time');
    check('version number incremented', (after.currentVersion?.versionNumber ?? 0) >= 2, after.currentVersion?.versionNumber);

    const afterScopes = await prisma.timesheetReviewScope.findMany({ where: { timesheetVersionId: after.currentVersionId! }, select: { status: true } });
    check('every review scope reset to PENDING', afterScopes.length > 0 && afterScopes.every((s) => s.status === 'PENDING'), afterScopes);

    const seg = await prisma.workSegment.findFirstOrThrow({ where: { timesheetVersionId: after.currentVersionId! }, select: { startAt: true, endAt: true } });
    check('edited hours are frozen (end 16:00)', seg.endAt.toISOString() === atIso(t.date, 16), seg.endAt.toISOString());

    const cr = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: reqId }, select: { status: true, decidedByUserId: true, resultingVersionId: true } });
    check('CorrectionRequest APPROVED + decidedBy admin + resultingVersion set', cr.status === 'APPROVED' && cr.decidedByUserId === admin && cr.resultingVersionId === after.currentVersionId);

    const summary = await getWorkerTimesheetSummary(t.employeeId, t.timesheetId);
    check('worker summary surfaces adminCorrection', !('code' in summary) && summary.adminCorrection?.reason === 'Worker entered the wrong end time', 'code' in summary ? summary : summary.adminCorrection);

    // audit: a CORRECTION_APPROVED event exists for this request, by the admin
    const audit = await prisma.auditEvent.findFirst({ where: { entityType: 'CORRECTION_REQUEST', entityId: reqId, eventType: 'CORRECTION_APPROVED' }, select: { actorUserId: true } });
    check('audit CORRECTION_APPROVED written for the admin', audit?.actorUserId === admin);
  }

  // ============ 2. No-op edit is rejected ============
  {
    const t = await makeSubmittedTimesheet(admin, 'N');
    const req = await requestCorrection(t.timesheetId, admin, 'checking', randomUUID());
    const reqId = (req as { id: string }).id;
    await openCorrectionDraft(reqId, admin, randomUUID());
    const submitted = await submitCorrection(reqId, randomUUID());
    check('submitCorrection rejects a no-op edit', 'code' in submitted && submitted.code === 'NO_CORRECTION_CHANGES', submitted);
  }

  // ============ 3. Discard marks REJECTED, freezes nothing ============
  {
    const t = await makeSubmittedTimesheet(admin, 'D');
    const beforeVersionId = (await prisma.timesheet.findUniqueOrThrow({ where: { id: t.timesheetId }, select: { currentVersionId: true } })).currentVersionId;
    const req = await requestCorrection(t.timesheetId, admin, 'never mind', randomUUID());
    const reqId = (req as { id: string }).id;
    await openCorrectionDraft(reqId, admin, randomUUID());
    const discarded = await discardInReviewCorrection(reqId, admin, randomUUID());
    check('discardInReviewCorrection ok', !('code' in discarded), discarded);
    const cr = await prisma.correctionRequest.findUniqueOrThrow({ where: { id: reqId }, select: { status: true } });
    check('correction is REJECTED after discard', cr.status === 'REJECTED');
    const after = await prisma.timesheet.findUniqueOrThrow({ where: { id: t.timesheetId }, select: { status: true, currentVersionId: true } });
    check('timesheet untouched by discard (still SUBMITTED, same version)', after.status === 'SUBMITTED' && after.currentVersionId === beforeVersionId);
    // a fresh correction can be opened again
    const req2 = await requestCorrection(t.timesheetId, admin, 'second try', randomUUID());
    check('a new correction can be opened after a discard', !('code' in req2), req2);
  }

  // ============ 4. decideCorrection still refuses a pre-final correction ============
  {
    const t = await makeSubmittedTimesheet(admin, 'F');
    const req = await requestCorrection(t.timesheetId, admin, 'wrong path', randomUUID());
    const reqId = (req as { id: string }).id;
    await openCorrectionDraft(reqId, admin, randomUUID());
    await patchCorrectionDraftDay(reqId, new Date(`${t.date}T00:00:00.000Z`), {
      dayType: 'WORK',
      confirmedZero: false,
      segments: [{ startAt: at(t.date, 7), endAt: at(t.date, 15), siteId: t.siteId, workAreaId: null, breaks: [] }]
    });
    await submitCorrection(reqId, randomUUID());
    const decided = await decideCorrection(reqId, 'APPROVED', admin2, false, null, randomUUID());
    check('decideCorrection refuses a SUBMITTED-timesheet correction (INVALID_STATE_TRANSITION)', 'code' in decided && decided.code === 'INVALID_STATE_TRANSITION', decided);
  }

  // ============ 5. Regression: the classic FINAL_APPROVED correction path still works ============
  {
    const t = await makeSubmittedTimesheet(admin, 'R');
    // drive it to FINAL_APPROVED
    const v = (await prisma.timesheet.findUniqueOrThrow({ where: { id: t.timesheetId }, select: { currentVersionId: true } })).currentVersionId!;
    await prisma.timesheetReviewScope.updateMany({ where: { timesheetVersionId: v }, data: { status: 'APPROVED' } });
    await prisma.timesheet.update({ where: { id: t.timesheetId }, data: { status: 'FINAL_APPROVED' } });

    const req = await requestCorrection(t.timesheetId, admin, 'post-final fix', randomUUID());
    check('requestCorrection still accepts FINAL_APPROVED', !('code' in req), req);
    const reqId = (req as { id: string }).id;
    await openCorrectionDraft(reqId, admin, randomUUID());
    await patchCorrectionDraftDay(reqId, new Date(`${t.date}T00:00:00.000Z`), {
      dayType: 'WORK',
      confirmedZero: false,
      segments: [{ startAt: at(t.date, 7), endAt: at(t.date, 14), siteId: t.siteId, workAreaId: null, breaks: [] }]
    });
    await submitCorrection(reqId, randomUUID());
    const decided = await decideCorrection(reqId, 'APPROVED', admin2, false, null, randomUUID());
    check('decideCorrection APPROVED works for FINAL_APPROVED (four-eyes: admin2)', !('code' in decided), decided);
    const after = await prisma.timesheet.findUniqueOrThrow({
      where: { id: t.timesheetId },
      select: { status: true, currentVersion: { select: { source: true } } }
    });
    check('post-final correction keeps status FINAL_APPROVED', after.status === 'FINAL_APPROVED', after.status);
    check('post-final correction produced a CORRECTION version', after.currentVersion?.source === 'CORRECTION');
    // four-eyes still enforced
    const t2 = await makeSubmittedTimesheet(admin, 'R2');
    const v2 = (await prisma.timesheet.findUniqueOrThrow({ where: { id: t2.timesheetId }, select: { currentVersionId: true } })).currentVersionId!;
    await prisma.timesheetReviewScope.updateMany({ where: { timesheetVersionId: v2 }, data: { status: 'APPROVED' } });
    await prisma.timesheet.update({ where: { id: t2.timesheetId }, data: { status: 'FINAL_APPROVED' } });
    const req2 = await requestCorrection(t2.timesheetId, admin, 'x', randomUUID());
    const req2Id = (req2 as { id: string }).id;
    await openCorrectionDraft(req2Id, admin, randomUUID());
    await patchCorrectionDraftDay(req2Id, new Date(`${t2.date}T00:00:00.000Z`), {
      dayType: 'WORK',
      confirmedZero: false,
      segments: [{ startAt: at(t2.date, 7), endAt: at(t2.date, 13), siteId: t2.siteId, workAreaId: null, breaks: [] }]
    });
    await submitCorrection(req2Id, randomUUID());
    const selfDecide = await decideCorrection(req2Id, 'APPROVED', admin, false, null, randomUUID());
    check('four-eyes still enforced on post-final (same admin -> SELF_APPROVAL_FORBIDDEN)', 'code' in selfDecide && selfDecide.code === 'SELF_APPROVAL_FORBIDDEN', selfDecide);
  }

  console.log(JSON.stringify({ pass, fail }));
  process.exit(fail > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
