import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { helsinkiWallClockToUtc, toTemplateWeekday } from '@/lib/periods';
import { helsinkiCalendarDateAsUtcMidnight, resolveTimesheetForInstant } from '@/lib/attendance-clock';
import { materializeClockShiftCore } from '@/lib/attendance-materializer';
import { AUTO_CLOSE_REASON } from '@/lib/attendance-abandoned-shift-annotate';

export { AUTO_CLOSE_REASON, annotateAutoClosedShiftWithLateCheckOut } from '@/lib/attendance-abandoned-shift-annotate';

// Auto-close an abandoned shift (owner ask 2026-08-28). A scheduler pass closes an EmployeeOpenShift
// that has been open longer than CompanyAttendancePolicy.maxShiftDurationHours with no check-out:
//   - end time = that day's planned end from the worker's schedule template (helsinki wall clock),
//     falling back to openedAt + autoCloseShiftFallbackHours when the template has no usable end;
//     always capped at openedAt + maxShiftDurationHours.
//   - creates a frozen ClockShift (forceClosed* = SYSTEM, endAtProvisional = true, checkOutEventId
//     NULL — the ck_clock_shift_close_mechanism "force-closed" branch), deletes the open shift,
//     materializes inline (same as Check Out), and raises one OPEN SHIFT_AUTO_CLOSED_MAX_DURATION.
//
// Two-phase, same shape as lib/attendance-auto-submit.ts: a cheap unlocked scan, then one
// independent transaction per shift — one shift's failure never rolls back another's.
//
// A real Check Out that arrives BEFORE the pass runs closes the shift normally (EmployeeOpenShift
// still alive). One arriving AFTER lands as CHECKOUT_WITHOUT_OPEN_SHIFT and additionally stamps the
// real time onto the still-open SHIFT_AUTO_CLOSED_MAX_DURATION exception's detail
// (annotateAutoClosedShiftWithLateCheckOut, called from the Check Out orphan branches) so the admin
// reconciles against the true time. The ClockShift itself is immutable (fn_clock_shift_immutable),
// so the estimate is corrected on the timesheet, not on the shift.

export interface AutoCloseEndAtInput {
  openedAt: Date;
  maxShiftDurationHours: number;
  fallbackHours: number;
  /** The template day's plannedEndTime as a @db.Time(0) Date (epoch date, time-of-day meaningful),
   *  or null when the assignment has no template / that weekday is a day off / no planned end. */
  templateEndTime: Date | null;
}

export interface AutoCloseEndAt {
  endAt: Date;
  source: 'TEMPLATE' | 'FALLBACK';
}

/** Pure. The single place the end-time precedence (template planned end → fallback duration → hard
 *  cap at maxShiftDurationHours) is decided. */
export function resolveAutoCloseEndAt(input: AutoCloseEndAtInput): AutoCloseEndAt {
  const openedMs = input.openedAt.getTime();
  const capMs = openedMs + Math.max(1, Math.round(input.maxShiftDurationHours)) * 3_600_000;

  if (input.templateEndTime) {
    const helsinkiDay = helsinkiCalendarDateAsUtcMidnight(input.openedAt);
    const plannedEnd = helsinkiWallClockToUtc(helsinkiDay, input.templateEndTime).getTime();
    if (plannedEnd > openedMs && plannedEnd <= capMs) {
      return { endAt: new Date(plannedEnd), source: 'TEMPLATE' };
    }
  }

  const fallbackHours = Math.min(
    Math.max(1, Math.round(input.fallbackHours)),
    Math.max(1, Math.round(input.maxShiftDurationHours))
  );
  return { endAt: new Date(Math.min(openedMs + fallbackHours * 3_600_000, capMs)), source: 'FALLBACK' };
}

// ---------------------------------------------------------------------------------------------
// SYSTEM actor — §13, same fail-closed shape check duplicated across every SYSTEM-attributed
// mutation in this codebase (deliberately re-validated each time, never cached across ticks).
// ---------------------------------------------------------------------------------------------

async function resolveSystemActorId(tx: Prisma.TransactionClient): Promise<string> {
  const systemActor = await tx.user.findFirst({
    where: { userKind: 'SYSTEM', username: 'system.scheduler' },
    select: { id: true, status: true, passwordHash: true, employeeId: true }
  });
  if (!systemActor || systemActor.status !== 'DEACTIVATED' || systemActor.passwordHash !== null || systemActor.employeeId !== null) {
    throw new Error('SYSTEM_SCHEDULER_ACTOR_MISSING_OR_INVALID');
  }
  return systemActor.id;
}

async function resolveTemplateEndTime(tx: Prisma.TransactionClient, sourceAssignmentId: string | null, openedAt: Date): Promise<Date | null> {
  if (!sourceAssignmentId) return null;
  const assignment = await tx.siteAssignment.findUnique({ where: { id: sourceAssignmentId }, select: { templateVersionId: true } });
  if (!assignment?.templateVersionId) return null;
  const day = await tx.workScheduleTemplateVersionDay.findUnique({
    where: { templateVersionId_weekday: { templateVersionId: assignment.templateVersionId, weekday: toTemplateWeekday(helsinkiCalendarDateAsUtcMidnight(openedAt)) } },
    select: { isWorkingDay: true, plannedEndTime: true }
  });
  return day?.isWorkingDay && day.plannedEndTime ? day.plannedEndTime : null;
}

// ---------------------------------------------------------------------------------------------
// The pass.
// ---------------------------------------------------------------------------------------------

export interface AbandonedShiftAutoCloseTickResult {
  scanned: number;
  closed: number;
  closedFromTemplate: number;
  closedFromFallback: number;
  skippedNoLongerEligible: number;
  failed: number;
  failedEmployeeIds: string[];
}

export interface AbandonedShiftAutoCloseTickInput {
  /** Injectable for tests; production always passes real system time. */
  now: Date;
}

interface OpenShiftScanRow {
  employeeId: string;
  openedByClockEventId: string;
  siteId: string;
  workAreaId: string | null;
  sourceAssignmentId: string | null;
  openedAt: Date;
}

export async function runAbandonedShiftAutoCloseTick(input: AbandonedShiftAutoCloseTickInput): Promise<AbandonedShiftAutoCloseTickResult> {
  const { now } = input;
  const requestId = randomUUID();

  const policy = await prisma.companyAttendancePolicy.findUniqueOrThrow({
    where: { singleton: true },
    select: { maxShiftDurationHours: true, autoCloseShiftFallbackHours: true }
  });
  const maxDurationMs = policy.maxShiftDurationHours * 3_600_000;
  const cutoff = new Date(now.getTime() - maxDurationMs);

  const candidates = await prisma.$queryRaw<OpenShiftScanRow[]>`
    SELECT "employeeId", "openedByClockEventId", "siteId", "workAreaId", "sourceAssignmentId", "openedAt"
    FROM "EmployeeOpenShift"
    WHERE "openedAt" <= ${cutoff}
    ORDER BY "openedAt" ASC
  `;

  const result: AbandonedShiftAutoCloseTickResult = {
    scanned: candidates.length,
    closed: 0,
    closedFromTemplate: 0,
    closedFromFallback: 0,
    skippedNoLongerEligible: 0,
    failed: 0,
    failedEmployeeIds: []
  };

  for (const candidate of candidates) {
    try {
      const outcome = await prisma.$transaction(async (tx) => {
        // Canonical order (§8.1): Employee(1) → EmployeeOpenShift(3) → ClockShift(new).
        await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${candidate.employeeId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT "employeeId" FROM "EmployeeOpenShift" WHERE "employeeId" = ${candidate.employeeId}::uuid FOR UPDATE`;
        const openShift = await tx.employeeOpenShift.findUnique({ where: { employeeId: candidate.employeeId } });

        // Re-check under lock — a real Check Out (or a prior tick) may have closed it since the scan,
        // or the same row may have been re-opened by a newer check-in.
        if (
          !openShift ||
          openShift.openedByClockEventId !== candidate.openedByClockEventId ||
          openShift.openedAt.getTime() > now.getTime() - maxDurationMs
        ) {
          return { kind: 'SKIPPED' as const };
        }

        const templateEndTime = await resolveTemplateEndTime(tx, openShift.sourceAssignmentId, openShift.openedAt);
        const { endAt, source } = resolveAutoCloseEndAt({
          openedAt: openShift.openedAt,
          maxShiftDurationHours: policy.maxShiftDurationHours,
          fallbackHours: policy.autoCloseShiftFallbackHours,
          templateEndTime
        });

        const systemActorId = await resolveSystemActorId(tx);
        const closedAt = new Date();

        const clockShift = await tx.clockShift.create({
          data: {
            employeeId: openShift.employeeId,
            checkInEventId: openShift.openedByClockEventId,
            checkOutEventId: null,
            siteId: openShift.siteId,
            workAreaId: openShift.workAreaId,
            sourceAssignmentId: openShift.sourceAssignmentId,
            recordedStartAt: openShift.openedAt,
            recordedEndAt: endAt,
            endAtProvisional: true,
            forceClosedByUserId: systemActorId,
            forceClosedReason: AUTO_CLOSE_REASON,
            forceClosedAt: closedAt,
            materializationState: 'PENDING'
          }
        });

        await tx.employeeOpenShift.delete({ where: { employeeId: openShift.employeeId } });

        const { timesheetId, payrollPeriodId } = await resolveTimesheetForInstant(tx, openShift.employeeId, openShift.openedAt);
        await tx.$queryRaw`
          INSERT INTO "AttendanceException" (id, type, "employeeId", "timesheetId", "payrollPeriodId", "siteId", "clockEventId", "clockShiftId", "occurredAt", status, detail)
          VALUES (
            gen_random_uuid(), 'SHIFT_AUTO_CLOSED_MAX_DURATION'::"AttendanceExceptionType",
            ${openShift.employeeId}::uuid, ${timesheetId}::uuid, ${payrollPeriodId}::uuid, ${openShift.siteId}::uuid,
            ${openShift.openedByClockEventId}::uuid, ${clockShift.id}::uuid, ${openShift.openedAt},
            'OPEN'::"AttendanceExceptionStatus",
            ${JSON.stringify({ openedAt: openShift.openedAt.toISOString(), recordedEndAt: endAt.toISOString(), endSource: source, thresholdHours: policy.maxShiftDurationHours })}::jsonb
          )
          ON CONFLICT ("clockEventId") WHERE type = 'SHIFT_AUTO_CLOSED_MAX_DURATION' AND "clockEventId" IS NOT NULL
          DO NOTHING
        `;

        // Canonical order: ClockShift lock (position after the new row) before materialize core.
        await tx.$queryRaw`SELECT id FROM "ClockShift" WHERE id = ${clockShift.id}::uuid FOR UPDATE`;
        if (openShift.sourceAssignmentId !== null) {
          await materializeClockShiftCore(tx, clockShift.id, requestId);
        }

        await createAuditEvent(tx, {
          actorUserId: systemActorId,
          eventType: 'CLOCK_SHIFT_AUTO_CLOSED',
          entityType: 'CLOCK_SHIFT',
          entityId: clockShift.id,
          requestId,
          beforeValue: { openShiftEmployeeId: openShift.employeeId, openedAt: openShift.openedAt.toISOString() },
          afterValue: {
            clockShiftId: clockShift.id,
            checkInEventId: openShift.openedByClockEventId,
            recordedStartAt: openShift.openedAt.toISOString(),
            recordedEndAt: endAt.toISOString(),
            endSource: source,
            endAtProvisional: true,
            thresholdHours: policy.maxShiftDurationHours
          },
          reason: AUTO_CLOSE_REASON
        });

        return { kind: 'CLOSED' as const, source };
      });

      if (outcome.kind === 'SKIPPED') {
        result.skippedNoLongerEligible += 1;
      } else {
        result.closed += 1;
        if (outcome.source === 'TEMPLATE') result.closedFromTemplate += 1;
        else result.closedFromFallback += 1;
      }
    } catch {
      result.failed += 1;
      result.failedEmployeeIds.push(candidate.employeeId);
    }
  }

  return result;
}
