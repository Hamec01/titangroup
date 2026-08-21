import { Prisma, type TimesheetSubmissionCadence } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { ensureEmployeePeriodCore, isPeriodOverlapViolation } from '@/lib/periods';
import { helsinkiToday } from '@/lib/workers';

const DAY_MS = 86_400_000;

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function cycleDays(cadence: TimesheetSubmissionCadence): number {
  return cadence === 'WEEKLY' ? 7 : 14;
}

export function submissionPeriodForDate(schedule: { cadence: TimesheetSubmissionCadence; anchorDate: Date }, date: Date) {
  const length = cycleDays(schedule.cadence);
  const daysFromAnchor = Math.floor((date.getTime() - schedule.anchorDate.getTime()) / DAY_MS);
  const cycleIndex = Math.floor(daysFromAnchor / length);
  const startDate = addDays(schedule.anchorDate, cycleIndex * length);
  return { startDate, endDate: addDays(startDate, length - 1) };
}

export interface SubmissionScheduleOption {
  id: string;
  name: string;
  cadence: TimesheetSubmissionCadence;
  isCompanyDefault: boolean;
  periods: Array<{ startDate: string; endDate: string }>;
}

export interface WorkerSubmissionScheduleView {
  options: SubmissionScheduleOption[];
  selectedScheduleId: string;
  inheritedCompanyDefault: boolean;
  effectiveFrom: string;
  periods: Array<{ startDate: string; endDate: string }>;
}

export async function getWorkerSubmissionScheduleView(employeeId: string): Promise<WorkerSubmissionScheduleView | null> {
  const today = helsinkiToday();
  const [employee, options, assignment] = await Promise.all([
    prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true } }),
    prisma.timesheetSubmissionSchedule.findMany({
      where: { active: true },
      orderBy: [{ isCompanyDefault: 'desc' }, { cadence: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, cadence: true, isCompanyDefault: true, anchorDate: true }
    }),
    prisma.employeeTimesheetSchedule.findFirst({
      where: {
        employeeId,
        effectiveFrom: { lte: today },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }]
      },
      orderBy: { effectiveFrom: 'desc' },
      include: { schedule: true }
    })
  ]);
  if (!employee) return null;
  const selected = assignment?.schedule ?? options.find((option) => option.isCompanyDefault);
  if (!selected) throw new Error('TIMESHEET_SUBMISSION_SCHEDULE_DEFAULT_MISSING');
  const current = submissionPeriodForDate(selected, today);
  const length = cycleDays(selected.cadence);
  return {
    options: options.map(({ anchorDate, ...option }) => {
      const optionCurrent = submissionPeriodForDate({ cadence: option.cadence, anchorDate }, today);
      const optionLength = cycleDays(option.cadence);
      return {
        ...option,
        periods: [0, 1, 2].map((offset) => ({
          startDate: dateKey(addDays(optionCurrent.startDate, offset * optionLength)),
          endDate: dateKey(addDays(optionCurrent.endDate, offset * optionLength))
        }))
      };
    }),
    selectedScheduleId: selected.id,
    inheritedCompanyDefault: !assignment,
    effectiveFrom: dateKey(assignment?.effectiveFrom ?? current.startDate),
    periods: [0, 1, 2].map((offset) => ({
      startDate: dateKey(addDays(current.startDate, offset * length)),
      endDate: dateKey(addDays(current.endDate, offset * length))
    }))
  };
}

export type AssignSubmissionScheduleResult =
  | { ok: true; scheduleId: string; effectiveFrom: string; generatedPeriods: Array<{ id: string; startDate: string; endDate: string }> }
  | { ok: false; code: 'WORKER_NOT_FOUND' | 'SCHEDULE_NOT_FOUND' | 'EFFECTIVE_FROM_NOT_BOUNDARY' | 'EFFECTIVE_FROM_BEFORE_CURRENT' | 'EXISTING_PERIOD_HAS_DATA' | 'PERIOD_OVERLAP' };

export async function assignWorkerSubmissionSchedule(input: {
  employeeId: string;
  scheduleId: string;
  effectiveFrom: Date;
  actorUserId: string;
  requestId: string;
}): Promise<AssignSubmissionScheduleResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const employees = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Employee" WHERE id = ${input.employeeId}::uuid FOR UPDATE`;
      if (!employees.length) return { ok: false, code: 'WORKER_NOT_FOUND' } as const;
      const schedules = await tx.$queryRaw<Array<{ id: string; name: string; cadence: TimesheetSubmissionCadence; anchorDate: Date }>>`
        SELECT id, name, cadence, "anchorDate" FROM "TimesheetSubmissionSchedule"
        WHERE id = ${input.scheduleId}::uuid AND active = true FOR UPDATE`;
      const schedule = schedules[0];
      if (!schedule) return { ok: false, code: 'SCHEDULE_NOT_FOUND' } as const;
      if (submissionPeriodForDate(schedule, input.effectiveFrom).startDate.getTime() !== input.effectiveFrom.getTime()) {
        return { ok: false, code: 'EFFECTIVE_FROM_NOT_BOUNDARY' } as const;
      }

      const openAssignment = await tx.employeeTimesheetSchedule.findFirst({
        where: { employeeId: input.employeeId, effectiveTo: null },
        orderBy: { effectiveFrom: 'desc' }
      });
      if (openAssignment && input.effectiveFrom < openAssignment.effectiveFrom) {
        return { ok: false, code: 'EFFECTIVE_FROM_BEFORE_CURRENT' } as const;
      }
      const replaceableTimesheets = await tx.timesheet.findMany({
        where: {
          employeeId: input.employeeId,
          period: { submissionScheduleId: { not: null }, startDate: { gte: input.effectiveFrom } }
        },
        select: {
          id: true,
          status: true,
          periodId: true,
          draft: { select: { id: true, timesheetDraftSegments: { select: { id: true }, take: 1 } } },
          versions: { select: { id: true }, take: 1 },
          clockShiftFragments: { select: { id: true }, take: 1 },
          attendanceExceptions: { select: { id: true }, take: 1 }
        }
      });
      if (replaceableTimesheets.some((timesheet) => !['DRAFT', 'RETURNED'].includes(timesheet.status) || timesheet.versions.length || timesheet.clockShiftFragments.length || timesheet.attendanceExceptions.length || (timesheet.draft?.timesheetDraftSegments.length ?? 0))) {
        return { ok: false, code: 'EXISTING_PERIOD_HAS_DATA' } as const;
      }
      for (const timesheet of replaceableTimesheets) {
        if (timesheet.draft) {
          await tx.timesheetDraftPlannedShift.deleteMany({ where: { draftId: timesheet.draft.id } });
          await tx.timesheetDraftDay.deleteMany({ where: { draftId: timesheet.draft.id } });
          await tx.timesheetDraft.delete({ where: { id: timesheet.draft.id } });
        }
        await tx.timesheet.delete({ where: { id: timesheet.id } });
        await tx.payrollPeriodParticipant.delete({ where: { periodId_employeeId: { periodId: timesheet.periodId, employeeId: input.employeeId } } });
      }
      if (openAssignment && openAssignment.effectiveFrom < input.effectiveFrom) {
        await tx.employeeTimesheetSchedule.update({
          where: { id: openAssignment.id },
          data: { effectiveTo: addDays(input.effectiveFrom, -1) }
        });
      } else if (openAssignment && openAssignment.effectiveFrom.getTime() === input.effectiveFrom.getTime()) {
        await tx.employeeTimesheetSchedule.delete({ where: { id: openAssignment.id } });
      }
      await tx.employeeTimesheetSchedule.create({
        data: {
          employeeId: input.employeeId,
          scheduleId: input.scheduleId,
          effectiveFrom: input.effectiveFrom,
          assignedByUserId: input.actorUserId
        }
      });

      const length = cycleDays(schedule.cadence);
      const generatedPeriods: Array<{ id: string; startDate: string; endDate: string }> = [];
      for (let offset = 0; offset < 2; offset += 1) {
        const startDate = addDays(input.effectiveFrom, offset * length);
        const endDate = addDays(startDate, length - 1);
        let period = await tx.payrollPeriod.findFirst({
          where: { submissionScheduleId: schedule.id, startDate, endDate },
          select: { id: true }
        });
        if (!period) {
          period = await tx.payrollPeriod.create({
            data: {
              startDate,
              endDate,
              status: 'OPEN',
              openedByUserId: input.actorUserId,
              submissionScheduleId: schedule.id
            },
            select: { id: true }
          });
        }
        await ensureEmployeePeriodCore(tx, { periodId: period.id, employeeId: input.employeeId, startDate, endDate });
        generatedPeriods.push({ id: period.id, startDate: dateKey(startDate), endDate: dateKey(endDate) });
      }

      await createAuditEvent(tx, {
        actorUserId: input.actorUserId,
        eventType: 'WORKER_TIMESHEET_SCHEDULE_ASSIGNED',
        entityType: 'EMPLOYEE',
        entityId: input.employeeId,
        requestId: input.requestId,
        beforeValue: openAssignment ? { scheduleId: openAssignment.scheduleId, effectiveFrom: dateKey(openAssignment.effectiveFrom) } : null,
        afterValue: { scheduleId: schedule.id, cadence: schedule.cadence, effectiveFrom: dateKey(input.effectiveFrom) }
      });

      return { ok: true, scheduleId: schedule.id, effectiveFrom: dateKey(input.effectiveFrom), generatedPeriods } as const;
    });
  } catch (error) {
    if (isPeriodOverlapViolation(error)) return { ok: false, code: 'PERIOD_OVERLAP' };
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { ok: false, code: 'PERIOD_OVERLAP' };
    }
    throw error;
  }
}

export interface SubmissionScheduleGenerationResult {
  assignmentsScanned: number;
  periodsPrepared: number;
  failed: number;
}

/** Maintains a rolling current+next horizon. It is intentionally idempotent and worker-scoped;
 * the scheduler may call it repeatedly or from multiple replicas. Schedule/Employee row locks plus
 * unique keys make those calls converge on the same periods and drafts. */
export async function ensureSubmissionScheduleHorizon(now = new Date()): Promise<SubmissionScheduleGenerationResult> {
  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(now);
  const today = new Date(`${todayKey}T00:00:00.000Z`);
  const horizon = addDays(today, 35);
  const systemActor = await prisma.user.findFirst({
    where: { userKind: 'SYSTEM', username: 'system.scheduler' },
    select: { id: true, status: true, passwordHash: true, employeeId: true }
  });
  if (!systemActor || systemActor.status !== 'DEACTIVATED' || systemActor.passwordHash !== null || systemActor.employeeId !== null) {
    throw new Error('SYSTEM_SCHEDULER_ACTOR_MISSING_OR_INVALID');
  }
  const assignments = await prisma.employeeTimesheetSchedule.findMany({
    where: {
      effectiveFrom: { lte: horizon },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }]
    },
    include: { schedule: true },
    orderBy: [{ employeeId: 'asc' }, { effectiveFrom: 'asc' }]
  });
  let periodsPrepared = 0;
  let failed = 0;
  for (const assignment of assignments) {
    try {
      const preparedForAssignment = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${assignment.employeeId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "TimesheetSubmissionSchedule" WHERE id = ${assignment.scheduleId}::uuid FOR UPDATE`;
        const seedDate = assignment.effectiveFrom > today ? assignment.effectiveFrom : today;
        const first = submissionPeriodForDate(assignment.schedule, seedDate);
        const length = cycleDays(assignment.schedule.cadence);
        let prepared = 0;
        for (let offset = 0; offset < 2; offset += 1) {
          const startDate = addDays(first.startDate, offset * length);
          if (assignment.effectiveTo && startDate > assignment.effectiveTo) continue;
          const endDate = addDays(startDate, length - 1);
          let period = await tx.payrollPeriod.findFirst({
            where: { submissionScheduleId: assignment.scheduleId, startDate, endDate },
            select: { id: true }
          });
          if (!period) {
            period = await tx.payrollPeriod.create({
              data: { startDate, endDate, status: 'OPEN', openedByUserId: systemActor.id, submissionScheduleId: assignment.scheduleId },
              select: { id: true }
            });
          }
          await ensureEmployeePeriodCore(tx, { periodId: period.id, employeeId: assignment.employeeId, startDate, endDate });
          prepared += 1;
        }
        return prepared;
      });
      periodsPrepared += preparedForAssignment;
    } catch {
      failed += 1;
    }
  }
  return { assignmentsScanned: assignments.length, periodsPrepared, failed };
}
