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

export interface TemplateDayInput {
  id: string;
  isWorkingDay: boolean;
  plannedStartTime: Date | null;
  plannedEndTime: Date | null;
  plannedBreakMinutes: number;
}

export interface PlannedShiftComputation {
  templateVersionDayId: string | null;
  plannedStartAt: Date | null;
  plannedEndAt: Date | null;
  plannedBreakMinutes: number;
}

/**
 * docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §15 п.5 — the single weekday/DST/Helsinki
 * wall-clock/working-day/null-template formula for one (assignment, date) pair, previously
 * duplicated between `createPeriod` and `createAssignment`. `templateDay` is the caller-resolved
 * `WorkScheduleTemplateVersionDay` row for this date's weekday (or `undefined`/`null` when the
 * assignment has no template, or the template has no row for that weekday) — resolving which row
 * that is stays the caller's job, since `createPeriod` looks it up across many assignments/
 * template versions at once while `createAssignment` looks it up for a single template version;
 * only the pure "what does this templateDay mean for this date" formula is shared here. The
 * attendance materializer (§9.4) calls this same function rather than reimplementing the formula.
 */
export function computePlannedShiftForAssignmentDate(templateDay: TemplateDayInput | null | undefined, date: Date): PlannedShiftComputation {
  const isWorking = templateDay?.isWorkingDay ?? false;
  return {
    templateVersionDayId: isWorking && templateDay ? templateDay.id : null,
    plannedStartAt: isWorking && templateDay?.plannedStartTime ? helsinkiWallClockToUtc(date, templateDay.plannedStartTime) : null,
    plannedEndAt: isWorking && templateDay?.plannedEndTime ? helsinkiWallClockToUtc(date, templateDay.plannedEndTime) : null,
    plannedBreakMinutes: isWorking && templateDay ? templateDay.plannedBreakMinutes : 0
  };
}

/** Legacy/manual period creation can now fail either on the retired company-wide EX-03 while
 * running against an older schema, or on the worker-scoped overlap trigger introduced by T9.
 * Match only the exact SQLSTATE/constraint or stable trigger identifier. */
export function isPeriodOverlapViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientUnknownRequestError &&
    ((error.message.includes('23P01') && error.message.includes('ex_payroll_period_date_overlap')) ||
      (error.message.includes('P0001') && error.message.includes('PAYROLL_PERIOD_PARTICIPANT_DATE_OVERLAP')))
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
 * Adds one worker to an already-created period and creates the editable draft
 * projection for every calendar day. This is the worker-scoped counterpart of
 * legacy createPeriod(), used by weekly/biweekly schedule generation.
 *
 * The caller must hold the Employee row lock. Repeated calls are safe: an
 * existing participant/timesheet is returned unchanged and only missing day /
 * planned-shift rows are inserted.
 */
export async function ensureEmployeePeriodCore(
  tx: Prisma.TransactionClient,
  input: { periodId: string; employeeId: string; startDate: Date; endDate: Date }
): Promise<{ timesheetId: string }> {
  await tx.payrollPeriodParticipant.upsert({
    where: { periodId_employeeId: { periodId: input.periodId, employeeId: input.employeeId } },
    create: { periodId: input.periodId, employeeId: input.employeeId, expected: true },
    update: {}
  });

  const timesheet = await tx.timesheet.upsert({
    where: { employeeId_periodId: { employeeId: input.employeeId, periodId: input.periodId } },
    create: { employeeId: input.employeeId, periodId: input.periodId, status: 'DRAFT' },
    update: {},
    select: { id: true }
  });
  const draft = await tx.timesheetDraft.upsert({
    where: { timesheetId: timesheet.id },
    create: { timesheetId: timesheet.id, employeeId: input.employeeId },
    update: {},
    select: { id: true }
  });

  const dates = enumerateDates(input.startDate, input.endDate);
  const [assignments, absences, existingDays] = await Promise.all([
    tx.siteAssignment.findMany({
      where: {
        employeeId: input.employeeId,
        validFrom: { lte: input.endDate },
        OR: [{ validTo: null }, { validTo: { gte: input.startDate } }]
      },
      select: { id: true, siteId: true, validFrom: true, validTo: true, templateVersionId: true }
    }),
    tx.absence.findMany({
      where: {
        employeeId: input.employeeId,
        status: 'APPROVED',
        startDate: { lte: input.endDate },
        endDate: { gte: input.startDate }
      },
      select: { id: true, startDate: true, endDate: true, type: true }
    }),
    tx.timesheetDraftDay.findMany({ where: { draftId: draft.id }, select: { date: true } })
  ]);

  const existingDateKeys = new Set(existingDays.map((day) => formatDate(day.date)));
  const missingDates = dates.filter((date) => !existingDateKeys.has(formatDate(date)));
  if (missingDates.length > 0) {
    await tx.timesheetDraftDay.createMany({
      data: missingDates.map((date) => {
        const overlay = absences.find((absence) => absence.startDate <= date && absence.endDate >= date);
        return {
          draftId: draft.id,
          date,
          dayType: overlay ? overlay.type : 'WORK',
          confirmedZero: false,
          sourceAbsenceId: overlay ? overlay.id : null
        };
      }),
      skipDuplicates: true
    });
  }

  const templateVersionIds = [...new Set(assignments.map((a) => a.templateVersionId).filter((id): id is string => id !== null))];
  const templateDays = templateVersionIds.length
    ? await tx.workScheduleTemplateVersionDay.findMany({ where: { templateVersionId: { in: templateVersionIds } } })
    : [];
  const templateDayByKey = new Map(templateDays.map((day) => [`${day.templateVersionId}:${day.weekday}`, day]));
  const plannedRows: Prisma.TimesheetDraftPlannedShiftCreateManyInput[] = [];
  for (const assignment of assignments) {
    for (const date of dates) {
      if (date < assignment.validFrom || (assignment.validTo && date > assignment.validTo)) continue;
      const templateDay = assignment.templateVersionId
        ? templateDayByKey.get(`${assignment.templateVersionId}:${toTemplateWeekday(date)}`)
        : undefined;
      plannedRows.push({
        draftId: draft.id,
        employeeId: input.employeeId,
        date,
        siteId: assignment.siteId,
        sourceAssignmentId: assignment.id,
        ...computePlannedShiftForAssignmentDate(templateDay, date)
      });
    }
  }
  if (plannedRows.length > 0) {
    await tx.timesheetDraftPlannedShift.createMany({ data: plannedRows, skipDuplicates: true });
  }

  return { timesheetId: timesheet.id };
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

            plannedShiftRows.push({
              draftId: draft.id,
              employeeId,
              date,
              siteId: assignment.siteId,
              sourceAssignmentId: assignment.id,
              ...computePlannedShiftForAssignmentDate(templateDay, date)
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
  submissionSchedule: { name: string; cadence: string } | null;
  participantsCount: number;
}

export async function listPeriods(): Promise<PeriodListItem[]> {
  const periods = await prisma.payrollPeriod.findMany({
    orderBy: { startDate: 'desc' },
    select: { id: true, startDate: true, endDate: true, status: true, submissionSchedule: { select: { name: true, cadence: true } }, _count: { select: { participants: true } } }
  });
  return periods.map((p) => ({ id: p.id, startDate: formatDate(p.startDate), endDate: formatDate(p.endDate), status: p.status, submissionSchedule: p.submissionSchedule, participantsCount: p._count.participants }));
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
  submissionScheduleId: string | null;
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
    ,submissionScheduleId: period.submissionScheduleId
  };
}

export type UpdateLegacyPeriodResult =
  | { ok: true; id: string; startDate: string; endDate: string; version: number }
  | { ok: false; code: 'PERIOD_NOT_FOUND' | 'NOT_LEGACY_OPEN_PERIOD' | 'VERSION_CONFLICT' | 'DATA_OUTSIDE_RANGE' | 'PERIOD_OVERLAP' };

/** Guarded correction for the old manually-created OPEN periods which predate submission
 * schedules. Submitted/versioned periods are immutable; a shrink is allowed only when every
 * durable segment/fragment remains inside the new range. */
export async function updateLegacyOpenPeriod(input: {
  periodId: string;
  startDate: Date;
  endDate: Date;
  version: number;
  actorUserId: string;
  requestId: string;
}): Promise<UpdateLegacyPeriodResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PayrollPeriod" WHERE id = ${input.periodId}::uuid FOR UPDATE`;
      const period = await tx.payrollPeriod.findUnique({
        where: { id: input.periodId },
        include: { participants: { where: { expected: true }, select: { employeeId: true } } }
      });
      if (!period) return { ok: false, code: 'PERIOD_NOT_FOUND' } as const;
      if (period.version !== input.version) return { ok: false, code: 'VERSION_CONFLICT' } as const;
      if (period.status !== 'OPEN' || period.submissionScheduleId !== null) return { ok: false, code: 'NOT_LEGACY_OPEN_PERIOD' } as const;

      const employeeIds = period.participants.map((participant) => participant.employeeId).sort();
      if (employeeIds.length) {
        await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ANY(${employeeIds}::uuid[]) ORDER BY id FOR UPDATE`;
      }
      const [nonDraftTimesheets, versions, outsideSegments, outsideFragments] = await Promise.all([
        tx.timesheet.count({ where: { periodId: period.id, status: { notIn: ['DRAFT', 'RETURNED'] } } }),
        tx.timesheetVersion.count({ where: { timesheet: { periodId: period.id } } }),
        tx.timesheetDraftSegment.count({
          where: { draft: { timesheet: { periodId: period.id } }, OR: [{ date: { lt: input.startDate } }, { date: { gt: input.endDate } }] }
        }),
        tx.clockShiftFragment.count({
          where: { payrollPeriodId: period.id, OR: [{ date: { lt: input.startDate } }, { date: { gt: input.endDate } }] }
        })
      ]);
      if (nonDraftTimesheets || versions || outsideSegments || outsideFragments) {
        return { ok: false, code: 'DATA_OUTSIDE_RANGE' } as const;
      }

      const drafts = await tx.timesheetDraft.findMany({
        where: { timesheet: { periodId: period.id } },
        select: { id: true }
      });
      const draftIds = drafts.map((draft) => draft.id);
      if (draftIds.length) {
        await tx.timesheetDraftPlannedShift.deleteMany({
          where: { draftId: { in: draftIds }, OR: [{ date: { lt: input.startDate } }, { date: { gt: input.endDate } }] }
        });
        await tx.timesheetDraftDay.deleteMany({
          where: { draftId: { in: draftIds }, OR: [{ date: { lt: input.startDate } }, { date: { gt: input.endDate } }] }
        });
      }

      const updated = await tx.payrollPeriod.update({
        where: { id: period.id },
        data: { startDate: input.startDate, endDate: input.endDate, version: { increment: 1 } }
      });
      for (const employeeId of employeeIds) {
        await ensureEmployeePeriodCore(tx, { periodId: period.id, employeeId, startDate: input.startDate, endDate: input.endDate });
      }
      await createAuditEvent(tx, {
        actorUserId: input.actorUserId,
        eventType: 'LEGACY_PAYROLL_PERIOD_UPDATED',
        entityType: 'PAYROLL_PERIOD',
        entityId: period.id,
        requestId: input.requestId,
        beforeValue: { startDate: formatDate(period.startDate), endDate: formatDate(period.endDate), version: period.version },
        afterValue: { startDate: formatDate(updated.startDate), endDate: formatDate(updated.endDate), version: updated.version }
      });
      return { ok: true, id: updated.id, startDate: formatDate(updated.startDate), endDate: formatDate(updated.endDate), version: updated.version } as const;
    });
  } catch (error) {
    if (isPeriodOverlapViolation(error)) return { ok: false, code: 'PERIOD_OVERLAP' };
    throw error;
  }
}

/** Compatibility helper for screens that still expect one current period. With worker-scoped
 * schedules several cohorts may contain today, so this deliberately returns the earliest stable
 * match. Cohort-aware screens (notably the operational overview) query all current periods. */
export async function getCurrentPeriod(today: Date): Promise<PeriodListItem | null> {
  const period = await prisma.payrollPeriod.findFirst({
    where: { status: 'OPEN', startDate: { lte: today }, endDate: { gte: today } },
    orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
    select: { id: true, startDate: true, endDate: true, status: true, submissionSchedule: { select: { name: true, cadence: true } }, _count: { select: { participants: true } } }
  });
  return period ? { id: period.id, startDate: formatDate(period.startDate), endDate: formatDate(period.endDate), status: period.status, submissionSchedule: period.submissionSchedule, participantsCount: period._count.participants } : null;
}

export interface LockBlocker {
  employeeId: string;
  employeeName: string;
  timesheetId: string | null;
  status: string | null;
}

export type LockPeriodError =
  | { code: 'NOT_FOUND' }
  | { code: 'INVALID_STATE_TRANSITION' }
  | { code: 'NOT_ALL_FINAL_APPROVED'; blockers: LockBlocker[] };

export interface LockPeriodResult {
  id: string;
  status: 'LOCKED';
  lockedAt: string;
  lockedByUserId: string;
}

/**
 * `period.lock` has no override (03_DATA_MODEL_ERD.md §4.5, 02_ROLE_PERMISSION_MATRIX.md §2.7):
 * every PayrollPeriodParticipant(expected=true) must have a Timesheet at FINAL_APPROVED. Row-locks
 * the period first, re-checks status after the lock (TOCTOU-safe against a concurrent
 * final-approve/return finishing between the initial read and the lock), same two-phase pattern as
 * lib/admin-timesheets.ts's returnTimesheetOverride.
 */
export async function lockPeriod(periodId: string, actorUserId: string, requestId: string): Promise<LockPeriodResult | LockPeriodError> {
  const existing = await prisma.payrollPeriod.findUnique({ where: { id: periodId }, select: { status: true } });
  if (!existing) {
    return { code: 'NOT_FOUND' };
  }
  if (existing.status !== 'OPEN') {
    return { code: 'INVALID_STATE_TRANSITION' };
  }

  const lockedAt = new Date();

  const outcome = await prisma.$transaction(async (tx): Promise<'LOCKED' | 'STALE' | { code: 'NOT_ALL_FINAL_APPROVED'; blockers: LockBlocker[] }> => {
    await tx.$queryRaw`SELECT id FROM "PayrollPeriod" WHERE id = ${periodId}::uuid FOR UPDATE`;
    const fresh = await tx.payrollPeriod.findUniqueOrThrow({ where: { id: periodId }, select: { status: true } });
    if (fresh.status !== 'OPEN') {
      return 'STALE';
    }

    const participants = await tx.payrollPeriodParticipant.findMany({
      where: { periodId, expected: true },
      select: {
        employeeId: true,
        employee: { select: { firstName: true, lastName: true } },
        timesheets: { select: { id: true, status: true } }
      }
    });

    const blockers: LockBlocker[] = participants
      .filter((p) => p.timesheets[0]?.status !== 'FINAL_APPROVED')
      .map((p) => ({
        employeeId: p.employeeId,
        employeeName: `${p.employee.firstName} ${p.employee.lastName}`,
        timesheetId: p.timesheets[0]?.id ?? null,
        status: p.timesheets[0]?.status ?? null
      }));

    if (blockers.length > 0) {
      return { code: 'NOT_ALL_FINAL_APPROVED', blockers };
    }

    await tx.payrollPeriod.update({ where: { id: periodId }, data: { status: 'LOCKED', lockedAt, lockedByUserId: actorUserId } });

    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'PERIOD_LOCKED',
      entityType: 'PAYROLL_PERIOD',
      entityId: periodId,
      requestId,
      beforeValue: { status: 'OPEN' },
      afterValue: { status: 'LOCKED', lockedAt: lockedAt.toISOString(), lockedByUserId: actorUserId }
    });

    return 'LOCKED';
  });

  if (outcome === 'STALE') {
    return { code: 'INVALID_STATE_TRANSITION' };
  }
  if (typeof outcome === 'object') {
    return outcome;
  }

  return { id: periodId, status: 'LOCKED', lockedAt: lockedAt.toISOString(), lockedByUserId: actorUserId };
}
