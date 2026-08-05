import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { computeSiteScopeHasException } from '@/lib/review-scopes';

// docs/titanor-time/01_SCREEN_MAP.md §4 (/foreman/*) + PROJECT_ROADMAP.md T7.6-T7.8. No new
// schema — reuses TimesheetReviewScope (already built for the ADMIN fallback path in
// lib/review-scopes.ts) scoped down to the FOREMAN's own currently-valid ForemanAssignment sites.
// propose-correction (needs TimesheetReviewProposal) and /foreman/history (needs ApprovalAction)
// are deliberately out of scope here — same "no consumer yet, defer" reasoning already applied
// throughout ЭТАП 7; both need a schema design-checkpoint this file doesn't touch.

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function getForemanSiteIds(foremanUserId: string, today: Date): Promise<string[]> {
  const assignments = await prisma.foremanAssignment.findMany({
    where: {
      foremanUserId,
      validFrom: { lte: today },
      OR: [{ validTo: null }, { validTo: { gte: today } }]
    },
    select: { siteId: true }
  });
  return [...new Set(assignments.map((a) => a.siteId))];
}

/**
 * Ownership gate for the single-scope approve/return routes, which otherwise call straight into
 * lib/review-scopes.ts's admin-shared approveReviewScope/returnReviewScope (no site restriction
 * of their own). Returns false uniformly for "doesn't exist" and "exists but isn't a SITE scope
 * on one of this foreman's own sites" — same no-leak reasoning as getForemanTimesheetDetail.
 */
export async function isForemanOwnScope(reviewScopeId: string, foremanUserId: string, today: Date): Promise<boolean> {
  const siteIds = await getForemanSiteIds(foremanUserId, today);
  if (siteIds.length === 0) {
    return false;
  }
  const scope = await prisma.timesheetReviewScope.findUnique({ where: { id: reviewScopeId }, select: { scopeType: true, siteId: true } });
  return scope !== null && scope.scopeType === 'SITE' && scope.siteId !== null && siteIds.includes(scope.siteId);
}

export interface ForemanOverview {
  pendingCount: number;
  exceptionCount: number;
}

/** DoD (01_SCREEN_MAP.md §4 /foreman): counts must match listForemanReviewScopes's own count at the same moment — same query shape, own scope excluded. */
export async function getForemanOverview(foremanUserId: string, foremanEmployeeId: string | null, today: Date): Promise<ForemanOverview> {
  const siteIds = await getForemanSiteIds(foremanUserId, today);
  if (siteIds.length === 0) {
    return { pendingCount: 0, exceptionCount: 0 };
  }

  const scopes = await prisma.timesheetReviewScope.findMany({
    where: {
      scopeType: 'SITE',
      siteId: { in: siteIds },
      status: 'PENDING',
      timesheetVersion: foremanEmployeeId ? { employeeId: { not: foremanEmployeeId } } : undefined
    },
    select: { timesheetVersionId: true, siteId: true }
  });

  let exceptionCount = 0;
  for (const scope of scopes) {
    if (scope.siteId && (await computeSiteScopeHasException(scope.timesheetVersionId, scope.siteId))) {
      exceptionCount++;
    }
  }

  return { pendingCount: scopes.length, exceptionCount };
}

export interface ForemanReviewScopeListItem {
  id: string;
  siteId: string;
  siteName: string;
  timesheetId: string;
  employeeId: string;
  employeeName: string;
  timesheetVersionId: string;
  hasException: boolean;
}

export interface ForemanReviewScopeListFilters {
  foremanUserId: string;
  foremanEmployeeId: string | null;
  today: Date;
  hasException?: boolean;
  page: number;
  pageSize: number;
}

export interface ForemanReviewScopeListResult {
  items: ForemanReviewScopeListItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/**
 * hasException isn't a stored column (computed from aggregated WorkSegment vs
 * TimesheetPlannedShift, same as lib/review-scopes.ts's admin list), so filtering by it can't
 * happen in the DB query — fetched unpaginated for this foreman's own PENDING SITE scopes
 * (bounded by their site count, not the whole company), then filtered/paginated in memory.
 */
export async function listForemanReviewScopes(filters: ForemanReviewScopeListFilters): Promise<ForemanReviewScopeListResult> {
  const siteIds = await getForemanSiteIds(filters.foremanUserId, filters.today);
  if (siteIds.length === 0) {
    return { items: [], page: filters.page, pageSize: filters.pageSize, totalItems: 0, totalPages: 0 };
  }

  const scopes = await prisma.timesheetReviewScope.findMany({
    where: {
      scopeType: 'SITE',
      siteId: { in: siteIds },
      status: 'PENDING',
      timesheetVersion: filters.foremanEmployeeId ? { employeeId: { not: filters.foremanEmployeeId } } : undefined
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      siteId: true,
      site: { select: { name: true } },
      timesheetVersionId: true,
      timesheetVersion: {
        select: { timesheetId: true, employeeId: true, timesheet: { select: { employee: { select: { firstName: true, lastName: true } } } } }
      }
    }
  });

  const withException: ForemanReviewScopeListItem[] = await Promise.all(
    scopes.map(async (scope) => ({
      id: scope.id,
      siteId: scope.siteId as string,
      siteName: scope.site?.name ?? '',
      timesheetId: scope.timesheetVersion.timesheetId,
      employeeId: scope.timesheetVersion.employeeId,
      employeeName: `${scope.timesheetVersion.timesheet.employee.firstName} ${scope.timesheetVersion.timesheet.employee.lastName}`,
      timesheetVersionId: scope.timesheetVersionId,
      hasException: await computeSiteScopeHasException(scope.timesheetVersionId, scope.siteId as string)
    }))
  );

  const filtered = filters.hasException === undefined ? withException : withException.filter((s) => s.hasException === filters.hasException);
  const start = (filters.page - 1) * filters.pageSize;
  const items = filtered.slice(start, start + filters.pageSize);

  return { items, page: filters.page, pageSize: filters.pageSize, totalItems: filtered.length, totalPages: Math.ceil(filtered.length / filters.pageSize) };
}

export interface ForemanTimesheetDaySegment {
  id: string;
  startAt: string;
  endAt: string;
  siteId: string;
  workAreaId: string | null;
  sourceAssignmentId: string;
  breaks: { id: string; startAt: string; endAt: string; paid: boolean }[];
}

export interface ForemanTimesheetDay {
  date: string;
  dayType: string;
  confirmedZero: boolean;
  /** True when every segment on this day belongs to a site outside the foreman's own — 01_SCREEN_MAP.md §4: "дни на чужих объектах видны свёрнутыми". segments is [] when collapsed. */
  collapsed: boolean;
  segments: ForemanTimesheetDaySegment[];
}

export interface ForemanTimesheetDetail {
  timesheetId: string;
  employeeId: string;
  employeeName: string;
  status: string;
  timesheetVersionId: string;
  versionNumber: number;
  reviewScopeId: string;
  reviewScopeStatus: string;
  hasException: boolean;
  days: ForemanTimesheetDay[];
}

/** Returns null both for "no such timesheet" and "this timesheet has no SITE scope on any of this foreman's own sites" — same 404 either way, no information leak about timesheets outside the foreman's reach. */
export async function getForemanTimesheetDetail(timesheetId: string, foremanUserId: string, today: Date): Promise<ForemanTimesheetDetail | null> {
  const siteIds = await getForemanSiteIds(foremanUserId, today);
  if (siteIds.length === 0) {
    return null;
  }

  const timesheet = await prisma.timesheet.findUnique({
    where: { id: timesheetId },
    select: {
      id: true,
      status: true,
      employeeId: true,
      employee: { select: { firstName: true, lastName: true } },
      currentVersionId: true,
      currentVersion: { select: { versionNumber: true } }
    }
  });
  if (!timesheet || !timesheet.currentVersionId || !timesheet.currentVersion) {
    return null;
  }

  const ownScope = await prisma.timesheetReviewScope.findFirst({
    where: { timesheetVersionId: timesheet.currentVersionId, scopeType: 'SITE', siteId: { in: siteIds } },
    select: { id: true, status: true, siteId: true }
  });
  if (!ownScope || !ownScope.siteId) {
    return null;
  }

  const days = await prisma.timesheetDay.findMany({
    where: { timesheetVersionId: timesheet.currentVersionId },
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
          workAreaId: true,
          sourceAssignmentId: true,
          breaks: { orderBy: { startAt: 'asc' }, select: { id: true, startAt: true, endAt: true, paid: true } }
        }
      }
    }
  });

  const mappedDays: ForemanTimesheetDay[] = days.map((d) => {
    const ownSegments = d.segments.filter((s) => siteIds.includes(s.siteId));
    const hasForeignSegments = d.segments.some((s) => !siteIds.includes(s.siteId));
    const collapsed = ownSegments.length === 0 && hasForeignSegments;
    return {
      date: formatDate(d.date),
      dayType: d.dayType,
      confirmedZero: d.confirmedZero,
      collapsed,
      segments: collapsed
        ? []
        : ownSegments.map((s) => ({
            id: s.id,
            startAt: s.startAt.toISOString(),
            endAt: s.endAt.toISOString(),
            siteId: s.siteId,
            workAreaId: s.workAreaId,
            sourceAssignmentId: s.sourceAssignmentId,
            breaks: s.breaks.map((b) => ({ id: b.id, startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), paid: b.paid }))
          }))
    };
  });

  return {
    timesheetId: timesheet.id,
    employeeId: timesheet.employeeId,
    employeeName: `${timesheet.employee.firstName} ${timesheet.employee.lastName}`,
    status: timesheet.status,
    timesheetVersionId: timesheet.currentVersionId,
    versionNumber: timesheet.currentVersion.versionNumber,
    reviewScopeId: ownScope.id,
    reviewScopeStatus: ownScope.status,
    hasException: await computeSiteScopeHasException(timesheet.currentVersionId, ownScope.siteId),
    days: mappedDays
  };
}

export interface ForemanWorkerListItem {
  employeeId: string;
  employeeName: string;
  siteId: string;
  siteName: string;
}

export async function listForemanWorkers(foremanUserId: string, today: Date): Promise<ForemanWorkerListItem[]> {
  const siteIds = await getForemanSiteIds(foremanUserId, today);
  if (siteIds.length === 0) {
    return [];
  }

  const assignments = await prisma.siteAssignment.findMany({
    where: {
      siteId: { in: siteIds },
      validFrom: { lte: today },
      OR: [{ validTo: null }, { validTo: { gte: today } }]
    },
    orderBy: [{ site: { name: 'asc' } }, { employee: { lastName: 'asc' } }],
    select: {
      employeeId: true,
      employee: { select: { firstName: true, lastName: true } },
      siteId: true,
      site: { select: { name: true } }
    },
    distinct: ['employeeId', 'siteId']
  });

  return assignments.map((a) => ({
    employeeId: a.employeeId,
    employeeName: `${a.employee.firstName} ${a.employee.lastName}`,
    siteId: a.siteId,
    siteName: a.site.name
  }));
}

export type BulkApproveError = { code: 'VALIDATION_ERROR'; fieldErrors: Record<string, string[]> } | { code: 'INVALID_SCOPES'; invalidScopeIds: string[] };

export interface BulkApproveResult {
  approvedScopeIds: string[];
}

/**
 * 02_ROLE_PERMISSION_MATRIX.md §2.8 timesheet.bulk_approve DoD: "если в выборку попал scope с
 * отклонением, собственный scope прораба, или scope, чей Timesheet.status уже не SUBMITTED —
 * сервер отклоняет весь запрос с точным списком проблемных id" + "массовое подтверждение атомарно
 * — либо весь пакет проходит, либо ни один". All validation happens inside the same transaction
 * that applies the updates, so a concurrent change between the check and the write can't produce
 * a partial batch — either every row here still matches when written, or nothing is written.
 */
export async function bulkApproveReviewScopes(
  scopeIds: string[],
  foremanUserId: string,
  foremanEmployeeId: string | null,
  today: Date,
  requestId: string
): Promise<BulkApproveResult | BulkApproveError> {
  if (scopeIds.length === 0) {
    return { code: 'VALIDATION_ERROR', fieldErrors: { reviewScopeIds: ['required'] } };
  }

  const siteIds = await getForemanSiteIds(foremanUserId, today);

  const outcome = await prisma.$transaction(async (tx) => {
    const scopes = await tx.timesheetReviewScope.findMany({
      where: { id: { in: scopeIds } },
      select: {
        id: true,
        status: true,
        scopeType: true,
        siteId: true,
        timesheetVersionId: true,
        timesheetVersion: {
          select: { timesheetId: true, employeeId: true, timesheet: { select: { status: true, currentVersionId: true } } }
        }
      }
    });

    const foundById = new Map(scopes.map((s) => [s.id, s]));
    const invalidScopeIds: string[] = [];

    for (const id of scopeIds) {
      const scope = foundById.get(id);
      if (!scope) {
        invalidScopeIds.push(id);
        continue;
      }
      const hasExceptionForScope = scope.siteId ? await computeSiteScopeHasException(scope.timesheetVersionId, scope.siteId) : false;
      const validOwnership = scope.scopeType === 'SITE' && scope.siteId !== null && siteIds.includes(scope.siteId);
      const validPrecondition =
        scope.status === 'PENDING' && scope.timesheetVersionId === scope.timesheetVersion.timesheet.currentVersionId && scope.timesheetVersion.timesheet.status === 'SUBMITTED';
      const isSelf = foremanEmployeeId !== null && scope.timesheetVersion.employeeId === foremanEmployeeId;
      if (!validOwnership || !validPrecondition || isSelf || hasExceptionForScope) {
        invalidScopeIds.push(id);
      }
    }

    if (invalidScopeIds.length > 0) {
      return { code: 'INVALID_SCOPES' as const, invalidScopeIds };
    }

    for (const id of scopeIds) {
      await tx.timesheetReviewScope.update({ where: { id }, data: { status: 'APPROVED', reviewedByUserId: foremanUserId, reviewedAt: new Date() } });
    }

    const timesheetIdByVersionId = new Map(scopes.map((s) => [s.timesheetVersionId, s.timesheetVersion.timesheetId]));
    for (const [versionId, timesheetId] of timesheetIdByVersionId) {
      const allScopes = await tx.timesheetReviewScope.findMany({ where: { timesheetVersionId: versionId }, select: { status: true } });
      const allApproved = allScopes.length > 0 && allScopes.every((s) => s.status === 'APPROVED');
      if (allApproved) {
        await tx.timesheet.update({ where: { id: timesheetId }, data: { status: 'FOREMAN_APPROVED' } });
      }
    }

    await createAuditEvent(tx, {
      actorUserId: foremanUserId,
      eventType: 'FOREMAN_APPROVED',
      entityType: 'TIMESHEET_REVIEW_SCOPE',
      entityId: null,
      requestId,
      beforeValue: { scopeIds },
      afterValue: { scopeIds, bulk: true }
    });

    return { code: 'APPROVED' as const, approvedScopeIds: scopeIds };
  });

  if (outcome.code === 'INVALID_SCOPES') {
    return { code: 'INVALID_SCOPES', invalidScopeIds: outcome.invalidScopeIds };
  }
  return { approvedScopeIds: outcome.approvedScopeIds };
}
