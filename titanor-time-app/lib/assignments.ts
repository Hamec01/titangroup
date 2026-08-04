import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { enumerateDates, toTemplateWeekday, helsinkiWallClockToUtc } from '@/lib/periods';

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
}

export type CreateAssignmentError =
  | { code: 'EMPLOYEE_NOT_FOUND' }
  | { code: 'SITE_NOT_FOUND' }
  | { code: 'WORK_AREA_NOT_FOUND' }
  | { code: 'TEMPLATE_NOT_FOUND' }
  | { code: 'EMPLOYEE_NOT_ACTIVE' }
  | { code: 'ASSIGNMENT_OVERLAP'; conflictingAssignmentId: string };

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

  const site = await prisma.workSite.findUnique({ where: { id: input.siteId }, select: { id: true } });
  if (!site) {
    return { code: 'SITE_NOT_FOUND' };
  }

  if (input.workAreaId !== null) {
    const workArea = await prisma.workArea.findFirst({ where: { id: input.workAreaId, siteId: input.siteId }, select: { id: true } });
    if (!workArea) {
      return { code: 'WORK_AREA_NOT_FOUND' };
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
  if (overlap.hasOverlap) {
    return { code: 'ASSIGNMENT_OVERLAP', conflictingAssignmentId: overlap.conflictingAssignmentId! };
  }

  const created = await prisma.$transaction(async (tx) => {
    const assignment = await tx.siteAssignment.create({
      data: {
        employeeId: input.employeeId,
        siteId: input.siteId,
        workAreaId: input.workAreaId,
        templateVersionId,
        isPrimary: input.isPrimary,
        validFrom: input.validFrom,
        validTo: input.validTo,
        assignedByUserId: input.assignedByUserId
      }
    });

    const intersectingOpenPeriods = await tx.payrollPeriod.findMany({
      where: {
        status: 'OPEN',
        endDate: { gte: input.validFrom },
        ...(input.validTo ? { startDate: { lte: input.validTo } } : {})
      },
      select: { id: true, startDate: true, endDate: true }
    });

    const templateDays = templateVersionId
      ? await tx.workScheduleTemplateVersionDay.findMany({ where: { templateVersionId } })
      : [];
    const templateDayByWeekday = new Map(templateDays.map((d) => [d.weekday, d]));

    const absences = await tx.absence.findMany({
      where: {
        employeeId: input.employeeId,
        status: 'APPROVED',
        endDate: { gte: input.validFrom },
        ...(input.validTo ? { startDate: { lte: input.validTo } } : {})
      },
      select: { id: true, startDate: true, endDate: true, type: true }
    });

    for (const period of intersectingOpenPeriods) {
      await tx.payrollPeriodParticipant.upsert({
        where: { periodId_employeeId: { periodId: period.id, employeeId: input.employeeId } },
        create: { periodId: period.id, employeeId: input.employeeId, expected: true },
        update: {}
      });

      const timesheet = await tx.timesheet.upsert({
        where: { employeeId_periodId: { employeeId: input.employeeId, periodId: period.id } },
        create: { employeeId: input.employeeId, periodId: period.id, status: 'DRAFT' },
        update: {}
      });

      const draft = await tx.timesheetDraft.upsert({
        where: { timesheetId: timesheet.id },
        create: { timesheetId: timesheet.id, employeeId: input.employeeId },
        update: {}
      });

      const intersectFrom = period.startDate > input.validFrom ? period.startDate : input.validFrom;
      const intersectTo = input.validTo && input.validTo < period.endDate ? input.validTo : period.endDate;
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
        const templateDay = templateVersionId ? templateDayByWeekday.get(toTemplateWeekday(date)) : undefined;
        const isWorking = templateDay?.isWorkingDay ?? false;
        return {
          draftId: draft.id,
          employeeId: input.employeeId,
          date,
          siteId: input.siteId,
          sourceAssignmentId: assignment.id,
          templateVersionDayId: isWorking && templateDay ? templateDay.id : null,
          plannedStartAt: isWorking && templateDay?.plannedStartTime ? helsinkiWallClockToUtc(date, templateDay.plannedStartTime) : null,
          plannedEndAt: isWorking && templateDay?.plannedEndTime ? helsinkiWallClockToUtc(date, templateDay.plannedEndTime) : null,
          plannedBreakMinutes: isWorking && templateDay ? templateDay.plannedBreakMinutes : 0
        };
      });
      if (plannedShiftRows.length > 0) {
        await tx.timesheetDraftPlannedShift.createMany({ data: plannedShiftRows });
      }
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
        validTo: assignment.validTo ? assignment.validTo.toISOString().slice(0, 10) : null
      }
    });

    return assignment;
  });

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
  version: number;
}

export interface AssignmentListResult {
  items: AssignmentListItem[];
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
export async function listAssignments(page: number, pageSize: number): Promise<AssignmentListResult> {
  const [totalItems, assignments] = await Promise.all([
    prisma.siteAssignment.count(),
    prisma.siteAssignment.findMany({
      orderBy: { validFrom: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        isPrimary: true,
        validFrom: true,
        validTo: true,
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
    version: assignment.version
  }));

  return {
    items,
    page,
    pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / pageSize)
  };
}
