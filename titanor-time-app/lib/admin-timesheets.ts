import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { reinitializeDraftFromVersion, computeSiteScopeHasExceptionBulk } from '@/lib/review-scopes';
import { helsinkiToday } from '@/lib/workers';
import { workedMinutesFromIsoSegments } from '@/lib/reporting/report-format';

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

// ============================================================================
// Task B — one-click "Утвердить табель" + the /admin/review queue
// ============================================================================

export type AdminApproveError =
  | { code: 'NOT_FOUND' }
  | { code: 'INVALID_STATE_TRANSITION' }
  | { code: 'SELF_APPROVAL_FORBIDDEN' }
  | { code: 'FOREMAN_REVIEW_PENDING'; siteNames: string[] };

/**
 * Task B (2026-08-27) — the admin is the last instance (заказчик прораба не учитывает). This
 * collapses the three-screen ritual into one action:
 *   - FOREMAN_APPROVED  -> FINAL_APPROVED (same as finalApproveTimesheet).
 *   - SUBMITTED, no ForemanAssignment on any pending SITE-scope's site -> approve every PENDING
 *     scope, then FOREMAN_APPROVED, then FINAL_APPROVED, one transaction. The status still passes
 *     through FOREMAN_APPROVED (own audit event) so the history reads as the full chain.
 *   - SUBMITTED with a foreman covering a pending site -> FOREMAN_REVIEW_PENDING (the two-step
 *     model is preserved for whenever foremen actually exist; the admin uses /admin/review-scopes
 *     for the NON_SITE / foreman-less scopes as before).
 * Self-approval (actor is the worker) is refused, same rule as approveReviewScope.
 */
export async function adminApproveTimesheet(
  timesheetId: string,
  actorUserId: string,
  actorEmployeeId: string | null,
  requestId: string
): Promise<TimesheetActionResult | AdminApproveError> {
  const routing = await prisma.timesheet.findUnique({ where: { id: timesheetId }, select: { employeeId: true } });
  if (!routing) {
    return { code: 'NOT_FOUND' };
  }

  const outcome = await prisma.$transaction(async (tx): Promise<AdminApproveError | { status: 'FINAL_APPROVED' }> => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${routing.employeeId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${timesheetId}::uuid FOR UPDATE`;

    const ts = await tx.timesheet.findUniqueOrThrow({ where: { id: timesheetId }, select: { status: true, employeeId: true, currentVersionId: true } });
    if (actorEmployeeId !== null && actorEmployeeId === ts.employeeId) {
      return { code: 'SELF_APPROVAL_FORBIDDEN' as const };
    }

    if (ts.status === 'FOREMAN_APPROVED') {
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
      return { status: 'FINAL_APPROVED' as const };
    }

    if (ts.status !== 'SUBMITTED' || !ts.currentVersionId) {
      return { code: 'INVALID_STATE_TRANSITION' as const };
    }

    const scopes = await tx.timesheetReviewScope.findMany({
      where: { timesheetVersionId: ts.currentVersionId },
      select: { id: true, status: true, scopeType: true, siteId: true }
    });
    const pendingSiteIds = [...new Set(scopes.filter((s) => s.status === 'PENDING' && s.scopeType === 'SITE' && s.siteId).map((s) => s.siteId as string))];

    if (pendingSiteIds.length > 0) {
      const today = helsinkiToday();
      const foremanCovered = await tx.foremanAssignment.findMany({
        where: { siteId: { in: pendingSiteIds }, validFrom: { lte: today }, OR: [{ validTo: null }, { validTo: { gte: today } }] },
        select: { site: { select: { name: true } } }
      });
      if (foremanCovered.length > 0) {
        return { code: 'FOREMAN_REVIEW_PENDING' as const, siteNames: [...new Set(foremanCovered.map((f) => f.site.name))] };
      }
    }

    for (const scope of scopes.filter((s) => s.status === 'PENDING')) {
      await tx.timesheetReviewScope.update({ where: { id: scope.id }, data: { status: 'APPROVED', reviewedByUserId: actorUserId, reviewedAt: new Date() } });
      await createAuditEvent(tx, {
        actorUserId,
        eventType: 'FOREMAN_APPROVED',
        entityType: 'TIMESHEET_REVIEW_SCOPE',
        entityId: scope.id,
        requestId,
        beforeValue: { status: 'PENDING' },
        afterValue: { status: 'APPROVED', viaAdminApprove: true }
      });
    }

    await tx.timesheet.update({ where: { id: timesheetId }, data: { status: 'FOREMAN_APPROVED' } });
    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'FOREMAN_APPROVED',
      entityType: 'TIMESHEET',
      entityId: timesheetId,
      requestId,
      beforeValue: { status: 'SUBMITTED' },
      afterValue: { status: 'FOREMAN_APPROVED', viaAdminApprove: true }
    });

    await tx.timesheet.update({ where: { id: timesheetId }, data: { status: 'FINAL_APPROVED' } });
    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'FINAL_APPROVED',
      entityType: 'TIMESHEET',
      entityId: timesheetId,
      requestId,
      beforeValue: { status: 'FOREMAN_APPROVED' },
      afterValue: { status: 'FINAL_APPROVED', viaAdminApprove: true }
    });

    return { status: 'FINAL_APPROVED' as const };
  });

  if ('code' in outcome) {
    return outcome;
  }
  return { timesheetId, status: outcome.status };
}

export type ReviewQueueSort = 'name' | 'hours' | 'site';

export interface ReviewQueueFilters {
  siteId?: string;
  onlyIssues?: boolean;
  sort?: ReviewQueueSort;
}

export interface ReviewQueueRow {
  timesheetId: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  periodStartDate: string;
  periodEndDate: string;
  status: 'SUBMITTED' | 'FOREMAN_APPROVED';
  workedMinutes: number;
  siteNames: string[];
  exceptionCount: number;
  planMismatch: boolean;
  hasForeman: boolean;
}

export interface NotSubmittedRow {
  timesheetId: string;
  employeeName: string;
  employeeNumber: string;
  periodStartDate: string;
  periodEndDate: string;
  status: 'DRAFT' | 'RETURNED';
}

export interface ReviewQueue {
  rows: ReviewQueueRow[];
  notSubmitted: NotSubmittedRow[];
  siteOptions: { id: string; name: string }[];
}

/**
 * Task B — every Timesheet in SUBMITTED / FOREMAN_APPROVED whose PayrollPeriod is OPEN, across all
 * open periods (weekly + biweekly cohorts together), with worked hours, sites, and the "замечания"
 * signal (open AttendanceException count + plan-vs-actual mismatch). Plus a separate list of
 * workers who have not submitted yet (DRAFT / RETURNED in an open period).
 */
export async function getReviewQueue(filters: ReviewQueueFilters): Promise<ReviewQueue> {
  const timesheets = await prisma.timesheet.findMany({
    where: { status: { in: ['SUBMITTED', 'FOREMAN_APPROVED'] }, period: { status: 'OPEN' } },
    select: {
      id: true,
      status: true,
      employeeId: true,
      currentVersionId: true,
      employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
      periodId: true,
      period: { select: { startDate: true, endDate: true } },
      currentVersion: {
        select: {
          workSegments: {
            select: { siteId: true, startAt: true, endAt: true, breaks: { select: { startAt: true, endAt: true, paid: true } } }
          },
          reviewScopes: { where: { scopeType: 'SITE' }, select: { siteId: true } }
        }
      }
    }
  });

  const notSubmittedRaw = await prisma.timesheet.findMany({
    where: { status: { in: ['DRAFT', 'RETURNED'] }, period: { status: 'OPEN' } },
    select: {
      id: true,
      status: true,
      employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
      period: { select: { startDate: true, endDate: true } }
    },
    orderBy: [{ employee: { lastName: 'asc' } }, { employee: { firstName: 'asc' } }]
  });

  // plan-vs-actual, in bulk
  const scopeKeys = timesheets.flatMap((t) =>
    (t.currentVersion?.reviewScopes ?? []).filter((s) => s.siteId).map((s) => ({ timesheetVersionId: t.currentVersionId as string, siteId: s.siteId as string }))
  );
  const mismatchByKey = await computeSiteScopeHasExceptionBulk(scopeKeys);

  // open attendance exceptions per (employee, period)
  const exceptionRows = await prisma.attendanceException.groupBy({
    by: ['employeeId', 'payrollPeriodId'],
    where: {
      status: 'OPEN',
      OR: timesheets.map((t) => ({ employeeId: t.employeeId, payrollPeriodId: t.periodId }))
    },
    _count: { _all: true }
  });
  const exceptionCountByKey = new Map(exceptionRows.map((r) => [`${r.employeeId}:${r.payrollPeriodId}`, r._count._all]));

  // site names
  const allSiteIds = [...new Set(timesheets.flatMap((t) => (t.currentVersion?.workSegments ?? []).map((s) => s.siteId)))];
  const sites = allSiteIds.length > 0 ? await prisma.workSite.findMany({ where: { id: { in: allSiteIds } }, select: { id: true, name: true } }) : [];
  const siteNameById = new Map(sites.map((s) => [s.id, s.name]));

  // foreman coverage
  const today = helsinkiToday();
  const foremanAssignments =
    allSiteIds.length > 0
      ? await prisma.foremanAssignment.findMany({
          where: { siteId: { in: allSiteIds }, validFrom: { lte: today }, OR: [{ validTo: null }, { validTo: { gte: today } }] },
          select: { siteId: true }
        })
      : [];
  const foremanSiteIds = new Set(foremanAssignments.map((f) => f.siteId));

  let rows: ReviewQueueRow[] = timesheets.map((t) => {
    const segs = t.currentVersion?.workSegments ?? [];
    const workedMinutes = workedMinutesFromIsoSegments(
      segs.map((s) => ({ startAt: s.startAt.toISOString(), endAt: s.endAt.toISOString(), breaks: s.breaks.map((b) => ({ startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), paid: b.paid })) }))
    );
    const siteIds = [...new Set(segs.map((s) => s.siteId))];
    const planMismatch = (t.currentVersion?.reviewScopes ?? []).some((s) => s.siteId && mismatchByKey.get(`${t.currentVersionId}:${s.siteId}`) === true);
    return {
      timesheetId: t.id,
      employeeId: t.employeeId,
      employeeName: `${t.employee.lastName} ${t.employee.firstName}`,
      employeeNumber: t.employee.employeeNumber,
      periodStartDate: formatDate(t.period.startDate),
      periodEndDate: formatDate(t.period.endDate),
      status: t.status as 'SUBMITTED' | 'FOREMAN_APPROVED',
      workedMinutes,
      siteNames: siteIds.map((id) => siteNameById.get(id) ?? id),
      exceptionCount: exceptionCountByKey.get(`${t.employeeId}:${t.periodId}`) ?? 0,
      planMismatch,
      hasForeman: siteIds.some((id) => foremanSiteIds.has(id))
    };
  });

  if (filters.siteId) {
    rows = rows.filter((r) => timesheets.find((t) => t.id === r.timesheetId)?.currentVersion?.workSegments.some((s) => s.siteId === filters.siteId));
  }
  if (filters.onlyIssues) {
    rows = rows.filter((r) => r.exceptionCount > 0 || r.planMismatch);
  }
  const sort = filters.sort ?? 'name';
  rows.sort((a, b) => {
    if (sort === 'hours') return b.workedMinutes - a.workedMinutes || a.employeeName.localeCompare(b.employeeName);
    if (sort === 'site') return (a.siteNames[0] ?? '').localeCompare(b.siteNames[0] ?? '') || a.employeeName.localeCompare(b.employeeName);
    return a.employeeName.localeCompare(b.employeeName);
  });

  return {
    rows,
    notSubmitted: notSubmittedRaw.map((t) => ({
      timesheetId: t.id,
      employeeName: `${t.employee.lastName} ${t.employee.firstName}`,
      employeeNumber: t.employee.employeeNumber,
      periodStartDate: formatDate(t.period.startDate),
      periodEndDate: formatDate(t.period.endDate),
      status: t.status as 'DRAFT' | 'RETURNED'
    })),
    siteOptions: [...siteNameById.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  };
}

/** Task B — count for the header calendar badge: timesheets awaiting the admin in open periods. */
export async function getReviewQueueCount(): Promise<number> {
  return prisma.timesheet.count({ where: { status: { in: ['SUBMITTED', 'FOREMAN_APPROVED'] }, period: { status: 'OPEN' } } });
}

export interface ReviewQueueWeek {
  periodId: string;
  startDate: string;
  endDate: string;
  count: number;
}

/** T12 §1a — per-week (per open PayrollPeriod) breakdown behind the header calendar badge, so the
 * admin sees "which weeks still have timesheets to approve" rather than one flat number. */
export async function getReviewQueueWeeks(): Promise<ReviewQueueWeek[]> {
  const grouped = await prisma.timesheet.groupBy({
    by: ['periodId'],
    where: { status: { in: ['SUBMITTED', 'FOREMAN_APPROVED'] }, period: { status: 'OPEN' } },
    _count: { _all: true }
  });
  if (grouped.length === 0) {
    return [];
  }
  const periods = await prisma.payrollPeriod.findMany({
    where: { id: { in: grouped.map((g) => g.periodId) } },
    select: { id: true, startDate: true, endDate: true }
  });
  const byId = new Map(periods.map((p) => [p.id, p]));
  return grouped
    .map((g) => {
      const p = byId.get(g.periodId);
      return { periodId: g.periodId, startDate: p ? formatDate(p.startDate) : '', endDate: p ? formatDate(p.endDate) : '', count: g._count._all };
    })
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
}

/**
 * Admin override-return of a WHOLE timesheet from FOREMAN_APPROVED (03_...§4.7): forces every
 * TimesheetReviewScope of the current version to RETURNED — including already-APPROVED ones,
 * deliberately breaking their carry-forward — then reinitializes the draft (idempotent, same
 * helper scope.return uses) so PATCH .../days/:date has something to edit again.
 */
const RETURNABLE_TIMESHEET_STATUSES = new Set(['SUBMITTED', 'FOREMAN_APPROVED']);

export async function returnTimesheetOverride(timesheetId: string, actorUserId: string, returnReason: string, requestId: string): Promise<TimesheetActionResult | TimesheetActionError> {
  const timesheet = await prisma.timesheet.findUnique({ where: { id: timesheetId }, select: { status: true, employeeId: true, draft: { select: { id: true } } } });
  if (!timesheet || !timesheet.draft) {
    return { code: 'NOT_FOUND' };
  }
  // Task B — the whole-timesheet return now also covers SUBMITTED (an admin at the /admin/review
  // card who wants the worker to redo it, not fix it in place). The mechanics are identical:
  // every scope -> RETURNED, draft reinitialized, Timesheet.status -> RETURNED.
  if (!RETURNABLE_TIMESHEET_STATUSES.has(timesheet.status)) {
    return { code: 'INVALID_STATE_TRANSITION' };
  }
  const draftId = timesheet.draft.id;

  const outcome = await prisma.$transaction(async (tx): Promise<'RETURNED' | 'STALE'> => {
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${timesheetId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE id = ${draftId}::uuid FOR UPDATE`;

    const fresh = await tx.timesheet.findUniqueOrThrow({ where: { id: timesheetId }, select: { status: true, currentVersionId: true } });
    if (!RETURNABLE_TIMESHEET_STATUSES.has(fresh.status) || !fresh.currentVersionId) {
      return 'STALE';
    }
    const previousStatus = fresh.status;

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
      beforeValue: { status: previousStatus },
      afterValue: { status: 'RETURNED', returnReason, override: true }
    });

    return 'RETURNED';
  });

  if (outcome === 'STALE') {
    return { code: 'INVALID_STATE_TRANSITION' };
  }

  return { timesheetId, status: 'RETURNED' };
}
