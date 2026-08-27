// Task C (2026-08-27) — direct lib-level test: admin marks a timesheet day as an absence
// (больничный / отпуск / …) straight from the review flow. patchCorrectionDraftDay with an
// actorUserId auto-records a one-day APPROVED Absence when none covers the date.
// Needs a disposable PostgreSQL 16 with all migrations (DATABASE_URL).
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { submitWorkerTimesheetCore } from '../lib/worker-timesheets';
import { requestCorrection, openCorrectionDraft, patchCorrectionDraftDay, submitCorrection, applyInReviewCorrection } from '../lib/corrections';
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

async function makeUser(role: string, suffix: string): Promise<string> {
  const r = await prisma.role.findFirstOrThrow({ where: { name: role } });
  const u = await prisma.user.create({ data: { username: `mad_${suffix}_${randomUUID().slice(0, 6)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: r.id } } } });
  return u.id;
}

async function makeSubmitted(adminId: string, tag: string) {
  const site = await prisma.workSite.create({ data: { name: `MAD ${tag} ${randomUUID().slice(0, 4)}` } });
  const emp = await prisma.employee.create({ data: { employeeNumber: `MAD-${tag}-${randomUUID().slice(0, 8)}`, firstName: tag, lastName: 'Worker' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: ASG_START } });
  const asg = await prisma.siteAssignment.create({ data: { employeeId: emp.id, siteId: site.id, isPrimary: true, validFrom: ASG_START, validTo: null, assignedByUserId: adminId } });
  const d0 = new Date(Date.UTC(2022, 8, 5) + Math.floor(Math.random() * 400) * 7 * 86400000);
  const period = await prisma.payrollPeriod.create({ data: { startDate: d0, endDate: new Date(d0.getTime() + 6 * 86400000), status: 'OPEN', openedByUserId: adminId } });
  await prisma.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId: emp.id, expected: true } });
  const ts = await prisma.timesheet.create({ data: { employeeId: emp.id, periodId: period.id, status: 'DRAFT' } });
  const draft = await prisma.timesheetDraft.create({ data: { timesheetId: ts.id, employeeId: emp.id } });
  // two working days with hours, rest empty
  for (const off of [0, 1]) {
    const day = new Date(d0.getTime() + off * 86400000);
    await prisma.timesheetDraftPlannedShift.create({
      data: { draftId: draft.id, employeeId: emp.id, date: day, siteId: site.id, sourceAssignmentId: asg.id, plannedStartAt: new Date(day.getTime() + 7 * 3600000), plannedEndAt: new Date(day.getTime() + 15.5 * 3600000), plannedBreakMinutes: 30 }
    });
    const dd = await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: day, dayType: 'WORK', confirmedZero: false } });
    await prisma.timesheetDraftSegment.create({
      data: { draftDayId: dd.id, draftId: draft.id, employeeId: emp.id, date: day, startAt: new Date(day.getTime() + 7 * 3600000), endAt: new Date(day.getTime() + 15.5 * 3600000), siteId: site.id, sourceAssignmentId: asg.id }
    });
  }
  // day 2 (index) empty — the one we mark as sick leave
  const emptyDay = new Date(d0.getTime() + 2 * 86400000);
  await prisma.timesheetDraftDay.create({ data: { draftId: draft.id, date: emptyDay, dayType: 'WORK', confirmedZero: false } });

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${emp.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${ts.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE id = ${draft.id}::uuid FOR UPDATE`;
    await submitWorkerTimesheetCore(tx, emp.id, ts.id, adminId, randomUUID(), SubmissionSource.MANUAL);
  });
  return { timesheetId: ts.id, employeeId: emp.id, siteId: site.id, emptyDate: emptyDay.toISOString().slice(0, 10), emptyDateObj: emptyDay };
}

async function main() {
  const admin = await makeUser('ADMIN', 'a');

  // 1. mark an empty day as SICK_LEAVE via the admin correction flow
  {
    const t = await makeSubmitted(admin, 'A');
    const req = await requestCorrection(t.timesheetId, admin, 'worker was sick Wednesday', randomUUID());
    const reqId = (req as { id: string }).id;
    await openCorrectionDraft(reqId, admin, randomUUID());

    const patched = await patchCorrectionDraftDay(reqId, new Date(`${t.emptyDate}T00:00:00.000Z`), { dayType: 'SICK_LEAVE', note: 'called in sick', confirmedZero: false, segments: [] }, admin);
    check('patchCorrectionDraftDay SICK_LEAVE ok (auto-absence)', !('code' in patched), patched);
    check('day is now SICK_LEAVE', !('code' in patched) && patched.dayType === 'SICK_LEAVE', patched);

    const absence = await prisma.absence.findFirst({ where: { employeeId: t.employeeId, type: 'SICK_LEAVE', status: 'APPROVED' }, select: { id: true, startDate: true, endDate: true, note: true, createdByUserId: true, approvedByUserId: true } });
    check('a 1-day APPROVED Absence was created by the admin', !!absence && absence.createdByUserId === admin && absence.approvedByUserId === admin, absence);
    check('Absence covers exactly that date', !!absence && absence.startDate.toISOString().slice(0, 10) === t.emptyDate && absence.endDate.toISOString().slice(0, 10) === t.emptyDate, absence);
    check('Absence carries the note', absence?.note === 'called in sick', absence?.note);

    const audit = await prisma.auditEvent.findFirst({ where: { entityType: 'ABSENCE', eventType: 'ABSENCE_CREATED', entityId: absence?.id }, select: { actorUserId: true } });
    check('ABSENCE_CREATED audit by the admin', audit?.actorUserId === admin, audit);

    // apply and check the frozen version
    const submitted = await submitCorrection(reqId, randomUUID());
    check('submitCorrection ok', !('code' in submitted), submitted);
    const applied = await applyInReviewCorrection(reqId, admin, randomUUID());
    check('applyInReviewCorrection ok', !('code' in applied), applied);

    const vId = (await prisma.timesheet.findUniqueOrThrow({ where: { id: t.timesheetId }, select: { currentVersionId: true } })).currentVersionId!;
    const frozenDay = await prisma.timesheetDay.findFirst({ where: { timesheetVersionId: vId, date: t.emptyDateObj }, select: { dayType: true, sourceAbsenceId: true, segments: { select: { id: true } } } });
    check('frozen day is SICK_LEAVE with sourceAbsenceId and no segments', frozenDay?.dayType === 'SICK_LEAVE' && !!frozenDay?.sourceAbsenceId && frozenDay.segments.length === 0, frozenDay);
  }

  // 2. an existing Absence is reused, not duplicated
  {
    const t = await makeSubmitted(admin, 'B');
    await prisma.absence.create({ data: { employeeId: t.employeeId, type: 'VACATION', status: 'APPROVED', startDate: new Date(`${t.emptyDate}T00:00:00.000Z`), endDate: new Date(`${t.emptyDate}T00:00:00.000Z`), createdByUserId: admin, approvedByUserId: admin, approvedAt: new Date(), overlayAppliedDates: [], overlayConflicts: [] } });
    const req = await requestCorrection(t.timesheetId, admin, 'vacation day', randomUUID());
    const reqId = (req as { id: string }).id;
    await openCorrectionDraft(reqId, admin, randomUUID());
    await patchCorrectionDraftDay(reqId, new Date(`${t.emptyDate}T00:00:00.000Z`), { dayType: 'VACATION', confirmedZero: false, segments: [] }, admin);
    const count = await prisma.absence.count({ where: { employeeId: t.employeeId, type: 'VACATION' } });
    check('existing Absence reused (still exactly 1)', count === 1, count);
  }

  // 3. no actorUserId -> still DAY_TYPE_REQUIRES_ABSENCE (backward compatible)
  {
    const t = await makeSubmitted(admin, 'C');
    const req = await requestCorrection(t.timesheetId, admin, 'x', randomUUID());
    const reqId = (req as { id: string }).id;
    await openCorrectionDraft(reqId, admin, randomUUID());
    const patched = await patchCorrectionDraftDay(reqId, new Date(`${t.emptyDate}T00:00:00.000Z`), { dayType: 'SICK_LEAVE', confirmedZero: false, segments: [] });
    check('no actorUserId -> DAY_TYPE_REQUIRES_ABSENCE (unchanged)', 'code' in patched && patched.code === 'DAY_TYPE_REQUIRES_ABSENCE', patched);
  }

  // 4. PUBLIC_HOLIDAY still rejected (no AbsenceType counterpart)
  {
    const t = await makeSubmitted(admin, 'D');
    const req = await requestCorrection(t.timesheetId, admin, 'x', randomUUID());
    const reqId = (req as { id: string }).id;
    await openCorrectionDraft(reqId, admin, randomUUID());
    const patched = await patchCorrectionDraftDay(reqId, new Date(`${t.emptyDate}T00:00:00.000Z`), { dayType: 'PUBLIC_HOLIDAY', confirmedZero: false, segments: [] }, admin);
    check('PUBLIC_HOLIDAY still DAY_TYPE_REQUIRES_ABSENCE', 'code' in patched && patched.code === 'DAY_TYPE_REQUIRES_ABSENCE', patched);
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
