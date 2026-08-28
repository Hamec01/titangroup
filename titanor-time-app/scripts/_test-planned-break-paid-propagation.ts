// T10-D (2026-08-28) — the "обед оплачивается" flag + the no-template safety net.
//
// Verifies the full propagation chain for plannedBreakPaid:
//   WorkScheduleTemplateVersionDay.plannedBreakPaid
//     -> TimesheetDraftPlannedShift.plannedBreakPaid   (createAssignment / computePlannedShiftForAssignmentDate)
//     -> TimesheetPlannedShift.plannedBreakPaid         (submitWorkerTimesheetCore freeze)
//     -> loadVersionPlannedUnpaidBreakByDate            (0 for a paid day, the minutes for an unpaid one)
// and the CompanyAttendancePolicy.autoUnpaidBreakMinutes fallback for an assignment with no template.
//
// Needs a disposable PostgreSQL 16 with all migrations applied (DATABASE_URL).
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { createAssignment } from '../lib/assignments';
import { submitWorkerTimesheetCore } from '../lib/worker-timesheets';
import { toTemplateWeekday } from '../lib/periods';
import { loadVersionPlannedUnpaidBreakByDate, effectiveUnpaidBreakMinutes } from '../lib/reporting/auto-break';
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

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function makeAdmin(): Promise<string> {
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'ADMIN' } });
  const u = await prisma.user.create({ data: { username: `bp_${randomUUID().slice(0, 8)}`, status: 'ACTIVE', locale: 'EN', userRoles: { create: { roleId: role.id } } } });
  return u.id;
}

/** A 7-working-day template; every day 07:00–17:00 with a `breakMinutes` break of the given paid-ness. */
async function makeTemplate(adminId: string, breakMinutes: number, breakPaid: boolean): Promise<string> {
  const tpl = await prisma.workScheduleTemplate.create({ data: { name: `BP ${randomUUID().slice(0, 6)}` } });
  const v = await prisma.workScheduleTemplateVersion.create({
    data: { templateId: tpl.id, versionNumber: 1, createdByUserId: adminId, effectiveFrom: new Date('2020-01-01T00:00:00.000Z') }
  });
  await prisma.workScheduleTemplateVersionDay.createMany({
    data: Array.from({ length: 7 }, (_, weekday) => ({
      templateVersionId: v.id,
      weekday,
      isWorkingDay: true,
      plannedStartTime: new Date('1970-01-01T07:00:00Z'),
      plannedEndTime: new Date('1970-01-01T17:00:00Z'),
      plannedBreakMinutes: breakMinutes,
      plannedBreakPaid: breakPaid
    }))
  });
  return tpl.id;
}

async function makeEmployee(): Promise<string> {
  const emp = await prisma.employee.create({ data: { employeeNumber: `BP-${randomUUID().slice(0, 8)}`, firstName: 'B', lastName: 'P' } });
  await prisma.employment.create({ data: { employeeId: emp.id, active: true, startDate: new Date('2020-01-01T00:00:00.000Z') } });
  return emp.id;
}

/** createAssignment against an already-OPEN period, then add a segment on `workDay` and submit.
 *  Returns the frozen version id + the worked date. */
async function assignWorkSubmit(adminId: string, periodId: string, periodStart: Date, periodEnd: Date, employeeId: string, siteId: string, templateId: string | null, workDay: Date) {
  const res = await createAssignment({
    employeeId,
    siteId,
    workAreaId: null,
    templateId,
    validFrom: periodStart,
    validTo: periodEnd,
    isPrimary: true,
    assignedByUserId: adminId,
    requestId: randomUUID()
  });
  if ('code' in res) throw new Error(`createAssignment failed: ${res.code}`);
  const asgId = res.id;

  const ts = await prisma.timesheet.findFirstOrThrow({ where: { employeeId, periodId }, select: { id: true, draft: { select: { id: true } } } });
  const draftId = ts.draft!.id;

  const draftDay = await prisma.timesheetDraftDay.findUniqueOrThrow({ where: { draftId_date: { draftId, date: workDay } }, select: { id: true } });
  await prisma.timesheetDraftSegment.create({
    data: {
      draftDayId: draftDay.id,
      draftId,
      employeeId,
      date: workDay,
      startAt: new Date(workDay.getTime() + 7 * 3600000),
      endAt: new Date(workDay.getTime() + 16 * 3600000), // 9 h gross, no break
      siteId,
      sourceAssignmentId: asgId
    }
  });

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${ts.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE id = ${draftId}::uuid FOR UPDATE`;
    await submitWorkerTimesheetCore(tx, employeeId, ts.id, adminId, randomUUID(), SubmissionSource.MANUAL);
  });

  const version = await prisma.timesheet.findUniqueOrThrow({ where: { id: ts.id }, select: { currentVersionId: true } });
  return { versionId: version.currentVersionId!, draftId, asgId, workDay };
}

async function main() {
  const admin = await makeAdmin();
  await prisma.companyAttendancePolicy.upsert({
    where: { singleton: true },
    create: { singleton: true, autoUnpaidBreakThresholdMinutes: 360, autoUnpaidBreakMinutes: 30 },
    update: { autoUnpaidBreakThresholdMinutes: 360, autoUnpaidBreakMinutes: 30 }
  });

  const site = await prisma.workSite.create({ data: { name: `BP site ${randomUUID().slice(0, 5)}` } });

  // A 5-day OPEN period Mon–Fri at a RANDOM far-future Monday — the disposable DB accumulates rows
  // across every test run, and the participant-overlap trigger fires if this run reuses a week that
  // an earlier run already created.
  const epochMonday = Date.UTC(2035, 0, 1); // 2035-01-01 is a Monday
  const weeksOut = Math.floor(Math.random() * 90000);
  const periodStart = new Date(epochMonday + weeksOut * 7 * 86400000);
  const periodEnd = new Date(periodStart.getTime() + 4 * 86400000); // Mon..Fri
  const period = await prisma.payrollPeriod.create({ data: { startDate: periodStart, endDate: periodEnd, status: 'OPEN', openedByUserId: admin } });
  const workDay = new Date(periodStart.getTime() + 2 * 86400000); // Wed
  check('workDay maps to a template working weekday', toTemplateWeekday(workDay) === 2, toTemplateWeekday(workDay));

  const tplPaid = await makeTemplate(admin, 30, true);
  const tplUnpaid = await makeTemplate(admin, 30, false);

  // --- Scenario A: template with plannedBreakPaid = true ---
  {
    const emp = await makeEmployee();
    const draftShift = await (async () => {
      const r = await createAssignment({ employeeId: emp, siteId: site.id, workAreaId: null, templateId: tplPaid, validFrom: periodStart, validTo: periodEnd, isPrimary: true, assignedByUserId: admin, requestId: randomUUID() });
      if ('code' in r) throw new Error(r.code);
      return prisma.timesheetDraftPlannedShift.findFirstOrThrow({ where: { sourceAssignmentId: r.id, date: workDay }, select: { plannedBreakMinutes: true, plannedBreakPaid: true } });
    })();
    check('A: draft planned shift carries plannedBreakPaid = true', draftShift.plannedBreakPaid === true && draftShift.plannedBreakMinutes === 30, draftShift);

    // finish: add segment + submit (re-uses the assignment just created)
    const ts = await prisma.timesheet.findFirstOrThrow({ where: { employeeId: emp, periodId: period.id }, select: { id: true, draft: { select: { id: true } } } });
    const dd = await prisma.timesheetDraftDay.findUniqueOrThrow({ where: { draftId_date: { draftId: ts.draft!.id, date: workDay } }, select: { id: true } });
    const asg = await prisma.siteAssignment.findFirstOrThrow({ where: { employeeId: emp }, select: { id: true } });
    await prisma.timesheetDraftSegment.create({ data: { draftDayId: dd.id, draftId: ts.draft!.id, employeeId: emp, date: workDay, startAt: new Date(workDay.getTime() + 7 * 3600000), endAt: new Date(workDay.getTime() + 16 * 3600000), siteId: site.id, sourceAssignmentId: asg.id } });
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${emp}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${ts.id}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE id = ${ts.draft!.id}::uuid FOR UPDATE`;
      await submitWorkerTimesheetCore(tx, emp, ts.id, admin, randomUUID(), SubmissionSource.MANUAL);
    });
    const versionId = (await prisma.timesheet.findUniqueOrThrow({ where: { id: ts.id }, select: { currentVersionId: true } })).currentVersionId!;
    const frozen = await prisma.timesheetPlannedShift.findFirstOrThrow({ where: { timesheetVersionId: versionId, date: workDay }, select: { plannedBreakPaid: true } });
    check('A: frozen TimesheetPlannedShift keeps plannedBreakPaid = true', frozen.plannedBreakPaid === true);
    const map = await loadVersionPlannedUnpaidBreakByDate([versionId]);
    check('A: loader excludes the paid day (no auto-deduction)', !map.has(iso(workDay)), [...map]);
  }

  // --- Scenario B: template with plannedBreakPaid = false, 30-min break ---
  {
    const emp = await makeEmployee();
    const r = await assignWorkSubmit(admin, period.id, periodStart, periodEnd, emp, site.id, tplUnpaid, workDay);
    const frozen = await prisma.timesheetPlannedShift.findFirstOrThrow({ where: { timesheetVersionId: r.versionId, date: workDay }, select: { plannedBreakMinutes: true, plannedBreakPaid: true } });
    check('B: frozen planned shift is 30 min, not paid', frozen.plannedBreakMinutes === 30 && frozen.plannedBreakPaid === false, frozen);
    const map = await loadVersionPlannedUnpaidBreakByDate([r.versionId]);
    check('B: loader returns 30 for the unpaid template day', map.get(iso(workDay)) === 30, [...map]);
  }

  // --- Scenario C: NO template -> planned shift break 0 -> policy fallback (30) ---
  {
    const emp = await makeEmployee();
    const r = await assignWorkSubmit(admin, period.id, periodStart, periodEnd, emp, site.id, null, workDay);
    const frozen = await prisma.timesheetPlannedShift.findFirstOrThrow({ where: { timesheetVersionId: r.versionId, date: workDay }, select: { plannedBreakMinutes: true, plannedBreakPaid: true } });
    check('C: no-template frozen planned shift is 0 min, not paid', frozen.plannedBreakMinutes === 0 && frozen.plannedBreakPaid === false, frozen);
    const map = await loadVersionPlannedUnpaidBreakByDate([r.versionId]);
    check('C: loader falls back to the policy default (30) when the plan has no break', map.get(iso(workDay)) === 30, [...map]);

    // and with the fallback disabled (autoUnpaidBreakMinutes = 0) the day is excluded again
    await prisma.companyAttendancePolicy.update({ where: { singleton: true }, data: { autoUnpaidBreakMinutes: 0 } });
    const map0 = await loadVersionPlannedUnpaidBreakByDate([r.versionId]);
    check('C: fallback 0 -> no-template day excluded', !map0.has(iso(workDay)), [...map0]);
    await prisma.companyAttendancePolicy.update({ where: { singleton: true }, data: { autoUnpaidBreakMinutes: 30 } });
  }

  // --- precedence unit sanity (mirrors _test-auto-unpaid-break but against the real export) ---
  check('effectiveUnpaidBreakMinutes: paid wins', effectiveUnpaidBreakMinutes(30, true, 30) === 0);
  check('effectiveUnpaidBreakMinutes: template minutes win over default', effectiveUnpaidBreakMinutes(45, false, 30) === 45);
  check('effectiveUnpaidBreakMinutes: default fills the 0 gap', effectiveUnpaidBreakMinutes(0, false, 30) === 30);

  console.log(JSON.stringify({ pass, fail }));
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
