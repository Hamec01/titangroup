import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §8 (Административный fallback проверки
// табелей) — ЭТАП 7 sub-task 5, admin-only path (timesheet.scope_review.all). No new schema:
// TimesheetReviewProposal is created only via a `proposals[]` body on return, which this first
// implementation doesn't support yet (rejected if non-empty) — no consumer for that model exists
// yet, same reasoning already applied to reviewScopes/resolvedProposals earlier in ЭТАП 7.
// ApprovalAction (03_...§4.7) is likewise not built — every "Audit:" line in this section of the
// contract names a plain AuditEvent, never ApprovalAction.

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * 03_...§4.6 "hasException для SITE-scope": true if the aggregate actual duration for any
 * (date, sourceAssignmentId) pair in this scope differs from its TimesheetPlannedShift's planned
 * net minutes (plannedEndAt-plannedStartAt-plannedBreakMinutes, or 0 for a non-working planned
 * day). This compares aggregated totals per pair, not each WorkSegment individually — a shift
 * split into two fragments that together match the plan is not an exception. Display-only, never
 * gates a precondition. NON_SITE scopes have no plan to compare against and are never flagged.
 */
export async function computeSiteScopeHasException(timesheetVersionId: string, siteId: string): Promise<boolean> {
  const [segments, plannedShifts] = await Promise.all([
    prisma.workSegment.findMany({ where: { timesheetVersionId, siteId }, select: { date: true, sourceAssignmentId: true, startAt: true, endAt: true } }),
    prisma.timesheetPlannedShift.findMany({ where: { timesheetVersionId, siteId }, select: { date: true, sourceAssignmentId: true, plannedStartAt: true, plannedEndAt: true, plannedBreakMinutes: true } })
  ]);

  const actualMinutesByPair = new Map<string, number>();
  for (const seg of segments) {
    const key = `${formatDate(seg.date)}:${seg.sourceAssignmentId}`;
    const minutes = (seg.endAt.getTime() - seg.startAt.getTime()) / 60000;
    actualMinutesByPair.set(key, (actualMinutesByPair.get(key) ?? 0) + minutes);
  }

  for (const ps of plannedShifts) {
    const key = `${formatDate(ps.date)}:${ps.sourceAssignmentId}`;
    const actualMinutes = actualMinutesByPair.get(key) ?? 0;
    const plannedMinutes = ps.plannedStartAt && ps.plannedEndAt ? (ps.plannedEndAt.getTime() - ps.plannedStartAt.getTime()) / 60000 - ps.plannedBreakMinutes : 0;
    if (Math.round(actualMinutes) !== Math.round(plannedMinutes)) {
      return true;
    }
  }
  return false;
}

/**
 * Bulk/set-based equivalent of computeSiteScopeHasException for N scopes at once — T7A.9A fix for
 * the getForemanOverview N+1 (lib/foreman-review.ts previously awaited computeSiteScopeHasException
 * once per scope, serially, inside a `for` loop: 2×N queries). Two queries total regardless of N,
 * scoped by the distinct timesheetVersionIds involved, then grouped in memory exactly like the
 * per-scope version above — same comparison, same result, bounded query count.
 */
export async function computeSiteScopeHasExceptionBulk(
  scopes: { timesheetVersionId: string; siteId: string }[],
  client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (scopes.length === 0) return result;

  const versionIds = [...new Set(scopes.map((s) => s.timesheetVersionId))];
  const [segments, plannedShifts] = await Promise.all([
    client.workSegment.findMany({ where: { timesheetVersionId: { in: versionIds } }, select: { timesheetVersionId: true, siteId: true, date: true, sourceAssignmentId: true, startAt: true, endAt: true } }),
    client.timesheetPlannedShift.findMany({ where: { timesheetVersionId: { in: versionIds } }, select: { timesheetVersionId: true, siteId: true, date: true, sourceAssignmentId: true, plannedStartAt: true, plannedEndAt: true, plannedBreakMinutes: true } })
  ]);

  const actualMinutesByKey = new Map<string, number>();
  for (const seg of segments) {
    const key = `${seg.timesheetVersionId}:${seg.siteId}:${formatDate(seg.date)}:${seg.sourceAssignmentId}`;
    const minutes = (seg.endAt.getTime() - seg.startAt.getTime()) / 60000;
    actualMinutesByKey.set(key, (actualMinutesByKey.get(key) ?? 0) + minutes);
  }

  const plannedByScope = new Map<string, typeof plannedShifts>();
  for (const ps of plannedShifts) {
    const scopeKey = `${ps.timesheetVersionId}:${ps.siteId}`;
    const list = plannedByScope.get(scopeKey) ?? [];
    list.push(ps);
    plannedByScope.set(scopeKey, list);
  }

  for (const scope of scopes) {
    const scopeKey = `${scope.timesheetVersionId}:${scope.siteId}`;
    const plans = plannedByScope.get(scopeKey) ?? [];
    let hasException = false;
    for (const ps of plans) {
      const key = `${ps.timesheetVersionId}:${ps.siteId}:${formatDate(ps.date)}:${ps.sourceAssignmentId}`;
      const actualMinutes = actualMinutesByKey.get(key) ?? 0;
      const plannedMinutes = ps.plannedStartAt && ps.plannedEndAt ? (ps.plannedEndAt.getTime() - ps.plannedStartAt.getTime()) / 60000 - ps.plannedBreakMinutes : 0;
      if (Math.round(actualMinutes) !== Math.round(plannedMinutes)) {
        hasException = true;
        break;
      }
    }
    result.set(scopeKey, hasException);
  }

  return result;
}

export interface ReviewScopeListItem {
  id: string;
  scopeType: string;
  scopePurpose: string | null;
  siteId: string | null;
  siteName: string | null;
  contextSiteId: string | null;
  contextSiteName: string | null;
  timesheetId: string;
  employeeId: string;
  employeeName: string;
  timesheetVersionId: string;
  status: string;
  hasException: boolean;
}

export interface ReviewScopeListResult {
  items: ReviewScopeListItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface ReviewScopeListFilters {
  page: number;
  pageSize: number;
  status?: string;
  scopeType?: string;
  scopePurpose?: string;
  siteId?: string;
  employeeId?: string;
  callerEmployeeId: string | null;
}

/** DoD (04_...§8): the caller's own Employee never appears in this list for this caller. */
export async function listReviewScopes(filters: ReviewScopeListFilters): Promise<ReviewScopeListResult> {
  const where: Prisma.TimesheetReviewScopeWhereInput = {
    status: (filters.status ?? 'PENDING') as never,
    ...(filters.scopeType ? { scopeType: filters.scopeType as never } : {}),
    ...(filters.scopePurpose ? { scopePurpose: filters.scopePurpose as never } : {}),
    ...(filters.siteId ? { siteId: filters.siteId } : {}),
    timesheetVersion: {
      timesheet: {
        ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
        ...(filters.callerEmployeeId ? { employeeId: { not: filters.callerEmployeeId } } : {})
      }
    }
  };

  const [totalItems, scopes] = await Promise.all([
    prisma.timesheetReviewScope.count({ where }),
    prisma.timesheetReviewScope.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
      select: {
        id: true,
        scopeType: true,
        scopePurpose: true,
        siteId: true,
        site: { select: { name: true } },
        contextSiteId: true,
        contextSite: { select: { name: true } },
        status: true,
        timesheetVersionId: true,
        timesheetVersion: {
          select: { timesheetId: true, employeeId: true, timesheet: { select: { employee: { select: { firstName: true, lastName: true } } } } }
        }
      }
    })
  ]);

  const items: ReviewScopeListItem[] = await Promise.all(
    scopes.map(async (scope) => ({
      id: scope.id,
      scopeType: scope.scopeType,
      scopePurpose: scope.scopePurpose,
      siteId: scope.siteId,
      siteName: scope.site?.name ?? null,
      contextSiteId: scope.contextSiteId,
      contextSiteName: scope.contextSite?.name ?? null,
      timesheetId: scope.timesheetVersion.timesheetId,
      employeeId: scope.timesheetVersion.employeeId,
      employeeName: `${scope.timesheetVersion.timesheet.employee.firstName} ${scope.timesheetVersion.timesheet.employee.lastName}`,
      timesheetVersionId: scope.timesheetVersionId,
      status: scope.status,
      hasException: scope.scopeType === 'SITE' && scope.siteId ? await computeSiteScopeHasException(scope.timesheetVersionId, scope.siteId) : false
    }))
  );

  return { items, page: filters.page, pageSize: filters.pageSize, totalItems, totalPages: Math.ceil(totalItems / filters.pageSize) };
}

export interface ReviewScopeDaySegment {
  id: string;
  startAt: string;
  endAt: string;
  siteId: string;
  workAreaId: string | null;
  sourceAssignmentId: string;
  breaks: { id: string; startAt: string; endAt: string; paid: boolean }[];
}

export interface ReviewScopeDay {
  date: string;
  dayType: string;
  confirmedZero: boolean;
  segments: ReviewScopeDaySegment[];
}

export interface ReviewScopeDetail {
  id: string;
  scopeType: string;
  scopePurpose: string | null;
  siteId: string | null;
  contextSiteId: string | null;
  status: string;
  timesheetVersionId: string;
  versionNumber: number;
  timesheetId: string;
  employeeId: string;
  days: ReviewScopeDay[];
  proposals: never[];
}

export async function getReviewScopeDetail(reviewScopeId: string): Promise<ReviewScopeDetail | null> {
  const scope = await prisma.timesheetReviewScope.findUnique({
    where: { id: reviewScopeId },
    select: {
      id: true,
      scopeType: true,
      scopePurpose: true,
      siteId: true,
      contextSiteId: true,
      status: true,
      timesheetVersionId: true,
      timesheetVersion: { select: { versionNumber: true, timesheetId: true, employeeId: true } }
    }
  });
  if (!scope) {
    return null;
  }

  let days: ReviewScopeDay[] = [];
  if (scope.scopeType === 'SITE' && scope.siteId) {
    const versionDays = await prisma.timesheetDay.findMany({
      where: { timesheetVersionId: scope.timesheetVersionId, segments: { some: { siteId: scope.siteId } } },
      orderBy: { date: 'asc' },
      select: {
        date: true,
        dayType: true,
        confirmedZero: true,
        segments: {
          where: { siteId: scope.siteId },
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
    days = versionDays.map((d) => ({
      date: formatDate(d.date),
      dayType: d.dayType,
      confirmedZero: d.confirmedZero,
      segments: d.segments.map((s) => ({
        id: s.id,
        startAt: s.startAt.toISOString(),
        endAt: s.endAt.toISOString(),
        siteId: s.siteId,
        workAreaId: s.workAreaId,
        sourceAssignmentId: s.sourceAssignmentId,
        breaks: s.breaks.map((b) => ({ id: b.id, startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), paid: b.paid }))
      }))
    }));
  } else if (scope.scopeType === 'NON_SITE' && scope.scopePurpose === 'DATA') {
    const versionDays = await prisma.timesheetDay.findMany({
      where: { timesheetVersionId: scope.timesheetVersionId, OR: [{ dayType: { not: 'WORK' } }, { confirmedZero: true }] },
      orderBy: { date: 'asc' },
      select: { date: true, dayType: true, confirmedZero: true }
    });
    days = versionDays.map((d) => ({ date: formatDate(d.date), dayType: d.dayType, confirmedZero: d.confirmedZero, segments: [] }));
  }
  // NON_SITE(EMPTY_FALLBACK): days stays [] — "пустое тело" per contract.

  return {
    id: scope.id,
    scopeType: scope.scopeType,
    scopePurpose: scope.scopePurpose,
    siteId: scope.siteId,
    contextSiteId: scope.contextSiteId,
    status: scope.status,
    timesheetVersionId: scope.timesheetVersionId,
    versionNumber: scope.timesheetVersion.versionNumber,
    timesheetId: scope.timesheetVersion.timesheetId,
    employeeId: scope.timesheetVersion.employeeId,
    days,
    proposals: []
  };
}

export type ReviewActionError =
  | { code: 'REVIEW_SCOPE_NOT_FOUND' }
  | { code: 'STALE_REVIEW_SCOPE' }
  | { code: 'SELF_APPROVAL_FORBIDDEN' }
  | { code: 'VALIDATION_ERROR'; fieldErrors: Record<string, string[]> };

interface LoadedScope {
  id: string;
  status: string;
  timesheetVersionId: string;
  timesheetId: string;
  employeeId: string;
  currentVersionId: string | null;
  timesheetStatus: string;
  draftId: string;
}

async function loadScopeForReview(reviewScopeId: string): Promise<LoadedScope | null> {
  const scope = await prisma.timesheetReviewScope.findUnique({
    where: { id: reviewScopeId },
    select: {
      id: true,
      status: true,
      timesheetVersionId: true,
      timesheetVersion: {
        select: {
          timesheetId: true,
          employeeId: true,
          timesheet: { select: { status: true, currentVersionId: true, draft: { select: { id: true } } } }
        }
      }
    }
  });
  if (!scope || !scope.timesheetVersion.timesheet.draft) {
    return null;
  }
  return {
    id: scope.id,
    status: scope.status,
    timesheetVersionId: scope.timesheetVersionId,
    timesheetId: scope.timesheetVersion.timesheetId,
    employeeId: scope.timesheetVersion.employeeId,
    currentVersionId: scope.timesheetVersion.timesheet.currentVersionId,
    timesheetStatus: scope.timesheetVersion.timesheet.status,
    draftId: scope.timesheetVersion.timesheet.draft.id
  };
}

export interface ReviewActionResult {
  reviewScopeId: string;
  status: string;
}

export async function approveReviewScope(reviewScopeId: string, reviewerUserId: string, reviewerEmployeeId: string | null, requestId: string): Promise<ReviewActionResult | ReviewActionError> {
  const scope = await loadScopeForReview(reviewScopeId);
  if (!scope) {
    return { code: 'REVIEW_SCOPE_NOT_FOUND' };
  }
  if (scope.status !== 'PENDING' || scope.timesheetVersionId !== scope.currentVersionId || scope.timesheetStatus !== 'SUBMITTED') {
    return { code: 'STALE_REVIEW_SCOPE' };
  }
  if (reviewerEmployeeId !== null && reviewerEmployeeId === scope.employeeId) {
    return { code: 'SELF_APPROVAL_FORBIDDEN' };
  }

  await prisma.$transaction(async (tx) => {
    await tx.timesheetReviewScope.update({ where: { id: reviewScopeId }, data: { status: 'APPROVED', reviewedByUserId: reviewerUserId, reviewedAt: new Date() } });

    const allScopes = await tx.timesheetReviewScope.findMany({ where: { timesheetVersionId: scope.timesheetVersionId }, select: { status: true } });
    const allApproved = allScopes.length > 0 && allScopes.every((s) => s.status === 'APPROVED');

    if (allApproved) {
      await tx.timesheet.update({ where: { id: scope.timesheetId }, data: { status: 'FOREMAN_APPROVED' } });
    }

    await createAuditEvent(tx, {
      actorUserId: reviewerUserId,
      eventType: 'FOREMAN_APPROVED',
      entityType: 'TIMESHEET_REVIEW_SCOPE',
      entityId: reviewScopeId,
      requestId,
      beforeValue: { status: 'PENDING' },
      afterValue: { status: 'APPROVED', timesheetStatus: allApproved ? 'FOREMAN_APPROVED' : scope.timesheetStatus }
    });
  });

  return { reviewScopeId, status: 'APPROVED' };
}

/**
 * 03_...§4.7 "Транзакция scope.return — точный порядок операций": lock Timesheet then
 * TimesheetDraft, re-check precondition after the lock (not before), reinitialize the draft from
 * the current version only if it hasn't been already (idempotent against a second near-
 * simultaneous return of another scope of the same version), then flip this scope to RETURNED.
 * `proposals[]` is accepted by the contract but not implemented here — TimesheetReviewProposal
 * doesn't exist yet (sub-task 5's own follow-on); a non-empty array is rejected explicitly rather
 * than silently ignored.
 */
export async function returnReviewScope(
  reviewScopeId: string,
  reviewerUserId: string,
  reviewerEmployeeId: string | null,
  returnReason: string,
  proposals: unknown[] | undefined,
  requestId: string
): Promise<ReviewActionResult | ReviewActionError> {
  if (proposals !== undefined && proposals.length > 0) {
    return { code: 'VALIDATION_ERROR', fieldErrors: { proposals: ['not yet supported'] } };
  }

  const scope = await loadScopeForReview(reviewScopeId);
  if (!scope) {
    return { code: 'REVIEW_SCOPE_NOT_FOUND' };
  }
  if (scope.status !== 'PENDING' || scope.timesheetVersionId !== scope.currentVersionId || !(scope.timesheetStatus === 'SUBMITTED' || scope.timesheetStatus === 'RETURNED')) {
    return { code: 'STALE_REVIEW_SCOPE' };
  }
  if (reviewerEmployeeId !== null && reviewerEmployeeId === scope.employeeId) {
    return { code: 'SELF_APPROVAL_FORBIDDEN' };
  }

  const outcome = await prisma.$transaction(async (tx): Promise<'RETURNED' | 'STALE'> => {
    await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${scope.timesheetId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE id = ${scope.draftId}::uuid FOR UPDATE`;

    // Re-check post-lock — the doc's own TOCTOU concern: another transaction may have committed
    // between our pre-lock read above and acquiring these locks.
    const fresh = await tx.timesheet.findUniqueOrThrow({ where: { id: scope.timesheetId }, select: { status: true, currentVersionId: true } });
    const freshScope = await tx.timesheetReviewScope.findUniqueOrThrow({ where: { id: reviewScopeId }, select: { status: true } });
    if (fresh.currentVersionId !== scope.timesheetVersionId || !(fresh.status === 'SUBMITTED' || fresh.status === 'RETURNED') || freshScope.status !== 'PENDING') {
      return 'STALE';
    }

    const draft = await tx.timesheetDraft.findUniqueOrThrow({ where: { id: scope.draftId }, select: { basedOnVersionId: true } });
    if (draft.basedOnVersionId !== scope.timesheetVersionId) {
      await reinitializeDraftFromVersion(tx, scope.draftId, scope.employeeId, scope.timesheetVersionId);
    }

    await tx.timesheetReviewScope.update({
      where: { id: reviewScopeId },
      data: { status: 'RETURNED', reviewedByUserId: reviewerUserId, reviewedAt: new Date(), returnReason }
    });

    if (fresh.status === 'SUBMITTED') {
      // §15 п.3 — a human return must mark lastReturnedReason=HUMAN_REVIEW_RETURN, or the field
      // stays NULL forever for human returns and §9.6's auto-submit candidate query can no longer
      // tell a human return apart from a system late-sync reopen.
      await tx.timesheet.update({ where: { id: scope.timesheetId }, data: { status: 'RETURNED', lastReturnedReason: 'HUMAN_REVIEW_RETURN' } });
    }

    await createAuditEvent(tx, {
      actorUserId: reviewerUserId,
      eventType: 'TIMESHEET_RETURNED',
      entityType: 'TIMESHEET_REVIEW_SCOPE',
      entityId: reviewScopeId,
      requestId,
      beforeValue: { status: 'PENDING' },
      afterValue: { status: 'RETURNED', returnReason }
    });

    return 'RETURNED';
  });

  if (outcome === 'STALE') {
    return { code: 'STALE_REVIEW_SCOPE' };
  }

  return { reviewScopeId, status: 'RETURNED' };
}

/** Exported for lib/admin-timesheets.ts's whole-timesheet override return (03_...§4.7) — same idempotent copy-back, just triggered without a specific reviewScopeId. */
export async function reinitializeDraftFromVersion(tx: Prisma.TransactionClient, draftId: string, employeeId: string, versionId: string): Promise<void> {
  // T12 — make this idempotent: clear whatever the draft currently holds before re-seeding. A
  // draft can carry leftover planned shifts from an earlier reinitialize (submit empties the day
  // rows but historically not the planned shifts), which made a second reinitialize fail on the
  // (draftId, date, sourceAssignmentId) unique index — the worker-reopen path hit exactly this.
  await tx.timesheetDraftDay.deleteMany({ where: { draftId } });
  await tx.timesheetDraftPlannedShift.deleteMany({ where: { draftId } });

  const plannedShifts = await tx.timesheetPlannedShift.findMany({
    where: { timesheetVersionId: versionId },
    select: { date: true, siteId: true, sourceAssignmentId: true, templateVersionDayId: true, plannedStartAt: true, plannedEndAt: true, plannedBreakMinutes: true }
  });
  if (plannedShifts.length > 0) {
    await tx.timesheetDraftPlannedShift.createMany({
      data: plannedShifts.map((p) => ({
        draftId,
        employeeId,
        date: p.date,
        siteId: p.siteId,
        sourceAssignmentId: p.sourceAssignmentId,
        templateVersionDayId: p.templateVersionDayId,
        plannedStartAt: p.plannedStartAt,
        plannedEndAt: p.plannedEndAt,
        plannedBreakMinutes: p.plannedBreakMinutes
      }))
    });
  }

  const days = await tx.timesheetDay.findMany({
    where: { timesheetVersionId: versionId },
    select: {
      date: true,
      dayType: true,
      confirmedZero: true,
      sourceAbsenceId: true,
      note: true,
      segments: {
        select: {
          siteId: true,
          workAreaId: true,
          sourceAssignmentId: true,
          startAt: true,
          endAt: true,
          originClockShiftFragmentId: true,
          breaks: { select: { startAt: true, endAt: true, paid: true } }
        }
      }
    }
  });
  for (const day of days) {
    const newDay = await tx.timesheetDraftDay.create({
      data: { draftId, date: day.date, dayType: day.dayType, confirmedZero: day.confirmedZero, sourceAbsenceId: day.sourceAbsenceId, note: day.note }
    });
    for (const seg of day.segments) {
      const newSegment = await tx.timesheetDraftSegment.create({
        data: {
          draftDayId: newDay.id,
          draftId,
          employeeId,
          date: day.date,
          startAt: seg.startAt,
          endAt: seg.endAt,
          siteId: seg.siteId,
          workAreaId: seg.workAreaId,
          sourceAssignmentId: seg.sourceAssignmentId,
          // §15 п.6 — without this, clock-origin provenance is silently lost on every
          // return/reopen cycle (a fresh TimesheetDraftSegment is created with NULL instead of
          // the real fragment reference), and the materializer would then wrongly try to insert
          // a second live segment for a fragment that already has one.
          originClockShiftFragmentId: seg.originClockShiftFragmentId
        }
      });
      if (seg.breaks.length > 0) {
        await tx.timesheetDraftBreakSegment.createMany({ data: seg.breaks.map((b) => ({ draftSegmentId: newSegment.id, startAt: b.startAt, endAt: b.endAt, paid: b.paid })) });
      }
    }
  }

  await tx.timesheetDraft.update({ where: { id: draftId }, data: { basedOnVersionId: versionId } });
}
