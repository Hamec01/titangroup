import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §7 (Расчётные периоды) +
// docs/titanor-time/03_DATA_MODEL_ERD.md §4.5-4.6 ("Жизненный цикл draft",
// шаг 1) — PROJECT_ROADMAP.md ЭТАП 7 first sub-task, confirmed by the owner.

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function enumerateDates(start: Date, end: Date): Date[] {
  const dates: Date[] = [];
  let cursor = start;
  while (cursor <= end) {
    dates.push(cursor);
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1));
  }
  return dates;
}

/** WorkScheduleTemplateVersionDay.weekday convention: 0=Mon..6=Sun. `date` is a UTC-midnight Date representing a Helsinki calendar day (project-wide convention), so plain getUTCDay() (0=Sun..6=Sat) is the right source, remapped. */
export function toTemplateWeekday(date: Date): number {
  return (date.getUTCDay() + 6) % 7;
}

/** What the Europe/Helsinki UTC offset (in minutes) is at a given instant — used to convert a Helsinki wall-clock time into the correct UTC instant, DST included. */
function helsinkiOffsetMinutesAt(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Helsinki',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(instant);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)!.value);
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asIfUtc - instant.getTime()) / 60000);
}

/**
 * Combines a Helsinki calendar `date` (UTC-midnight Date) with a wall-clock
 * `timeOfDay` (a `@db.Time` value, i.e. a Date whose UTC hour/minute/second
 * carry the local time-of-day — see app/api/admin/templates/route.ts's
 * parseTimeToDate, which writes plannedStartTime/plannedEndTime the same
 * way) into the actual UTC instant that wall-clock time falls on, correctly
 * shifted for whichever of EET/EEST applies on that date.
 */
export function helsinkiWallClockToUtc(date: Date, timeOfDay: Date): Date {
  const naiveGuess = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      timeOfDay.getUTCHours(),
      timeOfDay.getUTCMinutes(),
      timeOfDay.getUTCSeconds()
    )
  );
  const offsetMinutes = helsinkiOffsetMinutesAt(naiveGuess);
  return new Date(naiveGuess.getTime() - offsetMinutes * 60000);
}

/**
 * EX-03 (`ex_payroll_period_date_overlap`, 05_RAW_SQL_REGISTER.md) is a
 * Postgres EXCLUDE constraint (SQLSTATE 23P01) — surfaces as an untyped
 * PrismaClientUnknownRequestError, same shape as EX-02 in lib/assignments.ts.
 */
export function isPeriodOverlapViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientUnknownRequestError &&
    error.message.includes('23P01') &&
    error.message.includes('ex_payroll_period_date_overlap')
  );
}

export interface CreatePeriodInput {
  startDate: Date;
  endDate: Date;
  openedByUserId: string;
  requestId: string;
}

export type CreatePeriodError = { code: 'PERIOD_OVERLAP' };

export interface CreatePeriodResult {
  id: string;
  startDate: string;
  endDate: string;
  status: 'OPEN';
  openedByUserId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  participantsCount: number;
}

/**
 * Creates the PayrollPeriod, then for every Employee with a SiteAssignment
 * intersecting [startDate, endDate]: the PayrollPeriodParticipant +
 * Timesheet(DRAFT) + TimesheetDraft triple, pre-filled with one
 * TimesheetDraftDay per calendar day of the period (Absence(APPROVED)
 * overlay applied before the WORK default, same overlay mechanism as
 * absence.approve) and one TimesheetDraftPlannedShift per (day, assignment)
 * the employee actually has active that day, resolved from the assignment's
 * WorkScheduleTemplateVersion. Employees are locked `FOR UPDATE` in
 * ascending id order first, guarding against a concurrent absence.approve on
 * the same employee racing this generation (03_DATA_MODEL_ERD.md §4.6, шаг 1).
 */
export async function createPeriod(input: CreatePeriodInput): Promise<CreatePeriodResult | CreatePeriodError> {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const period = await tx.payrollPeriod.create({
        data: { startDate: input.startDate, endDate: input.endDate, status: 'OPEN', openedByUserId: input.openedByUserId }
      });

      const dates = enumerateDates(input.startDate, input.endDate);

      const intersectingAssignments = await tx.siteAssignment.findMany({
        where: {
          validFrom: { lte: input.endDate },
          OR: [{ validTo: null }, { validTo: { gte: input.startDate } }]
        },
        select: { id: true, employeeId: true, siteId: true, validFrom: true, validTo: true, templateVersionId: true }
      });

      const employeeIds = [...new Set(intersectingAssignments.map((a) => a.employeeId))].sort();

      if (employeeIds.length > 0) {
        await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ANY(${employeeIds}::uuid[]) ORDER BY id FOR UPDATE`;
      }

      const absences =
        employeeIds.length > 0
          ? await tx.absence.findMany({
              where: {
                employeeId: { in: employeeIds },
                status: 'APPROVED',
                startDate: { lte: input.endDate },
                endDate: { gte: input.startDate }
              },
              select: { id: true, employeeId: true, startDate: true, endDate: true, type: true }
            })
          : [];

      const templateVersionIds = [
        ...new Set(intersectingAssignments.map((a) => a.templateVersionId).filter((id): id is string => id !== null))
      ];
      const templateDays =
        templateVersionIds.length > 0
          ? await tx.workScheduleTemplateVersionDay.findMany({ where: { templateVersionId: { in: templateVersionIds } } })
          : [];
      const templateDayByKey = new Map(templateDays.map((d) => [`${d.templateVersionId}:${d.weekday}`, d]));

      for (const employeeId of employeeIds) {
        await tx.payrollPeriodParticipant.create({ data: { periodId: period.id, employeeId, expected: true } });
        const timesheet = await tx.timesheet.create({ data: { employeeId, periodId: period.id, status: 'DRAFT' } });
        const draft = await tx.timesheetDraft.create({ data: { timesheetId: timesheet.id, employeeId } });

        const employeeAbsences = absences.filter((a) => a.employeeId === employeeId);

        await tx.timesheetDraftDay.createMany({
          data: dates.map((date) => {
            const overlay = employeeAbsences.find((a) => a.startDate <= date && a.endDate >= date);
            return {
              draftId: draft.id,
              date,
              dayType: overlay ? overlay.type : 'WORK',
              confirmedZero: false,
              sourceAbsenceId: overlay ? overlay.id : null
            };
          })
        });

        const plannedShiftRows: Prisma.TimesheetDraftPlannedShiftCreateManyInput[] = [];
        for (const assignment of intersectingAssignments) {
          if (assignment.employeeId !== employeeId) continue;
          for (const date of dates) {
            if (date < assignment.validFrom) continue;
            if (assignment.validTo && date > assignment.validTo) continue;

            const templateDay = assignment.templateVersionId
              ? templateDayByKey.get(`${assignment.templateVersionId}:${toTemplateWeekday(date)}`)
              : undefined;
            const isWorking = templateDay?.isWorkingDay ?? false;

            plannedShiftRows.push({
              draftId: draft.id,
              employeeId,
              date,
              siteId: assignment.siteId,
              sourceAssignmentId: assignment.id,
              templateVersionDayId: isWorking && templateDay ? templateDay.id : null,
              plannedStartAt: isWorking && templateDay?.plannedStartTime ? helsinkiWallClockToUtc(date, templateDay.plannedStartTime) : null,
              plannedEndAt: isWorking && templateDay?.plannedEndTime ? helsinkiWallClockToUtc(date, templateDay.plannedEndTime) : null,
              plannedBreakMinutes: isWorking && templateDay ? templateDay.plannedBreakMinutes : 0
            });
          }
        }
        if (plannedShiftRows.length > 0) {
          await tx.timesheetDraftPlannedShift.createMany({ data: plannedShiftRows });
        }
      }

      await createAuditEvent(tx, {
        actorUserId: input.openedByUserId,
        eventType: 'PERIOD_OPENED',
        entityType: 'PAYROLL_PERIOD',
        entityId: period.id,
        requestId: input.requestId,
        beforeValue: null,
        afterValue: { id: period.id, startDate: formatDate(period.startDate), endDate: formatDate(period.endDate), participantsCount: employeeIds.length }
      });

      return { period, participantsCount: employeeIds.length };
    });

    return {
      id: result.period.id,
      startDate: formatDate(result.period.startDate),
      endDate: formatDate(result.period.endDate),
      status: 'OPEN',
      openedByUserId: result.period.openedByUserId,
      version: result.period.version,
      createdAt: result.period.createdAt.toISOString(),
      updatedAt: result.period.updatedAt.toISOString(),
      participantsCount: result.participantsCount
    };
  } catch (error) {
    if (isPeriodOverlapViolation(error)) {
      return { code: 'PERIOD_OVERLAP' };
    }
    throw error;
  }
}

export interface PeriodListItem {
  id: string;
  startDate: string;
  endDate: string;
  status: string;
}

export async function listPeriods(): Promise<PeriodListItem[]> {
  const periods = await prisma.payrollPeriod.findMany({
    orderBy: { startDate: 'desc' },
    select: { id: true, startDate: true, endDate: true, status: true }
  });
  return periods.map((p) => ({ id: p.id, startDate: formatDate(p.startDate), endDate: formatDate(p.endDate), status: p.status }));
}

export interface PeriodDetail {
  id: string;
  startDate: string;
  endDate: string;
  status: string;
  openedByUserId: string;
  lockedAt: string | null;
  lockedByUserId: string | null;
  exportedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  participantsTotal: number;
  timesheetsFinalApproved: number;
  timesheetsPending: number;
}

/** timesheetsPending = every status other than FINAL_APPROVED — mirrors what period.lock itself requires (03_DATA_MODEL_ERD.md §4.5: "требует FINAL_APPROVED у каждого expected=true участника"), i.e. "how many are still blocking a lock". */
export async function getPeriodDetail(periodId: string): Promise<PeriodDetail | null> {
  const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
  if (!period) {
    return null;
  }

  const [participantsTotal, timesheetsFinalApproved, timesheetsPending] = await Promise.all([
    prisma.payrollPeriodParticipant.count({ where: { periodId } }),
    prisma.timesheet.count({ where: { periodId, status: 'FINAL_APPROVED' } }),
    prisma.timesheet.count({ where: { periodId, status: { not: 'FINAL_APPROVED' } } })
  ]);

  return {
    id: period.id,
    startDate: formatDate(period.startDate),
    endDate: formatDate(period.endDate),
    status: period.status,
    openedByUserId: period.openedByUserId,
    lockedAt: period.lockedAt ? period.lockedAt.toISOString() : null,
    lockedByUserId: period.lockedByUserId,
    exportedAt: period.exportedAt ? period.exportedAt.toISOString() : null,
    version: period.version,
    createdAt: period.createdAt.toISOString(),
    updatedAt: period.updatedAt.toISOString(),
    participantsTotal,
    timesheetsFinalApproved,
    timesheetsPending
  };
}

/** Several periods may be OPEN at once, but EX-03 forbids any two periods (any status) from overlapping in dates — so at most one period's range can ever contain a given calendar day. "Current" = that one, if its status is OPEN. */
export async function getCurrentPeriod(today: Date): Promise<PeriodListItem | null> {
  const period = await prisma.payrollPeriod.findFirst({
    where: { status: 'OPEN', startDate: { lte: today }, endDate: { gte: today } },
    select: { id: true, startDate: true, endDate: true, status: true }
  });
  return period ? { id: period.id, startDate: formatDate(period.startDate), endDate: formatDate(period.endDate), status: period.status } : null;
}
