import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { enumerateDates, toTemplateWeekday, computePlannedShiftForAssignmentDate } from '@/lib/periods';
import { assignWorkerSubmissionSchedule, submissionPeriodForDate } from '@/lib/timesheet-submission-schedules';
import {
  acquireEmployeeLifecycleLock,
  overlappingPrimaryWhere,
  isPrimaryPeriodConflict,
  ScheduledPrimaryConflictError,
  SiteOrCustomerUnavailableError
} from '@/lib/assignment-lock';
import { recordAssignmentTransition } from '@/lib/assignment-transitions';
import { helsinkiToday } from '@/lib/workers';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §6 (Назначения) — shared
// by POST /api/admin/assignments/validate-overlap and POST /api/admin/assignments.

export interface OverlapCheckInput {
  employeeId: string;
  siteId: string;
  workAreaId: string | null;
  validFrom: Date;
  validTo: Date | null;
  /** Excludes this assignment's own row — needed by split(), which checks the new slot before the old row (about to occupy the same site/work area, different dates) is closed. */
  excludeAssignmentId?: string;
}

export interface OverlapCheckResult {
  hasOverlap: boolean;
  conflictingAssignmentId?: string;
}

/**
 * Mirrors EX-02 (`ex_site_assignment_scope_date_overlap`,
 * 05_RAW_SQL_REGISTER.md) at the application level: same employeeId+siteId+
 * workAreaId (workAreaId: null matches null, same as the constraint's
 * COALESCE-to-zero-UUID trick), overlapping [validFrom, validTo] — treating
 * a null validTo as unbounded on both sides of the comparison.
 */
export async function checkOverlap(input: OverlapCheckInput): Promise<OverlapCheckResult> {
  const conflicting = await prisma.siteAssignment.findFirst({
    where: {
      employeeId: input.employeeId,
      siteId: input.siteId,
      workAreaId: input.workAreaId,
      ...(input.excludeAssignmentId ? { id: { not: input.excludeAssignmentId } } : {}),
      ...(input.validTo ? { validFrom: { lte: input.validTo } } : {}),
      OR: [{ validTo: null }, { validTo: { gte: input.validFrom } }]
    },
    select: { id: true }
  });

  return conflicting ? { hasOverlap: true, conflictingAssignmentId: conflicting.id } : { hasOverlap: false };
}

export interface CreateAssignmentInput {
  employeeId: string;
  siteId: string;
  workAreaId: string | null;
  templateId: string | null;
  validFrom: Date;
  validTo: Date | null;
  isPrimary: boolean;
  assignedByUserId: string;
  requestId: string;
  /** §P4 — 'REPLACE_SCHEDULED' demotes an overlapping scheduled future primary (its assignment
   *  kept, recorded); absent → a scheduled-primary overlap returns SCHEDULED_PRIMARY_CONFLICT. */
  primaryConflictResolution?: 'KEEP_SCHEDULED' | 'REPLACE_SCHEDULED';
}

export type CreateAssignmentError =
  | { code: 'EMPLOYEE_NOT_FOUND' }
  | { code: 'SITE_NOT_FOUND' }
  | { code: 'WORK_AREA_NOT_FOUND' }
  | { code: 'TEMPLATE_NOT_FOUND' }
  | { code: 'EMPLOYEE_NOT_ACTIVE' }
  | { code: 'ASSIGNMENT_OVERLAP'; conflictingAssignmentId: string }
  | { code: 'PRIMARY_PERIOD_CONFLICT' }
  | { code: 'SCHEDULED_PRIMARY_CONFLICT'; scheduledAssignmentId: string; scheduledValidFrom: string }
  // R15-D7 Deploy C (§3.13 L) — a finished site / disabled customer cannot take a new assignment
  // even by a direct API call.
  | { code: 'SITE_FINISHED' }
  | { code: 'CUSTOMER_DISABLED' };

export interface CreateAssignmentResult {
  id: string;
  employeeId: string;
  siteId: string;
  workAreaId: string | null;
  templateVersionId: string | null;
  isPrimary: boolean;
  validFrom: string;
  validTo: string | null;
  assignedByUserId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Creates one SiteAssignment row and backfills PayrollPeriodParticipant /
 * Timesheet(DRAFT) / TimesheetDraft / TimesheetDraftDay / TimesheetDraftPlannedShift for every
 * OPEN period intersecting [validFrom, validTo] — the materialisation half of createAssignment(),
 * factored out so POST /api/admin/assignments/:id/change can reuse it inside its own transaction
 * (close the old assignment + open the replacement atomically). All references must already be
 * validated by the caller. Does NOT write the AuditEvent or the AssignmentTransition — the caller
 * owns those (ASSIGNMENT_CREATED vs ASSIGNMENT_CHANGED). Returns `demotedPrimaryIds` so the caller
 * can record which prior primary assignments this create auto-demoted (§3.6, never a hidden change).
 * Throws ScheduledPrimaryConflictError when making this primary would overlap a SCHEDULED FUTURE
 * primary and `replaceScheduledPrimary` was not set (§P4).
 */
export async function createAssignmentInTx(
  tx: Prisma.TransactionClient,
  params: {
    employeeId: string;
    siteId: string;
    workAreaId: string | null;
    templateVersionId: string | null;
    validFrom: Date;
    validTo: Date | null;
    isPrimary: boolean;
    assignedByUserId: string;
    /** §P4 — when true, a scheduled future primary that overlaps the new one is demoted (its
     *  assignment kept) instead of raising ScheduledPrimaryConflictError. */
    replaceScheduledPrimary?: boolean;
  }
): Promise<{
  assignment: Prisma.SiteAssignmentGetPayload<object>;
  /** OTHER primary assignments this create auto-demoted because their period overlapped the new
   *  primary's (§3.6). Callers record one AssignmentTransition per id — never a hidden change. */
  demotedPrimaryIds: string[];
  /** The subset of demotedPrimaryIds that were a SCHEDULED FUTURE primary (validFrom > today),
   *  demoted only because `replaceScheduledPrimary` was set — its assignment is NOT cancelled. */
  demotedScheduledPrimaryIds: string[];
}> {
  // R15-D7 Deploy C (§3.13 L) — a finished site (finishedAt set / active=false) or a disabled
  // customer (active=false) never takes a new assignment, even from changeWorkplace inside a tx.
  const targetSite = await tx.workSite.findUnique({ where: { id: params.siteId }, select: { active: true, finishedAt: true } });
  if (!targetSite || targetSite.finishedAt !== null || !targetSite.active) {
    throw new SiteOrCustomerUnavailableError('SITE_FINISHED');
  }
  if (params.workAreaId !== null) {
    const targetArea = await tx.workArea.findFirst({ where: { id: params.workAreaId, siteId: params.siteId }, select: { active: true } });
    if (!targetArea || !targetArea.active) {
      throw new SiteOrCustomerUnavailableError('CUSTOMER_DISABLED');
    }
  }

  // R15-D7 Deploy D2 (§3.6) — "≤1 primary per OVERLAPPING period". Before making the new row
  // primary, demote every OTHER non-removed primary of this employee whose date range OVERLAPS the
  // new one's. A CURRENT primary and a disjoint SCHEDULED FUTURE primary stay both primary — only
  // overlapping primary periods are forbidden (ex_site_assignment_one_primary_per_period). Same
  // transaction; callers hold the per-employee advisory lock so this is race-safe.
  let demotedPrimaryIds: string[] = [];
  let demotedScheduledPrimaryIds: string[] = [];
  if (params.isPrimary) {
    const today = helsinkiToday();
    const overlapping = await tx.siteAssignment.findMany({
      where: { employeeId: params.employeeId, ...overlappingPrimaryWhere({ validFrom: params.validFrom, validTo: params.validTo }) },
      select: { id: true, validFrom: true }
    });
    const scheduled = overlapping.filter((a) => a.validFrom > today);
    if (scheduled.length > 0 && !params.replaceScheduledPrimary) {
      // §P4 — do not silently cancel a planned transfer; let the route ask the admin.
      throw new ScheduledPrimaryConflictError(scheduled[0].id, scheduled[0].validFrom);
    }
    demotedPrimaryIds = overlapping.map((a) => a.id);
    demotedScheduledPrimaryIds = scheduled.map((a) => a.id);
    if (demotedPrimaryIds.length > 0) {
      await tx.siteAssignment.updateMany({
        where: { id: { in: demotedPrimaryIds } },
        data: { isPrimary: false, version: { increment: 1 } }
      });
    }
  }

  const assignment = await tx.siteAssignment.create({
    data: {
      employeeId: params.employeeId,
      siteId: params.siteId,
      workAreaId: params.workAreaId,
      templateVersionId: params.templateVersionId,
      isPrimary: params.isPrimary,
      validFrom: params.validFrom,
      validTo: params.validTo,
      assignedByUserId: params.assignedByUserId
    }
  });

  await materializeAssignmentDraftsInTx(tx, assignment);

  return { assignment, demotedPrimaryIds, demotedScheduledPrimaryIds };
}


/**
 * Backfills PayrollPeriodParticipant / Timesheet(DRAFT) / TimesheetDraft / TimesheetDraftDay /
 * TimesheetDraftPlannedShift for every OPEN period intersecting the assignment's [validFrom, validTo]
 * — the materialisation half of createAssignmentInTx, also used when an unused assignment is
 * corrected in place (correctUnusedAssignmentInTx) after its own planned shifts were removed.
 */
export async function materializeAssignmentDraftsInTx(
  tx: Prisma.TransactionClient,
  assignment: { id: string; employeeId: string; siteId: string; templateVersionId: string | null; validFrom: Date; validTo: Date | null }
): Promise<void> {
  const openPeriodCandidates = await tx.payrollPeriod.findMany({
    where: {
      status: 'OPEN',
      endDate: { gte: assignment.validFrom },
      ...(assignment.validTo ? { startDate: { lte: assignment.validTo } } : {})
    },
    select: { id: true, startDate: true, endDate: true, submissionScheduleId: true }
  });
  const employeeScheduleWindows = await tx.employeeTimesheetSchedule.findMany({
    where: {
      employeeId: assignment.employeeId,
      effectiveFrom: { lte: assignment.validTo ?? new Date('9999-12-31T00:00:00.000Z') },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: assignment.validFrom } }]
    },
    select: { scheduleId: true, effectiveFrom: true, effectiveTo: true }
  });
  // Legacy/manual periods retain the old assignment-driven behavior. Generated periods belong
  // only to workers whose effective schedule matches that period; without this filter, adding a
  // site to one new worker would try to enroll them in every weekly/biweekly cohort currently
  // open for other employees and trip the worker-overlap invariant.
  const intersectingOpenPeriods = openPeriodCandidates.filter((period) =>
    period.submissionScheduleId === null || employeeScheduleWindows.some((window) =>
      window.scheduleId === period.submissionScheduleId && window.effectiveFrom <= period.endDate && (!window.effectiveTo || window.effectiveTo >= period.startDate)
    )
  );

  const templateDays = assignment.templateVersionId
    ? await tx.workScheduleTemplateVersionDay.findMany({ where: { templateVersionId: assignment.templateVersionId } })
    : [];
  const templateDayByWeekday = new Map(templateDays.map((d) => [d.weekday, d]));

  const absences = await tx.absence.findMany({
    where: {
      employeeId: assignment.employeeId,
      status: 'APPROVED',
      endDate: { gte: assignment.validFrom },
      ...(assignment.validTo ? { startDate: { lte: assignment.validTo } } : {})
    },
    select: { id: true, startDate: true, endDate: true, type: true }
  });

  for (const period of intersectingOpenPeriods) {
    await tx.payrollPeriodParticipant.upsert({
      where: { periodId_employeeId: { periodId: period.id, employeeId: assignment.employeeId } },
      create: { periodId: period.id, employeeId: assignment.employeeId, expected: true },
      update: {}
    });

    const timesheet = await tx.timesheet.upsert({
      where: { employeeId_periodId: { employeeId: assignment.employeeId, periodId: period.id } },
      create: { employeeId: assignment.employeeId, periodId: period.id, status: 'DRAFT' },
      update: {}
    });

    const draft = await tx.timesheetDraft.upsert({
      where: { timesheetId: timesheet.id },
      create: { timesheetId: timesheet.id, employeeId: assignment.employeeId },
      update: {}
    });

    const intersectFrom = period.startDate > assignment.validFrom ? period.startDate : assignment.validFrom;
    const intersectTo = assignment.validTo && assignment.validTo < period.endDate ? assignment.validTo : period.endDate;
    const dates = enumerateDates(intersectFrom, intersectTo);

    const existingDays = await tx.timesheetDraftDay.findMany({
      where: { draftId: draft.id, date: { in: dates } },
      select: { date: true }
    });
    const existingDayTimes = new Set(existingDays.map((d) => d.date.getTime()));
    const missingDates = dates.filter((d) => !existingDayTimes.has(d.getTime()));

    if (missingDates.length > 0) {
      await tx.timesheetDraftDay.createMany({
        data: missingDates.map((date) => {
          const overlay = absences.find((a) => a.startDate <= date && a.endDate >= date);
          return {
            draftId: draft.id,
            date,
            dayType: overlay ? overlay.type : 'WORK',
            confirmedZero: false,
            sourceAbsenceId: overlay ? overlay.id : null
          };
        })
      });
    }

    const plannedShiftRows: Prisma.TimesheetDraftPlannedShiftCreateManyInput[] = dates.map((date) => {
      const templateDay = assignment.templateVersionId ? templateDayByWeekday.get(toTemplateWeekday(date)) : undefined;
      return {
        draftId: draft.id,
        employeeId: assignment.employeeId,
        date,
        siteId: assignment.siteId,
        sourceAssignmentId: assignment.id,
        ...computePlannedShiftForAssignmentDate(templateDay, date)
      };
    });
    if (plannedShiftRows.length > 0) {
      // skipDuplicates: a reactivated assignment keeps the planned shifts its recorded hours use.
      await tx.timesheetDraftPlannedShift.createMany({ data: plannedShiftRows, skipDuplicates: true });
    }
  }
}

/**
 * Owner 2026-10-15 — "add a workplace" whose dates only clash with ONE removed assignment of the
 * same site + customer (Check-In disabled — e.g. taken off by mistake or by an earlier transfer).
 * EX-02 forbids a second row for the same scope and dates, so instead of refusing, that row is
 * brought back: Check-In re-enabled, dates widened to cover the requested range, the chosen schedule
 * and primary flag applied, unused planned shifts rebuilt. Recorded hours on it stay where they are.
 */
export async function findReactivatableAssignment(input: { employeeId: string; siteId: string; workAreaId: string | null; validFrom: Date; validTo: Date | null; excludeAssignmentId?: string }): Promise<{ id: string } | null> {
  const overlapping = await prisma.siteAssignment.findMany({
    where: {
      employeeId: input.employeeId,
      siteId: input.siteId,
      workAreaId: input.workAreaId,
      ...(input.excludeAssignmentId ? { id: { not: input.excludeAssignmentId } } : {}),
      ...(input.validTo ? { validFrom: { lte: input.validTo } } : {}),
      OR: [{ validTo: null }, { validTo: { gte: input.validFrom } }]
    },
    select: { id: true, clockInDisabledAt: true }
  });
  const now = new Date();
  if (overlapping.length !== 1 || !overlapping[0].clockInDisabledAt || overlapping[0].clockInDisabledAt > now) return null;
  return { id: overlapping[0].id };
}

export class ReactivationOverlapError extends Error {}

export async function reactivateRemovedAssignmentInTx(
  tx: Prisma.TransactionClient,
  params: { assignmentId: string; validFrom: Date; validTo: Date | null; templateVersionId: string | null; isPrimary: boolean; assignedByUserId: string; requestId: string; replaceScheduledPrimary: boolean }
) {
  const row = await tx.siteAssignment.findUniqueOrThrow({ where: { id: params.assignmentId } });
  await acquireEmployeeLifecycleLock(tx, row.employeeId);
  const validFrom = params.validFrom < row.validFrom ? params.validFrom : row.validFrom;
  const validTo = params.validTo === null || row.validTo === null ? null : params.validTo > row.validTo ? params.validTo : row.validTo;
  const others = await tx.siteAssignment.count({
    where: { id: { not: row.id }, employeeId: row.employeeId, siteId: row.siteId, workAreaId: row.workAreaId, ...(validTo ? { validFrom: { lte: validTo } } : {}), OR: [{ validTo: null }, { validTo: { gte: validFrom } }] }
  });
  if (others > 0) throw new ReactivationOverlapError();

  let demotedPrimaryIds: string[] = [];
  if (params.isPrimary) {
    const today = helsinkiToday();
    const overlapping = await tx.siteAssignment.findMany({ where: { employeeId: row.employeeId, id: { not: row.id }, ...overlappingPrimaryWhere({ validFrom, validTo }) }, select: { id: true, validFrom: true } });
    const scheduled = overlapping.filter((a) => a.validFrom > today);
    if (scheduled.length > 0 && !params.replaceScheduledPrimary) throw new ScheduledPrimaryConflictError(scheduled[0].id, scheduled[0].validFrom);
    demotedPrimaryIds = overlapping.map((a) => a.id);
    if (demotedPrimaryIds.length) await tx.siteAssignment.updateMany({ where: { id: { in: demotedPrimaryIds } }, data: { isPrimary: false, version: { increment: 1 } } });
  }

  // Planned shifts that recorded hours point at stay; the rest are rebuilt for the new range/schedule.
  await tx.timesheetDraftPlannedShift.deleteMany({ where: { sourceAssignmentId: row.id, segments: { none: {} } } });
  const assignment = await tx.siteAssignment.update({
    where: { id: row.id },
    // No schedule chosen → keep the one the assignment already had.
    data: { validFrom, validTo, templateVersionId: params.templateVersionId ?? row.templateVersionId, isPrimary: params.isPrimary, clockInDisabledAt: null, endedReason: null, version: { increment: 1 } }
  });
  await materializeAssignmentDraftsInTx(tx, assignment);

  const now = new Date();
  for (const demotedId of demotedPrimaryIds) {
    await recordAssignmentTransition(tx, { employeeId: row.employeeId, kind: 'CHANGE', fromAssignmentId: demotedId, toAssignmentId: row.id, actedAt: now, effectiveFrom: validFrom, openShiftHandling: 'NONE', actorUserId: params.assignedByUserId, reasonCode: 'OTHER', reasonText: 'auto-demoted: a removed assignment was brought back as the workplace' });
  }
  await recordAssignmentTransition(tx, { employeeId: row.employeeId, kind: 'CHANGE', fromAssignmentId: row.id, toAssignmentId: row.id, actedAt: now, effectiveFrom: validFrom, openShiftHandling: 'NONE', actorUserId: params.assignedByUserId, reasonCode: 'OTHER', reasonText: 'Возврат на объект / к заказчику' });
  await createAuditEvent(tx, {
    actorUserId: params.assignedByUserId,
    eventType: 'ASSIGNMENT_REACTIVATED',
    entityType: 'SITE_ASSIGNMENT',
    entityId: row.id,
    requestId: params.requestId,
    beforeValue: { validFrom: row.validFrom.toISOString().slice(0, 10), validTo: row.validTo ? row.validTo.toISOString().slice(0, 10) : null, clockInDisabledAt: row.clockInDisabledAt?.toISOString() ?? null, endedReason: row.endedReason, templateVersionId: row.templateVersionId, isPrimary: row.isPrimary },
    afterValue: { validFrom: validFrom.toISOString().slice(0, 10), validTo: validTo ? validTo.toISOString().slice(0, 10) : null, templateVersionId: assignment.templateVersionId, isPrimary: assignment.isPrimary, demotedPrimaryAssignmentIds: demotedPrimaryIds }
  });
  return Object.assign(assignment, { demotedPrimaryIds });
}

/**
 * Resolves and validates all references, then creates the SiteAssignment +
 * upserts PayrollPeriodParticipant/Timesheet(DRAFT)/TimesheetDraft container
 * rows for every OPEN period intersecting [validFrom, validTo] — the exact
 * scope 02_ROLE_PERMISSION_MATRIX.md's assignment.create row documents.
 *
 * Also backfills TimesheetDraftDay (one per calendar day of the
 * period∩assignment intersection, Absence(APPROVED) overlay applied the same
 * way as period.create) and TimesheetDraftPlannedShift for this one new
 * assignment across that same range — an employee assigned to a site after a
 * period is already OPEN would otherwise get a draft container with zero day
 * rows inside it, making PATCH .../days/:date unable to find anything to
 * edit (found while designing ЭТАП 7 sub-task 3b, confirmed by the owner).
 * Reuses lib/periods.ts's date/DST helpers rather than duplicating them —
 * the algorithm is identical, just scoped to one assignment instead of every
 * assignment of every participant.
 */
export async function createAssignment(
  input: CreateAssignmentInput
): Promise<CreateAssignmentResult | CreateAssignmentError> {
  const employee = await prisma.employee.findUnique({
    where: { id: input.employeeId },
    select: { employments: { orderBy: { createdAt: 'desc' }, take: 1, select: { active: true } } }
  });
  if (!employee) {
    return { code: 'EMPLOYEE_NOT_FOUND' };
  }
  if (!employee.employments[0]?.active) {
    return { code: 'EMPLOYEE_NOT_ACTIVE' };
  }

  const site = await prisma.workSite.findUnique({ where: { id: input.siteId }, select: { id: true, active: true, finishedAt: true } });
  if (!site) {
    return { code: 'SITE_NOT_FOUND' };
  }
  // §3.13 L — a finished site (finishedAt set, or active=false from the legacy D5 toggle) rejects
  // any new assignment. The server enforces it, not just the picker.
  if (site.finishedAt !== null || !site.active) {
    return { code: 'SITE_FINISHED' };
  }

  if (input.workAreaId !== null) {
    const workArea = await prisma.workArea.findFirst({ where: { id: input.workAreaId, siteId: input.siteId }, select: { id: true, active: true } });
    if (!workArea) {
      return { code: 'WORK_AREA_NOT_FOUND' };
    }
    if (!workArea.active) {
      return { code: 'CUSTOMER_DISABLED' };
    }
  }

  let templateVersionId: string | null = null;
  if (input.templateId !== null) {
    const latestVersion = await prisma.workScheduleTemplateVersion.findFirst({
      where: { templateId: input.templateId },
      orderBy: { versionNumber: 'desc' },
      select: { id: true }
    });
    if (!latestVersion) {
      return { code: 'TEMPLATE_NOT_FOUND' };
    }
    templateVersionId = latestVersion.id;
  }

  const overlap = await checkOverlap({
    employeeId: input.employeeId,
    siteId: input.siteId,
    workAreaId: input.workAreaId,
    validFrom: input.validFrom,
    validTo: input.validTo
  });
  const reactivatable = overlap.hasOverlap ? await findReactivatableAssignment(input) : null;
  if (overlap.hasOverlap && !reactivatable) {
    return { code: 'ASSIGNMENT_OVERLAP', conflictingAssignmentId: overlap.conflictingAssignmentId! };
  }

  // §P4 — 'KEEP_SCHEDULED' is the admin's answer to a prior SCHEDULED_PRIMARY_CONFLICT: keep the
  // planned transfer and make THIS assignment a non-primary one.
  const wantsPrimary = input.isPrimary && input.primaryConflictResolution !== 'KEEP_SCHEDULED';

  let created;
  try {
    created = reactivatable
      ? await prisma.$transaction((tx) => reactivateRemovedAssignmentInTx(tx, { assignmentId: reactivatable.id, validFrom: input.validFrom, validTo: input.validTo, templateVersionId, isPrimary: wantsPrimary, assignedByUserId: input.assignedByUserId, requestId: input.requestId, replaceScheduledPrimary: input.primaryConflictResolution === 'REPLACE_SCHEDULED' }))
      : await prisma.$transaction(async (tx) => {
      // R15-D7 §3.13 — serialise every writer of this worker's assignments (also held by
      // changeWorkplace / removeFromSite / promoteToPrimary), so the demote-then-create below
      // and the ex_site_assignment_one_primary_per_period constraint stay consistent under concurrency.
      await acquireEmployeeLifecycleLock(tx, input.employeeId);

      const { assignment, demotedPrimaryIds, demotedScheduledPrimaryIds } = await createAssignmentInTx(tx, {
        employeeId: input.employeeId,
        siteId: input.siteId,
        workAreaId: input.workAreaId,
        templateVersionId,
        isPrimary: wantsPrimary,
        validFrom: input.validFrom,
        validTo: input.validTo,
        assignedByUserId: input.assignedByUserId,
        replaceScheduledPrimary: input.primaryConflictResolution === 'REPLACE_SCHEDULED'
      });

      // §3.6 — an auto-demoted prior primary is a real lifecycle change, never hidden: one
      // AssignmentTransition per demoted assignment (a scheduled future primary is flagged
      // distinctly — its assignment stays, only its primary status is superseded), and the ids on
      // the create's own audit.
      const today = helsinkiToday();
      const scheduled = new Set(demotedScheduledPrimaryIds);
      for (const demotedId of demotedPrimaryIds) {
        await recordAssignmentTransition(tx, {
          employeeId: input.employeeId,
          kind: 'CHANGE',
          fromAssignmentId: demotedId,
          toAssignmentId: assignment.id,
          actedAt: new Date(),
          effectiveFrom: today,
          openShiftHandling: 'NONE',
          actorUserId: input.assignedByUserId,
          reasonCode: 'OTHER',
          reasonText: scheduled.has(demotedId)
            ? 'primary superseded — this assignment was scheduled to become the worker’s primary; the assignment itself is unchanged'
            : 'auto-demoted: a new primary assignment was created'
        });
      }

      // Same transaction as the create + period upserts above — lib/audit.ts's
      // invariant ("Действие + AuditEvent — одна транзакция") requires this.
      await createAuditEvent(tx, {
        actorUserId: input.assignedByUserId,
        eventType: 'ASSIGNMENT_CREATED',
        entityType: 'SITE_ASSIGNMENT',
        entityId: assignment.id,
        requestId: input.requestId,
        beforeValue: null,
        afterValue: {
          id: assignment.id,
          employeeId: assignment.employeeId,
          siteId: assignment.siteId,
          workAreaId: assignment.workAreaId,
          templateVersionId: assignment.templateVersionId,
          isPrimary: assignment.isPrimary,
          validFrom: assignment.validFrom.toISOString().slice(0, 10),
          validTo: assignment.validTo ? assignment.validTo.toISOString().slice(0, 10) : null,
          demotedPrimaryAssignmentIds: demotedPrimaryIds,
          demotedScheduledPrimaryAssignmentIds: demotedScheduledPrimaryIds
        }
      });

      return assignment;
    });
  } catch (error) {
    // §P4 — making this primary would overlap a scheduled future primary; the route asks the admin.
    if (error instanceof ReactivationOverlapError) {
      return { code: 'ASSIGNMENT_OVERLAP', conflictingAssignmentId: reactivatable!.id };
    }
    if (error instanceof ScheduledPrimaryConflictError) {
      return {
        code: 'SCHEDULED_PRIMARY_CONFLICT',
        scheduledAssignmentId: error.scheduledAssignmentId,
        scheduledValidFrom: error.scheduledValidFrom.toISOString().slice(0, 10)
      };
    }
    // Last-resort: a concurrent create raced past the advisory lock and the EXCLUDE constraint
    // rejected an overlapping primary period.
    if (isPrimaryPeriodConflict(error)) {
      return { code: 'PRIMARY_PERIOD_CONFLICT' };
    }
    throw error;
  }

  // A worker with a SiteAssignment but no EmployeeTimesheetSchedule ever gets a Timesheet: neither
  // this function's own OPEN-period upsert above (scoped to periods whose submissionScheduleId
  // already matches an existing schedule window) nor the horizon scheduler (which only ever looks
  // at employees who already have a schedule row) will ever produce one. This silently stranded a
  // real worker on the "Ваши периоды" screen (confirmed against a live pilot). First-ever site
  // assignment for someone with zero schedule history — past, present, or future — auto-enrolls
  // them on the company default (same cadence shown pre-selected in the admin's own "Цикл отправки
  // табеля" form), aligned to that cadence's own cycle boundary so it satisfies
  // assignWorkerSubmissionSchedule's own EFFECTIVE_FROM_NOT_BOUNDARY check. Best-effort: this only
  // ever supplements the assignment that already succeeded above, so any failure here is swallowed
  // rather than surfaced as a failure of the assignment itself. An admin who has ever made an
  // explicit schedule decision for this worker (even one since ended) is never overridden.
  const hasScheduleHistory = await prisma.employeeTimesheetSchedule.findFirst({ where: { employeeId: input.employeeId }, select: { id: true } });
  if (!hasScheduleHistory) {
    const companyDefault = await prisma.timesheetSubmissionSchedule.findFirst({
      where: { active: true, isCompanyDefault: true },
      select: { id: true, cadence: true, anchorDate: true }
    });
    if (companyDefault) {
      try {
        await assignWorkerSubmissionSchedule({
          employeeId: input.employeeId,
          scheduleId: companyDefault.id,
          effectiveFrom: submissionPeriodForDate(companyDefault, input.validFrom).startDate,
          actorUserId: input.assignedByUserId,
          requestId: input.requestId
        });
      } catch {
        // Swallowed — see comment above. The admin can still assign a schedule explicitly via
        // WorkerSubmissionScheduleForm exactly as before this change.
      }
    }
  }

  return {
    id: created.id,
    employeeId: created.employeeId,
    siteId: created.siteId,
    workAreaId: created.workAreaId,
    templateVersionId: created.templateVersionId,
    isPrimary: created.isPrimary,
    validFrom: created.validFrom.toISOString().slice(0, 10),
    validTo: created.validTo ? created.validTo.toISOString().slice(0, 10) : null,
    assignedByUserId: created.assignedByUserId,
    version: created.version,
    createdAt: created.createdAt.toISOString(),
    updatedAt: created.updatedAt.toISOString()
  };
}

/**
 * EX-02 (`ex_site_assignment_scope_date_overlap`) is a Postgres EXCLUDE
 * constraint (SQLSTATE 23P01) — Prisma has no typed P-code for it (unlike
 * P2002 for UNIQUE), so a violation surfaces as an untyped
 * PrismaClientUnknownRequestError with the real Postgres error only
 * embedded in the message text. Confirmed empirically on disposable
 * PostgreSQL 16 via a genuine concurrent-insert race (two parallel
 * requests for the same employee+site+date range) — this is the last-resort
 * safety net behind the checkOverlap() pre-check above, which alone is not
 * race-free without an advisory lock.
 */
export function isExclusionViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientUnknownRequestError &&
    error.message.includes('23P01') &&
    error.message.includes('ex_site_assignment_scope_date_overlap')
  );
}

export interface AssignmentListItem {
  id: string;
  employeeId: string;
  employeeName: string;
  siteId: string;
  siteName: string;
  workAreaId: string | null;
  workAreaName: string | null;
  templateVersionId: string | null;
  templateName: string | null;
  isPrimary: boolean;
  validFrom: string;
  validTo: string | null;
  /** Check-In disabled (removed / transferred away) — set means the assignment no longer runs. */
  clockInDisabledAt: string | null;
  version: number;
}

export interface AssignmentListResult {
  items: AssignmentListItem[];
  /** How many assignments the other view holds (current ↔ removed/ended) — for the toggle link. */
  otherViewCount?: number;
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/**
 * All assignments (past/current/future), not just currently-valid ones —
 * assignment.read.all implies full visibility, same as GET /api/admin/workers
 * listing inactive workers too. Response fields match the contract's own
 * wording ("список с employeeName, siteName, templateName, isPrimary")
 * plus ids/dates/version needed for linking and understanding validity —
 * page/pageSize only, no search/sort/filter (not called out for this
 * specific endpoint, unlike GET /api/admin/sites).
 */
/**
 * `view` (owner 2026-10-15): 'current' = running or scheduled (not removed, not past its end date) —
 * the default of /admin/assignments, so removed / ended rows (kept for hours and history, never
 * deleted) do not clutter it; 'archived' = the rest; 'all' = everything (the API's default).
 */
function assignmentViewWhere(view: 'all' | 'current' | 'archived'): Prisma.SiteAssignmentWhereInput {
  if (view === 'all') return {};
  const now = new Date();
  const today = helsinkiToday();
  const current: Prisma.SiteAssignmentWhereInput = {
    AND: [{ OR: [{ clockInDisabledAt: null }, { clockInDisabledAt: { gt: now } }] }, { OR: [{ validTo: null }, { validTo: { gte: today } }] }]
  };
  return view === 'current' ? current : { NOT: current };
}

export async function listAssignments(page: number, pageSize: number, view: 'all' | 'current' | 'archived' = 'all'): Promise<AssignmentListResult> {
  const where = assignmentViewWhere(view);
  const [totalItems, otherViewCount, assignments] = await Promise.all([
    prisma.siteAssignment.count({ where }),
    view === 'all' ? Promise.resolve(undefined) : prisma.siteAssignment.count({ where: assignmentViewWhere(view === 'current' ? 'archived' : 'current') }),
    prisma.siteAssignment.findMany({
      where,
      orderBy: { validFrom: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        isPrimary: true,
        validFrom: true,
        validTo: true,
        clockInDisabledAt: true,
        version: true,
        employee: { select: { id: true, firstName: true, lastName: true } },
        site: { select: { id: true, name: true } },
        workArea: { select: { id: true, name: true } },
        templateVersion: { select: { id: true, template: { select: { name: true } } } }
      }
    })
  ]);

  const items: AssignmentListItem[] = assignments.map((assignment) => ({
    id: assignment.id,
    employeeId: assignment.employee.id,
    employeeName: `${assignment.employee.firstName} ${assignment.employee.lastName}`,
    siteId: assignment.site.id,
    siteName: assignment.site.name,
    workAreaId: assignment.workArea?.id ?? null,
    workAreaName: assignment.workArea?.name ?? null,
    templateVersionId: assignment.templateVersion?.id ?? null,
    templateName: assignment.templateVersion?.template.name ?? null,
    isPrimary: assignment.isPrimary,
    validFrom: assignment.validFrom.toISOString().slice(0, 10),
    validTo: assignment.validTo ? assignment.validTo.toISOString().slice(0, 10) : null,
    clockInDisabledAt: assignment.clockInDisabledAt?.toISOString() ?? null,
    version: assignment.version
  }));

  return {
    items,
    otherViewCount,
    page,
    pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / pageSize)
  };
}
