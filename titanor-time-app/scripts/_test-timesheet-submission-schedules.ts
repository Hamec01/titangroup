import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { assignWorkerSubmissionSchedule, ensureSubmissionScheduleHorizon, submissionPeriodForDate } from '../lib/timesheet-submission-schedules';
import { ensureEmployeePeriodCore, updateLegacyOpenPeriod } from '../lib/periods';
import { getAdminOperationalOverview } from '../lib/attendance-overview';
import { createAssignment } from '../lib/assignments';

let passed = 0;
function check(condition: unknown, name: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${name}`);
  passed += 1;
}

async function employee(number: string) {
  const row = await prisma.employee.create({ data: { employeeNumber: number, firstName: number, lastName: 'Cycle' } });
  await prisma.employment.create({ data: { employeeId: row.id, active: true, startDate: new Date('2026-01-01') } });
  return row;
}

async function main() {
  const actor = await prisma.user.create({ data: { username: `cycle-admin-${randomUUID()}`, status: 'ACTIVE', locale: 'EN' } });
  const weekly = await prisma.timesheetSubmissionSchedule.findFirstOrThrow({ where: { cadence: 'WEEKLY' } });
  const biweekly = await prisma.timesheetSubmissionSchedule.findFirstOrThrow({ where: { cadence: 'BIWEEKLY' } });
  const weeklyWorker = await employee('CYCLE-WEEKLY');
  const biweeklyWorker = await employee('CYCLE-BIWEEKLY');
  const boundary = new Date('2026-08-17T00:00:00.000Z');

  const weeklyResult = await assignWorkerSubmissionSchedule({ employeeId: weeklyWorker.id, scheduleId: weekly.id, effectiveFrom: boundary, actorUserId: actor.id, requestId: randomUUID() });
  check(weeklyResult.ok, 'weekly assignment succeeds');
  check(weeklyResult.ok && weeklyResult.generatedPeriods.length === 2, 'weekly creates current+next');
  const biweeklyBoundary = submissionPeriodForDate(biweekly, boundary).startDate;
  const biweeklyResult = await assignWorkerSubmissionSchedule({ employeeId: biweeklyWorker.id, scheduleId: biweekly.id, effectiveFrom: biweeklyBoundary, actorUserId: actor.id, requestId: randomUUID() });
  check(biweeklyResult.ok, 'biweekly assignment succeeds despite overlapping weekly dates');
  check(biweeklyResult.ok && (new Date(biweeklyResult.generatedPeriods[0].endDate).getTime() - new Date(biweeklyResult.generatedPeriods[0].startDate).getTime()) / 86_400_000 === 13, 'biweekly range is 14 days');

  const weeklyPeriods = await prisma.payrollPeriodParticipant.count({ where: { employeeId: weeklyWorker.id } });
  const biweeklyPeriods = await prisma.payrollPeriodParticipant.count({ where: { employeeId: biweeklyWorker.id } });
  check(weeklyPeriods === 2 && biweeklyPeriods === 2, 'each worker has exactly two periods');
  check((await prisma.timesheet.count({ where: { employeeId: { in: [weeklyWorker.id, biweeklyWorker.id] } } })) === 4, 'each generated participant has a draft timesheet');

  const firstHorizon = await ensureSubmissionScheduleHorizon(new Date('2026-08-21T10:00:00Z'));
  const secondHorizon = await ensureSubmissionScheduleHorizon(new Date('2026-08-21T10:00:00Z'));
  check(firstHorizon.failed === 0 && secondHorizon.failed === 0, 'scheduler horizon has no failures');
  check((await prisma.timesheet.count({ where: { employeeId: { in: [weeklyWorker.id, biweeklyWorker.id] } } })) === 4, 'scheduler replay creates no duplicate timesheets');

  // Current contract (lib/assignments.ts): the FIRST-ever site assignment for a worker with zero
  // schedule history auto-enrols them on the active company-default cadence (Weekly here), aligned
  // to that cadence's own boundary — otherwise a real worker is stranded with a SiteAssignment but
  // no Timesheet. An admin who has ever made an explicit schedule decision is never overridden.
  const firstAssignmentWorker = await employee('CYCLE-FIRST-ASSIGNMENT');
  const assignmentSite = await prisma.workSite.create({ data: { name: `Cycle assignment ${randomUUID()}` } });
  const firstAssignment = await createAssignment({
    employeeId: firstAssignmentWorker.id,
    siteId: assignmentSite.id,
    workAreaId: null,
    templateId: null,
    validFrom: boundary,
    validTo: null,
    isPrimary: true,
    assignedByUserId: actor.id,
    requestId: randomUUID()
  });
  check('id' in firstAssignment, 'first site assignment succeeds for a worker with no submission schedule');
  const autoSchedule = await prisma.employeeTimesheetSchedule.findFirst({
    where: { employeeId: firstAssignmentWorker.id },
    include: { schedule: { select: { isCompanyDefault: true, cadence: true } } }
  });
  check(
    autoSchedule?.schedule.isCompanyDefault === true && autoSchedule.schedule.cadence === 'WEEKLY',
    'first assignment auto-enrols the worker on the active company-default cadence'
  );
  check(
    (await prisma.payrollPeriodParticipant.count({
      where: { employeeId: firstAssignmentWorker.id, period: { submissionScheduleId: weekly.id } }
    })) === 2,
    'auto-enrolment generates the company-default current+next periods (never any other cohort)'
  );
  check(
    (await prisma.payrollPeriodParticipant.count({
      where: { employeeId: firstAssignmentWorker.id, period: { submissionScheduleId: { notIn: [weekly.id] } } }
    })) === 0,
    'auto-enrolment never places the worker in a non-default cohort'
  );

  const legacyWorker = await employee('CYCLE-LEGACY');
  const legacy = await prisma.payrollPeriod.create({ data: { startDate: boundary, endDate: new Date('2027-06-20'), status: 'OPEN', openedByUserId: actor.id } });
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${legacyWorker.id}::uuid FOR UPDATE`;
    await ensureEmployeePeriodCore(tx, { periodId: legacy.id, employeeId: legacyWorker.id, startDate: legacy.startDate, endDate: legacy.endDate });
  });
  const overlap = await assignWorkerSubmissionSchedule({ employeeId: legacyWorker.id, scheduleId: weekly.id, effectiveFrom: boundary, actorUserId: actor.id, requestId: randomUUID() });
  check(!overlap.ok && overlap.code === 'PERIOD_OVERLAP', 'legacy overlap is rejected and schedule assignment rolls back');
  check((await prisma.employeeTimesheetSchedule.count({ where: { employeeId: legacyWorker.id } })) === 0, 'failed assignment leaves no schedule row');

  const edited = await updateLegacyOpenPeriod({ periodId: legacy.id, startDate: boundary, endDate: new Date('2026-08-23'), version: 1, actorUserId: actor.id, requestId: randomUUID() });
  check(edited.ok && edited.endDate === '2026-08-23', 'legacy period can be safely shortened');
  check((await prisma.timesheetDraftDay.count({ where: { draft: { timesheet: { periodId: legacy.id } } } })) === 7, 'obsolete empty draft days are removed');
  const nextBoundary = new Date('2026-08-24T00:00:00.000Z');
  const transitioned = await assignWorkerSubmissionSchedule({ employeeId: legacyWorker.id, scheduleId: weekly.id, effectiveFrom: nextBoundary, actorUserId: actor.id, requestId: randomUUID() });
  check(transitioned.ok, 'worker transitions from shortened legacy period to weekly automation');

  const switchWorker = await employee('CYCLE-SWITCH');
  const switchInitial = await assignWorkerSubmissionSchedule({ employeeId: switchWorker.id, scheduleId: weekly.id, effectiveFrom: boundary, actorUserId: actor.id, requestId: randomUUID() });
  check(switchInitial.ok, 'switch fixture starts weekly');
  const switchNext = await assignWorkerSubmissionSchedule({ employeeId: switchWorker.id, scheduleId: biweekly.id, effectiveFrom: new Date('2026-08-24'), actorUserId: actor.id, requestId: randomUUID() });
  check(switchNext.ok, 'empty generated future period is safely replaced by biweekly cycle');
  check((await prisma.timesheet.count({ where: { employeeId: switchWorker.id } })) === 3, 'switch preserves current weekly and prepares two biweekly periods without overlap');
  const backdatedSwitch = await assignWorkerSubmissionSchedule({ employeeId: switchWorker.id, scheduleId: weekly.id, effectiveFrom: boundary, actorUserId: actor.id, requestId: randomUUID() });
  check(!backdatedSwitch.ok && backdatedSwitch.code === 'EFFECTIVE_FROM_BEFORE_CURRENT', 'a scheduled future change cannot be backdated into an existing schedule window');

  const overview = await getAdminOperationalOverview({ page: 1, pageSize: 100 }, boundary);
  // weeklyWorker + biweeklyWorker + firstAssignmentWorker (auto-enrolled weekly) + legacyWorker +
  // switchWorker. CYCLE-INVALID never enrols (EFFECTIVE_FROM_NOT_BOUNDARY) so it is not counted.
  check(overview.code === 'OK' && overview.result.summary.totalWorkers === 5, 'unfiltered overview combines every current cadence cohort');

  const invalidBoundary = await assignWorkerSubmissionSchedule({ employeeId: await employee('CYCLE-INVALID').then((e) => e.id), scheduleId: weekly.id, effectiveFrom: new Date('2026-08-25'), actorUserId: actor.id, requestId: randomUUID() });
  check(!invalidBoundary.ok && invalidBoundary.code === 'EFFECTIVE_FROM_NOT_BOUNDARY', 'non-boundary effective date is rejected');
  // weekly + biweekly + transitioned + switchInitial + switchNext + the first-assignment auto-enrol.
  check((await prisma.auditEvent.count({ where: { eventType: 'WORKER_TIMESHEET_SCHEDULE_ASSIGNED' } })) === 6, 'successful schedule changes are audited once');

  console.log(`PASS: ${passed}/${passed} submission-cycle integration checks`);
}

main().finally(() => prisma.$disconnect());
