import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { reinitializeDraftFromVersion } from '@/lib/review-scopes';

// docs/titanor-time/01_SCREEN_MAP.md §2 `/admin/timesheets[/...]` — final approval / admin
// override-return. Not detailed in 04_...§9 (that's the worker/foreman-fallback side) — contract
// by extension, same pattern as ForemanAssignment/worker-history. ApprovalAction (mentioned in
// the screen's own "Данные" line) is not built — no "Audit:"-style line anywhere names it as
// required, same reasoning already applied to TimesheetReviewProposal.

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface TimesheetListItem {
  id: string;
  employeeId: string;
  employeeName: string;
  periodId: string;
  periodStartDate: string;
  periodEndDate: string;
  status: string;
}

export interface TimesheetListFilters {
  page: number;
  pageSize: number;
  status?: string;
  periodId?: string;
}

export interface TimesheetListResult {
  items: TimesheetListItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export async function listTimesheets(filters: TimesheetListFilters): Promise<TimesheetListResult> {
  const where = {
    ...(filters.status ? { status: filters.status as never } : {}),
    ...(filters.periodId ? { periodId: filters.periodId } : {})
  };

  const [totalItems, timesheets] = await Promise.all([
    prisma.timesheet.count({ where }),
    prisma.timesheet.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
      select: {
        id: true,
        status: true,
        employeeId: true,
        employee: { select: { firstName: true, lastName: true } },
        periodId: true,
        period: { select: { startDate: true, endDate: true } }
      }
    })
  ]);

  return {
    items: timesheets.map((t) => ({
      id: t.id,
      employeeId: t.employeeId,
      employeeName: `${t.employee.firstName} ${t.employee.lastName}`,
      periodId: t.periodId,
      periodStartDate: formatDate(t.period.startDate),
      periodEndDate: formatDate(t.period.endDate),
      status: t.status
    })),
    page: filters.page,
    pageSize: filters.pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / filters.pageSize)
  };
}

export interface TimesheetCardSegment {
  id: string;
  startAt: string;
  endAt: string;
  siteId: string;
  siteName: string;
  workAreaId: string | null;
  breaks: { id: string; startAt: string; endAt: string; paid: boolean }[];
}

export interface TimesheetCardDay {
  date: string;
  dayType: string;
  confirmedZero: boolean;
  segments: TimesheetCardSegment[];
}

export interface TimesheetCard {
  timesheetId: string;
  employeeId: string;
  employeeName: string;
  periodId: string;
  status: string;
  versionId: string | null;
  versionNumber: number | null;
  days: TimesheetCardDay[];
  approvalActions: never[];
  /** Task A — id of an open (PENDING / DRAFT_OPEN) CorrectionRequest on this timesheet, if any.
   * When set, the card links straight to it instead of offering to start another one. */
  openCorrectionRequestId: string | null;
}

export async function getTimesheetCard(timesheetId: string): Promise<TimesheetCard | null> {
  const timesheet = await prisma.timesheet.findUnique({
    where: { id: timesheetId },
    select: {
      id: true,
      status: true,
      periodId: true,
      employeeId: true,
      employee: { select: { firstName: true, lastName: true } },
      currentVersionId: true
    }
  });
  if (!timesheet) {
    return null;
  }

  let days: TimesheetCardDay[] = [];
  let versionNumber: number | null = null;
  if (timesheet.currentVersionId) {
    const version = await prisma.timesheetVersion.findUnique({
      where: { id: timesheet.currentVersionId },
      select: {
        versionNumber: true,
        days: {
          orderBy: { date: 'asc' },
          select: {
            date: true,
            dayType: true,
            confirmedZero: true,
            segments: {
              orderBy: { startAt: 'asc' },
              select: {
                id: true,
                startAt: true,
                endAt: true,
                siteId: true,
                site: { select: { name: true } },
                workAreaId: true,
                breaks: { orderBy: { startAt: 'asc' }, select: { id: true, startAt: true, endAt: true, paid: true } }
              }
            }
          }
        }
      }
    });
    if (version) {
      versionNumber = version.versionNumber;
      days = version.days.map((d) => ({
        date: formatDate(d.date),
        dayType: d.dayType,
        confirmedZero: d.confirmedZero,
        segments: d.segments.map((s) => ({
          id: s.id,
          startAt: s.startAt.toISOString(),
          endAt: s.endAt.toISOString(),
          siteId: s.siteId,
          siteName: s.site.name,
          workAreaId: s.workAreaId,
          breaks: s.breaks.map((b) => ({ id: b.id, startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), paid: b.paid }))
        }))
      }));
    }
  }

  const openCorrection = await prisma.correctionRequest.findFirst({
    where: { timesheetId, status: { in: ['PENDING', 'DRAFT_OPEN'] } },
    select: { id: true }
  });

  return {
    timesheetId: timesheet.id,
    employeeId: timesheet.employeeId,
    employeeName: `${timesheet.employee.firstName} ${timesheet.employee.lastName}`,
    periodId: timesheet.periodId,
    status: timesheet.status,
    versionId: timesheet.currentVersionId,
    versionNumber,
    days,
    approvalActions: [],
    openCorrectionRequestId: openCorrection?.id ?? null
  };
}

export type TimesheetActionError = { code: 'NOT_FOUND' } | { code: 'INVALID_STATE_TRANSITION' };

export interface TimesheetActionResult {
  timesheetId: string;
  status: string;
}

/**
 * 01_SCREEN_MAP.md `/admin/timesheets/[timesheetId]/approve` DoD: "на экране физически нет поля
 * правки часов; сервер отклоняет любые данные об изменении часов в теле final-approve" — enforced
 * by this function taking no data parameter at all (nothing to reject inline; the route itself
 * rejects a non-empty body before ever calling this).
 */
export async function finalApproveTimesheet(timesheetId: string, actorUserId: string, requestId: string): Promise<TimesheetActionResult | TimesheetActionError> {
  const timesheet = await prisma.timesheet.findUnique({ where: { id: timesheetId }, select: { status: true } });
  if (!timesheet) {
    return { code: 'NOT_FOUND' };
  }
  if (timesheet.status !== 'FOREMAN_APPROVED') {
    return { code: 'INVALID_STATE_TRANSITION' };
  }

  await prisma.$transaction(async (tx) => {
    await tx.timesheet.update({ where: { id: timesheetId }, data: { status: 'FINAL_APPROVED' } });
    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'FINAL_APPROVED',
      entityType: 'TIMESHEET',
      entityId: timesheetId,
      requestId,
      beforeValue: { status: 'FOREMAN_APPROVED' },
      afterValue: { status: 'FINAL_APPROVED' }
    });
  });

  return { timesheetId, status: 'FINAL_APPROVED' };
}

/**
 * Admin override-return of a WHOLE timesheet from FOREMAN_APPROVED (03_...§4.7): forces every
 * TimesheetReviewScope of the current version to RETURNED — including already-APPROVED ones,
 * deliberately breaking their carry-forward — then reinitializes the draft (idempotent, same
 * helper scope.return uses) so PATCH .../days/:date has something to edit again.
 */
export async function returnTimesheetOverride(timesheetId: string, actorUserId: string, returnReason: string, requestId: string): Promise<TimesheetActionResult | TimesheetActionError> {
  const timesheet = await prisma.timesheet.findUnique({ where: { id: timesheetId }, select: { status: true, employeeId: true, draft: { select: { id: true } } } });
  if (!timesheet || !timesheet.draft) {
    return { code: 'NOT_FOUND' };
  }
  if (timesheet.status !== 'FOREMAN_APPROVED') {
    return { code: 'INVALID_STATE_TRANSITION' };
  }
  const draftId = timesheet.draft.id;

  const outcome = await prisma.$transaction(async (tx): Promise<'RETURNED' | 'STALE'> => {
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${timesheetId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE id = ${draftId}::uuid FOR UPDATE`;

    const fresh = await tx.timesheet.findUniqueOrThrow({ where: { id: timesheetId }, select: { status: true, currentVersionId: true } });
    if (fresh.status !== 'FOREMAN_APPROVED' || !fresh.currentVersionId) {
      return 'STALE';
    }

    await tx.timesheetReviewScope.updateMany({
      where: { timesheetVersionId: fresh.currentVersionId },
      data: { status: 'RETURNED', reviewedByUserId: actorUserId, reviewedAt: new Date(), returnReason }
    });

    const draft = await tx.timesheetDraft.findUniqueOrThrow({ where: { id: draftId }, select: { basedOnVersionId: true } });
    if (draft.basedOnVersionId !== fresh.currentVersionId) {
      await reinitializeDraftFromVersion(tx, draftId, timesheet.employeeId, fresh.currentVersionId);
    }

    // §15 п.3 — same requirement as scope.return: a human return (admin override included) must
    // set lastReturnedReason=HUMAN_REVIEW_RETURN, never leave it NULL.
    await tx.timesheet.update({ where: { id: timesheetId }, data: { status: 'RETURNED', lastReturnedReason: 'HUMAN_REVIEW_RETURN' } });

    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'TIMESHEET_RETURNED',
      entityType: 'TIMESHEET',
      entityId: timesheetId,
      requestId,
      beforeValue: { status: 'FOREMAN_APPROVED' },
      afterValue: { status: 'RETURNED', returnReason, override: true }
    });

    return 'RETURNED';
  });

  if (outcome === 'STALE') {
    return { code: 'INVALID_STATE_TRANSITION' };
  }

  return { timesheetId, status: 'RETURNED' };
}
