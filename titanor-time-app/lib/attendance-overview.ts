import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { getForemanOverview, getForemanSiteIds, type ForemanOverview } from '@/lib/foreman-review';
import { computeSegmentMs, sumWorkedTimeMs, msToMinutes } from '@/lib/reporting/worked-time';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §16 п.9 + Addendum "T7A.9A Attendance
// Operational Overview Read Foundation" (2026-08-18) — exact operational-state definitions and the
// recorded-vs-reported diff formula are written there BEFORE this module, per §6/§11 rule. This
// module owns all scope enforcement, aggregation, and DTO shaping for both
// GET /api/admin/overview and GET /api/foreman/overview; route files only do
// requestId/auth/permission/query-validation/HTTP mapping (same split as lib/attendance-exceptions.ts).
//
// Every query here is bounded by the size of an already-resolved employeeId/timesheetId/
// fragmentId/versionId list (IN-clauses), never by a per-row await loop — this is the fix for the
// getForemanOverview N+1 (lib/foreman-review.ts:71-76, one computeSiteScopeHasException per scope).

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export const OPERATIONAL_STATE_VALUES = [
  'WORKING_NOW',
  'FINISHED_TODAY',
  'MISSING_CHECKOUT',
  'GPS_ISSUE',
  'SYNC_ISSUE',
  'DRAFT',
  'SUBMITTED_MANUAL',
  'SUBMITTED_AUTO',
  'AWAITING_FOREMAN',
  'RETURNED',
  'READY_FOR_FINAL_APPROVAL',
  'FINAL_APPROVED',
  'CORRECTION_OPEN'
] as const;
export type OperationalState = (typeof OPERATIONAL_STATE_VALUES)[number];

const GPS_ISSUE_TYPES = new Set(['GPS_NOT_VERIFIED', 'OUTSIDE_GEOFENCE_CHECKOUT', 'GEOFENCE_VERSION_MISMATCH']);
const SYNC_ISSUE_TYPES = new Set(['DOUBLE_CHECK_IN', 'CHECKOUT_WITHOUT_OPEN_SHIFT', 'LATE_SYNC_AFTER_SUBMIT']);

// ---------------------------------------------------------------------------------------------
// Query-string validation — same "explicit invalid value is always 400+fieldErrors, never a
// silent default" contract as lib/attendance-exceptions.ts's parseExceptionListQuery.
// ---------------------------------------------------------------------------------------------

export interface OverviewQueryInput {
  q?: string | null;
  periodId: string | null;
  siteId: string | null;
  state: string | null;
  employeeId: string | null;
  page: string | null;
  pageSize: string | null;
}

export interface OverviewFilters {
  q?: string;
  periodId?: string;
  siteId?: string;
  state?: OperationalState;
  employeeId?: string;
  page: number;
  pageSize: number;
}

export type OverviewQueryResult = { ok: true; filters: OverviewFilters } | { ok: false; fieldErrors: Record<string, string[]> };

export function parseOverviewQuery(input: OverviewQueryInput, options: { allowEmployeeId: boolean }): OverviewQueryResult {
  const fieldErrors: Record<string, string[]> = {};

  let q: string | undefined;
  if (input.q !== null && input.q !== undefined) {
    const normalized = input.q.trim().replace(/\s+/g, ' ');
    if (normalized.length > 100) {
      fieldErrors.q = ['must be at most 100 characters'];
    } else if (normalized.length > 0) {
      q = normalized;
    }
  }

  let page = 1;
  if (input.page !== null) {
    const n = Number(input.page);
    if (!Number.isInteger(n) || n < 1) {
      fieldErrors.page = ['must be a positive integer'];
    } else {
      page = n;
    }
  }

  let pageSize = DEFAULT_PAGE_SIZE;
  if (input.pageSize !== null) {
    const n = Number(input.pageSize);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) {
      fieldErrors.pageSize = [`must be an integer between 1 and ${MAX_PAGE_SIZE}`];
    } else {
      pageSize = n;
    }
  }

  let periodId: string | undefined;
  if (input.periodId !== null && input.periodId !== '') {
    if (!UUID_PATTERN.test(input.periodId)) {
      fieldErrors.periodId = ['must be a UUID'];
    } else {
      periodId = input.periodId;
    }
  }

  let siteId: string | undefined;
  if (input.siteId !== null && input.siteId !== '') {
    if (!UUID_PATTERN.test(input.siteId)) {
      fieldErrors.siteId = ['must be a UUID'];
    } else {
      siteId = input.siteId;
    }
  }

  let state: OperationalState | undefined;
  if (input.state !== null && input.state !== '') {
    if (!(OPERATIONAL_STATE_VALUES as readonly string[]).includes(input.state)) {
      fieldErrors.state = [`must be one of ${OPERATIONAL_STATE_VALUES.join(', ')}`];
    } else {
      state = input.state as OperationalState;
    }
  }

  let employeeId: string | undefined;
  if (input.employeeId !== null && input.employeeId !== '') {
    if (!options.allowEmployeeId) {
      fieldErrors.employeeId = ['not a supported filter on this endpoint'];
    } else if (!UUID_PATTERN.test(input.employeeId)) {
      fieldErrors.employeeId = ['must be a UUID'];
    } else {
      employeeId = input.employeeId;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }
  return { ok: true, filters: { q, periodId, siteId, state, employeeId, page, pageSize } };
}

// ---------------------------------------------------------------------------------------------
// Period resolution — GET /api/{admin,foreman}/overview never 404s on a missing periodId query
// param, only on an explicitly-provided one that doesn't exist (§3 ТЗ T7A.9A).
// ---------------------------------------------------------------------------------------------

export interface OverviewPeriod {
  id: string;
  startDate: string;
  endDate: string;
  status: string;
  multipleCurrentCycles?: boolean;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export type ResolvePeriodResult = { ok: true; period: OverviewPeriod | null } | { ok: false };

export async function resolvePeriodForOverview(tx: Prisma.TransactionClient, periodId: string | undefined, today: Date): Promise<ResolvePeriodResult> {
  if (periodId) {
    const period = await tx.payrollPeriod.findUnique({ where: { id: periodId }, select: { id: true, startDate: true, endDate: true, status: true } });
    if (!period) {
      return { ok: false };
    }
    return { ok: true, period: { id: period.id, startDate: formatDate(period.startDate), endDate: formatDate(period.endDate), status: period.status } };
  }

  const periods = await tx.payrollPeriod.findMany({
    where: { status: 'OPEN', startDate: { lte: today }, endDate: { gte: today } },
    orderBy: [{ startDate: 'asc' }, { endDate: 'asc' }, { id: 'asc' }],
    select: { id: true, startDate: true, endDate: true, status: true }
  });
  if (periods.length === 0) return { ok: true, period: null };
  if (periods.length === 1) {
    const period = periods[0];
    return { ok: true, period: { id: period.id, startDate: formatDate(period.startDate), endDate: formatDate(period.endDate), status: period.status } };
  }
  return {
    ok: true,
    period: {
      id: '',
      startDate: formatDate(periods[0].startDate),
      endDate: formatDate(periods.reduce((latest, period) => period.endDate > latest ? period.endDate : latest, periods[0].endDate)),
      status: 'MULTIPLE_CURRENT_CYCLES',
      multipleCurrentCycles: true
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------------------------

export interface OverviewScope {
  /** null = unrestricted (ADMIN/SUPER_ADMIN). Non-null = FOREMAN's current ForemanAssignment site ids. */
  siteIds: string[] | null;
  /** Non-null for a dual-role FOREMAN+WORKER — excludes their own row entirely (never just their own data within a row). */
  excludeEmployeeId: string | null;
  /** Gates the conflicts section — only ever true for ADMIN/SUPER_ADMIN callers. */
  includeConflicts: boolean;
}

// ---------------------------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------------------------

export interface OverviewSummary {
  totalWorkers: number;
  workingNow: number;
  finishedToday: number;
  missingCheckout: number;
  gpsIssue: number;
  syncIssue: number;
  draft: number;
  submittedManual: number;
  submittedAuto: number;
  awaitingForeman: number;
  returned: number;
  readyForFinalApproval: number;
  finalApproved: number;
  correctionOpen: number;
  openAttendanceExceptions: number;
  notStartedToday: number;
  needsAttention: number;
}

export interface OverviewDiff {
  recordedMinutes: number;
  reportedMinutes: number;
  deltaMinutes: number;
  adjustmentCount: number;
}

export interface OverviewWorkerItem {
  employee: { id: string; name: string; employeeNumber: string };
  todayStatus: 'WORKING' | 'FINISHED' | 'NOT_STARTED';
  todayWorkedMinutes: number;
  needsAttention: boolean;
  currentAssignments: Array<{ site: { id: string; name: string }; workArea: { id: string; name: string } | null; isPrimary: boolean }>;
  states: OperationalState[];
  openShift: { site: { id: string; name: string }; workArea: { id: string; name: string } | null; openedAt: string; channel: string } | null;
  latestFinishedShiftToday: { id: string; site: { id: string; name: string }; recordedStartAt: string; recordedEndAt: string } | null;
  timesheet: { id: string; status: string } | null;
  currentVersion: { id: string; versionNumber: number; submissionSource: string; submittedAt: string } | null;
  openExceptionCount: number;
  openExceptionTypes: string[];
  reviewRoute: { total: number; pending: number; approved: number; returned: number; scopes: { siteName: string | null; status: string }[] } | null;
  finalApprovalBlockedReasons: string[];
  correction: { status: string } | null;
  diff: OverviewDiff | null;
}

export interface ConflictListItem {
  id: string;
  conflictType?: string;
  rejectionCode?: string;
  eventType?: string;
  employee: { id: string; name: string } | null;
  createdAt: string;
}

export interface OverviewConflicts {
  totalOpenOrRecent: number;
  clockEventIdConflicts: ConflictListItem[];
  rejectedTerminalReceipts: ConflictListItem[];
  fifoLedgerInconsistencies: ConflictListItem[];
}

export interface OverviewResult {
  asOf: string;
  timezone: 'Europe/Helsinki';
  period: OverviewPeriod | null;
  summary: OverviewSummary;
  items: OverviewWorkerItem[];
  conflicts: OverviewConflicts | null;
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

const CONFLICT_TAKE = 20;

function todayRange(today: Date): { start: Date; end: Date } {
  return { start: today, end: new Date(today.getTime() + 24 * 60 * 60 * 1000) };
}

function currentAssignmentWhere(today: Date) {
  return { validFrom: { lte: today }, OR: [{ validTo: null }, { validTo: { gte: today } }] };
}

/** Effective site restriction: an explicit siteId narrows an already-restricted (foreman) scope
 * down to the intersection; a foreign siteId collapses to an impossible match — never a 403/404
 * that would leak whether the site exists (§3 ТЗ: "Foreman с чужим siteId получает пустой 200"). */
function effectiveSiteIds(scope: OverviewScope, filters: OverviewFilters): string[] | null | 'NONE' {
  if (scope.siteIds !== null) {
    if (filters.siteId) {
      return scope.siteIds.includes(filters.siteId) ? [filters.siteId] : 'NONE';
    }
    return scope.siteIds.length === 0 ? 'NONE' : scope.siteIds;
  }
  return filters.siteId ? [filters.siteId] : null;
}

export async function buildOperationalOverview(tx: Prisma.TransactionClient, filters: OverviewFilters, scope: OverviewScope, period: OverviewPeriod | null, today: Date, asOfOverride?: Date): Promise<OverviewResult> {
  // `asOf` is "right now" for live open-shift minutes and the finished-today upper bound. Production
  // always uses the wall clock; only deterministic tests pass an explicit instant.
  const asOf = asOfOverride ?? new Date();
  const { start: todayStart, end: todayEnd } = todayRange(today);
  const siteRestriction = effectiveSiteIds(scope, filters);
  const currentPeriodIds = period?.multipleCurrentCycles
    ? (await tx.payrollPeriod.findMany({ where: { status: 'OPEN', startDate: { lte: today }, endDate: { gte: today } }, select: { id: true } })).map((row) => row.id)
    : period ? [period.id] : [];

  if (siteRestriction === 'NONE') {
    return emptyResult(asOf, period, filters, scope);
  }

  // ---- 1. Base employee universe -------------------------------------------------------------
  let employeeIds: string[];
  if (!filters.periodId && scope.includeConflicts) {
    // The owner's default Today dashboard must also show newly-created active workers who have
    // not received a Site or submission period yet. Historical period views remain participant-
    // scoped below, and foreman visibility remains site-scoped.
    const activeEmployees = await tx.employee.findMany({
      where: {
        employments: {
          some: {
            active: true,
            startDate: { lte: today },
            OR: [{ endDate: null }, { endDate: { gte: today } }]
          }
        }
      },
      select: { id: true }
    });
    employeeIds = activeEmployees.map((employee) => employee.id);
  } else if (period) {
    const participants = await tx.payrollPeriodParticipant.findMany({ where: { periodId: { in: currentPeriodIds }, expected: true }, select: { employeeId: true } });
    employeeIds = participants.map((p) => p.employeeId);
  } else {
    // No open period covering today: clock-state is still meaningful (§3 ТЗ), timesheet/review
    // data has no period to attach to — universe is whoever currently has clock-state at all.
    const [open, finished] = await Promise.all([
      tx.employeeOpenShift.findMany({ select: { employeeId: true } }),
      tx.clockShift.findMany({ where: { recordedEndAt: { gte: todayStart, lt: todayEnd } }, select: { employeeId: true }, distinct: ['employeeId'] })
    ]);
    employeeIds = [...new Set([...open.map((o) => o.employeeId), ...finished.map((f) => f.employeeId)])];
  }

  if (scope.excludeEmployeeId) {
    employeeIds = employeeIds.filter((id) => id !== scope.excludeEmployeeId);
  }
  if (filters.employeeId) {
    employeeIds = employeeIds.filter((id) => id === filters.employeeId);
  }

  if (siteRestriction !== null && employeeIds.length > 0) {
    const assignments = await tx.siteAssignment.findMany({
      where: { ...currentAssignmentWhere(today), employeeId: { in: employeeIds }, siteId: { in: siteRestriction } },
      select: { employeeId: true }
    });
    const allowed = new Set(assignments.map((a) => a.employeeId));
    employeeIds = employeeIds.filter((id) => allowed.has(id));
  }

  if (employeeIds.length === 0) {
    return emptyResult(asOf, period, filters, scope);
  }

  // ---- 2. Bulk fetch everything, bounded by employeeIds.length (never per-row awaits) --------
  const [employees, currentAssignments, openShifts, finishedShiftsRaw, openExceptions, timesheets] = await Promise.all([
    tx.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, employeeNumber: true, firstName: true, lastName: true } }),
    tx.siteAssignment.findMany({
      where: {
        employeeId: { in: employeeIds },
        ...currentAssignmentWhere(today),
        ...(siteRestriction !== null ? { siteId: { in: siteRestriction } } : {})
      },
      orderBy: [{ isPrimary: 'desc' }, { validFrom: 'desc' }, { id: 'asc' }],
      select: {
        employeeId: true,
        siteId: true,
        site: { select: { name: true } },
        workAreaId: true,
        workArea: { select: { name: true } },
        isPrimary: true
      }
    }),
    tx.employeeOpenShift.findMany({
      where: { employeeId: { in: employeeIds } },
      select: { employeeId: true, siteId: true, site: { select: { name: true } }, workAreaId: true, workArea: { select: { name: true } }, openedAt: true, openedByClockEvent: { select: { channel: true } } }
    }),
    tx.clockShift.findMany({
      where: {
        employeeId: { in: employeeIds },
        recordedStartAt: { lt: todayEnd },
        recordedEndAt: { gt: todayStart, lte: asOf }
      },
      orderBy: { recordedEndAt: 'desc' },
      select: { id: true, employeeId: true, siteId: true, site: { select: { name: true } }, recordedStartAt: true, recordedEndAt: true }
    }),
    tx.attendanceException.findMany({ where: { employeeId: { in: employeeIds }, status: 'OPEN' }, select: { employeeId: true, type: true, payrollPeriodId: true, clockShiftFragmentId: true } }),
    period
      ? tx.timesheet.findMany({
          where: { employeeId: { in: employeeIds }, periodId: { in: currentPeriodIds } },
          select: {
            id: true,
            employeeId: true,
            status: true,
            currentVersionId: true,
            currentVersion: { select: { id: true, versionNumber: true, submissionSource: true, createdAt: true } },
            draft: { select: { id: true } }
          }
        })
      : Promise.resolve([])
  ]);

  const employeeById = new Map(employees.map((e) => [e.id, e]));
  const assignmentsByEmployee = new Map<string, typeof currentAssignments>();
  for (const assignment of currentAssignments) {
    const list = assignmentsByEmployee.get(assignment.employeeId) ?? [];
    list.push(assignment);
    assignmentsByEmployee.set(assignment.employeeId, list);
  }
  const openShiftByEmployee = new Map(openShifts.map((s) => [s.employeeId, s]));
  const finishedTodayAllByEmployee = new Map<string, typeof finishedShiftsRaw>();
  const finishedTodayByEmployee = new Map<string, (typeof finishedShiftsRaw)[number]>();
  for (const shift of finishedShiftsRaw) {
    const list = finishedTodayAllByEmployee.get(shift.employeeId) ?? [];
    list.push(shift);
    finishedTodayAllByEmployee.set(shift.employeeId, list);
    if (!finishedTodayByEmployee.has(shift.employeeId)) {
      finishedTodayByEmployee.set(shift.employeeId, shift); // already ordered recordedEndAt desc
    }
  }
  const openExceptionsByEmployee = new Map<string, typeof openExceptions>();
  for (const exc of openExceptions) {
    const list = openExceptionsByEmployee.get(exc.employeeId) ?? [];
    list.push(exc);
    openExceptionsByEmployee.set(exc.employeeId, list);
  }
  const timesheetByEmployee = new Map(timesheets.map((t) => [t.employeeId, t]));

  const timesheetIds = timesheets.map((t) => t.id);
  const currentVersionIds = timesheets.map((t) => t.currentVersionId).filter((id): id is string => !!id);
  const draftIds = timesheets.map((t) => t.draft?.id).filter((id): id is string => !!id);

  const [reviewScopes, corrections] = await Promise.all([
    currentVersionIds.length > 0
      ? tx.timesheetReviewScope.findMany({
          where: { timesheetVersionId: { in: currentVersionIds } },
          select: { timesheetVersionId: true, scopeType: true, status: true, siteId: true, site: { select: { name: true } }, contextSiteId: true, contextSite: { select: { name: true } } }
        })
      : Promise.resolve([]),
    timesheetIds.length > 0
      ? tx.correctionRequest.findMany({ where: { timesheetId: { in: timesheetIds }, status: { in: ['PENDING', 'DRAFT_OPEN', 'SUBMITTED'] } }, orderBy: { createdAt: 'desc' }, select: { timesheetId: true, status: true } })
      : Promise.resolve([])
  ]);

  const reviewScopesByVersion = new Map<string, typeof reviewScopes>();
  for (const s of reviewScopes) {
    const list = reviewScopesByVersion.get(s.timesheetVersionId) ?? [];
    list.push(s);
    reviewScopesByVersion.set(s.timesheetVersionId, list);
  }
  const correctionByTimesheet = new Map<string, (typeof corrections)[number]>();
  for (const c of corrections) {
    if (!correctionByTimesheet.has(c.timesheetId)) {
      correctionByTimesheet.set(c.timesheetId, c); // already ordered createdAt desc
    }
  }

  // ---- 3. Recorded-vs-reported diff (Addendum §B) -------------------------------------------
  const diffByEmployee = await computeDiffs(tx, timesheets, siteRestriction === null ? undefined : siteRestriction);

  // ---- 4. Assemble per-worker rows ------------------------------------------------------------
  const summary: OverviewSummary = {
    totalWorkers: 0,
    workingNow: 0,
    finishedToday: 0,
    missingCheckout: 0,
    gpsIssue: 0,
    syncIssue: 0,
    draft: 0,
    submittedManual: 0,
    submittedAuto: 0,
    awaitingForeman: 0,
    returned: 0,
    readyForFinalApproval: 0,
    finalApproved: 0,
    correctionOpen: 0,
    openAttendanceExceptions: 0,
    notStartedToday: 0,
    needsAttention: 0
  };

  const allItems: OverviewWorkerItem[] = [];

  for (const employeeId of employeeIds) {
    const employee = employeeById.get(employeeId);
    if (!employee) continue; // defensive — should never happen, id came from a bulk fetch of the same set

    const states: OperationalState[] = [];
    const openShift = openShiftByEmployee.get(employeeId) ?? null;
    if (openShift) states.push('WORKING_NOW');
    const finishedShift = finishedTodayByEmployee.get(employeeId) ?? null;
    if (finishedShift) states.push('FINISHED_TODAY');
    const todayStatus: OverviewWorkerItem['todayStatus'] = openShift ? 'WORKING' : finishedShift ? 'FINISHED' : 'NOT_STARTED';
    const closedTodayMs = (finishedTodayAllByEmployee.get(employeeId) ?? []).reduce((total, shift) => {
      const startMs = Math.max(shift.recordedStartAt.getTime(), todayStart.getTime());
      const endMs = Math.min(shift.recordedEndAt.getTime(), todayEnd.getTime(), asOf.getTime());
      return total + Math.max(0, endMs - startMs);
    }, 0);
    const openTodayMs = openShift
      ? Math.max(0, asOf.getTime() - Math.max(openShift.openedAt.getTime(), todayStart.getTime()))
      : 0;
    const todayWorkedMinutes = Math.floor((closedTodayMs + openTodayMs) / 60_000);

    const myExceptions = openExceptionsByEmployee.get(employeeId) ?? [];
    const myExceptionTypes = new Set(myExceptions.map((e) => e.type));
    if (myExceptionTypes.has('MISSING_CHECKOUT_AT_CUTOFF')) states.push('MISSING_CHECKOUT');
    if ([...myExceptionTypes].some((t) => GPS_ISSUE_TYPES.has(t))) states.push('GPS_ISSUE');
    if ([...myExceptionTypes].some((t) => SYNC_ISSUE_TYPES.has(t))) states.push('SYNC_ISSUE');

    const timesheet = timesheetByEmployee.get(employeeId) ?? null;
    let reviewRoute: OverviewWorkerItem['reviewRoute'] = null;
    let finalApprovalBlockedReasons: string[] = [];
    let correctionDto: { status: string } | null = null;
    if (timesheet) {
      if (timesheet.status === 'DRAFT') states.push('DRAFT');
      if (timesheet.status === 'RETURNED') states.push('RETURNED');
      if (timesheet.status === 'FOREMAN_APPROVED') states.push('READY_FOR_FINAL_APPROVAL');
      if (timesheet.status === 'FINAL_APPROVED') states.push('FINAL_APPROVED');
      if (timesheet.status === 'SUBMITTED' && timesheet.currentVersion?.submissionSource === 'MANUAL') states.push('SUBMITTED_MANUAL');
      if (timesheet.status === 'SUBMITTED' && timesheet.currentVersion?.submissionSource === 'AUTO') states.push('SUBMITTED_AUTO');

      const scopesForVersion = timesheet.currentVersionId ? (reviewScopesByVersion.get(timesheet.currentVersionId) ?? []) : [];
      const pendingSite = scopesForVersion.some((s) => s.scopeType === 'SITE' && s.status === 'PENDING');
      const pendingNonSite = scopesForVersion.some((s) => s.scopeType === 'NON_SITE' && s.status === 'PENDING');
      if (timesheet.status === 'SUBMITTED' && (pendingSite || pendingNonSite)) states.push('AWAITING_FOREMAN');

      if (scopesForVersion.length > 0) {
        reviewRoute = {
          total: scopesForVersion.length,
          pending: scopesForVersion.filter((s) => s.status === 'PENDING').length,
          approved: scopesForVersion.filter((s) => s.status === 'APPROVED').length,
          returned: scopesForVersion.filter((s) => s.status === 'RETURNED').length,
          scopes: scopesForVersion.map((s) => ({ siteName: s.site?.name ?? s.contextSite?.name ?? null, status: s.status }))
        };
      }

      const openExceptionForPeriod = myExceptions.some((e) => period && e.payrollPeriodId !== null && currentPeriodIds.includes(e.payrollPeriodId));
      const returnedScope = scopesForVersion.some((s) => s.status === 'RETURNED');
      if (timesheet.status === 'DRAFT') finalApprovalBlockedReasons.push('TIMESHEET_NOT_SUBMITTED');
      if (pendingSite) finalApprovalBlockedReasons.push('PENDING_SITE_REVIEW');
      if (pendingNonSite) finalApprovalBlockedReasons.push('PENDING_NON_SITE_REVIEW');
      if (timesheet.status === 'RETURNED' || returnedScope) finalApprovalBlockedReasons.push('RETURNED_SCOPE');
      if (openExceptionForPeriod) finalApprovalBlockedReasons.push('OPEN_ATTENDANCE_EXCEPTION');

      const correction = correctionByTimesheet.get(timesheet.id) ?? null;
      if (correction) {
        finalApprovalBlockedReasons.push('OPEN_CORRECTION');
        states.push('CORRECTION_OPEN');
      }
      if (timesheet.currentVersion?.submissionSource === 'AUTO' && openExceptionForPeriod) {
        finalApprovalBlockedReasons.push('AUTO_SUBMITTED_WITH_EXCEPTIONS');
      }

      correctionDto = correction ? { status: correction.status } : null;
    }
    const needsAttention = myExceptions.length > 0 || states.some((state) => ['MISSING_CHECKOUT', 'GPS_ISSUE', 'SYNC_ISSUE', 'RETURNED', 'CORRECTION_OPEN'].includes(state));

    // summary tallies (unaffected by the `state` display filter — see module doc)
    summary.totalWorkers += 1;
    if (openShift) summary.workingNow += 1;
    if (finishedShift) summary.finishedToday += 1;
    if (myExceptionTypes.has('MISSING_CHECKOUT_AT_CUTOFF')) summary.missingCheckout += 1;
    if ([...myExceptionTypes].some((t) => GPS_ISSUE_TYPES.has(t))) summary.gpsIssue += 1;
    if ([...myExceptionTypes].some((t) => SYNC_ISSUE_TYPES.has(t))) summary.syncIssue += 1;
    summary.openAttendanceExceptions += myExceptions.length;
    if (timesheet?.status === 'DRAFT') summary.draft += 1;
    if (timesheet?.status === 'RETURNED') summary.returned += 1;
    if (timesheet?.status === 'FOREMAN_APPROVED') summary.readyForFinalApproval += 1;
    if (timesheet?.status === 'FINAL_APPROVED') summary.finalApproved += 1;
    if (timesheet?.status === 'SUBMITTED' && timesheet.currentVersion?.submissionSource === 'MANUAL') summary.submittedManual += 1;
    if (timesheet?.status === 'SUBMITTED' && timesheet.currentVersion?.submissionSource === 'AUTO') summary.submittedAuto += 1;
    if (states.includes('AWAITING_FOREMAN')) summary.awaitingForeman += 1;
    if (states.includes('CORRECTION_OPEN')) summary.correctionOpen += 1;
    if (todayStatus === 'NOT_STARTED') summary.notStartedToday += 1;
    if (needsAttention) summary.needsAttention += 1;

    const myAssignments = assignmentsByEmployee.get(employeeId) ?? [];

    const item: OverviewWorkerItem = {
      employee: { id: employee.id, name: `${employee.firstName} ${employee.lastName}`, employeeNumber: employee.employeeNumber },
      todayStatus,
      todayWorkedMinutes,
      needsAttention,
      currentAssignments: myAssignments.map((assignment) => ({
        site: { id: assignment.siteId, name: assignment.site.name },
        workArea: assignment.workAreaId && assignment.workArea ? { id: assignment.workAreaId, name: assignment.workArea.name } : null,
        isPrimary: assignment.isPrimary
      })),
      states,
      openShift: openShift
        ? {
            site: { id: openShift.siteId, name: openShift.site.name },
            workArea: openShift.workAreaId && openShift.workArea ? { id: openShift.workAreaId, name: openShift.workArea.name } : null,
            openedAt: openShift.openedAt.toISOString(),
            channel: openShift.openedByClockEvent.channel
          }
        : null,
      latestFinishedShiftToday: finishedShift
        ? { id: finishedShift.id, site: { id: finishedShift.siteId, name: finishedShift.site.name }, recordedStartAt: finishedShift.recordedStartAt.toISOString(), recordedEndAt: finishedShift.recordedEndAt.toISOString() }
        : null,
      timesheet: timesheet ? { id: timesheet.id, status: timesheet.status } : null,
      currentVersion: timesheet?.currentVersion
        ? { id: timesheet.currentVersion.id, versionNumber: timesheet.currentVersion.versionNumber, submissionSource: timesheet.currentVersion.submissionSource, submittedAt: timesheet.currentVersion.createdAt.toISOString() }
        : null,
      openExceptionCount: myExceptions.length,
      openExceptionTypes: [...myExceptionTypes],
      reviewRoute,
      finalApprovalBlockedReasons,
      correction: correctionDto,
      diff: diffByEmployee.get(employeeId) ?? null
    };
    allItems.push(item);
  }

  const stateFiltered = filters.state ? allItems.filter((it) => it.states.includes(filters.state as OperationalState)) : allItems;
  const query = filters.q?.toLocaleLowerCase('fi-FI');
  const filtered = query
    ? stateFiltered.filter((item) => [
        item.employee.name,
        item.employee.employeeNumber,
        ...item.currentAssignments.flatMap((assignment) => [assignment.site.name, assignment.workArea?.name ?? '']),
        item.openShift?.site.name ?? '',
        item.openShift?.workArea?.name ?? '',
        item.latestFinishedShiftToday?.site.name ?? ''
      ].join(' ').toLocaleLowerCase('fi-FI').includes(query))
    : stateFiltered;
  const statusPriority: Record<OverviewWorkerItem['todayStatus'], number> = { WORKING: 0, FINISHED: 1, NOT_STARTED: 2 };
  filtered.sort((left, right) => {
    const statusOrder = statusPriority[left.todayStatus] - statusPriority[right.todayStatus];
    if (statusOrder) return statusOrder;
    if (left.needsAttention !== right.needsAttention) return left.needsAttention ? -1 : 1;
    return left.employee.name.localeCompare(right.employee.name, 'fi');
  });
  const totalItems = filtered.length;
  const totalPages = Math.ceil(totalItems / filters.pageSize);
  const pageItems = filtered.slice((filters.page - 1) * filters.pageSize, (filters.page - 1) * filters.pageSize + filters.pageSize);

  const conflicts = scope.includeConflicts ? await buildConflicts(tx) : null;

  return { asOf: asOf.toISOString(), timezone: 'Europe/Helsinki', period, summary, items: pageItems, conflicts, page: filters.page, pageSize: filters.pageSize, totalItems, totalPages };
}

function emptyResult(asOf: Date, period: OverviewPeriod | null, filters: OverviewFilters, scope: OverviewScope): OverviewResult {
  return {
    asOf: asOf.toISOString(),
    timezone: 'Europe/Helsinki',
    period,
    summary: {
      totalWorkers: 0,
      workingNow: 0,
      finishedToday: 0,
      missingCheckout: 0,
      gpsIssue: 0,
      syncIssue: 0,
      draft: 0,
      submittedManual: 0,
      submittedAuto: 0,
      awaitingForeman: 0,
      returned: 0,
      readyForFinalApproval: 0,
      finalApproved: 0,
      correctionOpen: 0,
      openAttendanceExceptions: 0,
      notStartedToday: 0,
      needsAttention: 0
    },
    items: [],
    conflicts: scope.includeConflicts ? { totalOpenOrRecent: 0, clockEventIdConflicts: [], rejectedTerminalReceipts: [], fifoLedgerInconsistencies: [] } : null,
    page: filters.page,
    pageSize: filters.pageSize,
    totalItems: 0,
    totalPages: 0
  };
}

// ---------------------------------------------------------------------------------------------
// Recorded-vs-reported diff — implements Addendum §B exactly. `siteFilter` is the foreman's own
// site restriction (undefined = admin/unrestricted).
// ---------------------------------------------------------------------------------------------

type TimesheetForDiff = { id: string; employeeId: string; status: string; currentVersionId: string | null; draft: { id: string } | null };

async function computeDiffs(tx: Prisma.TransactionClient, timesheets: TimesheetForDiff[], siteFilter: string[] | undefined): Promise<Map<string, OverviewDiff>> {
  const result = new Map<string, OverviewDiff>();
  if (timesheets.length === 0) return result;

  const frozenTimesheets = timesheets.filter((t) => t.status === 'SUBMITTED' || t.status === 'FOREMAN_APPROVED' || t.status === 'FINAL_APPROVED');
  const liveTimesheets = timesheets.filter((t) => t.status === 'DRAFT' || t.status === 'RETURNED');
  const timesheetIds = timesheets.map((t) => t.id);

  const fragments = await tx.clockShiftFragment.findMany({
    where: { timesheetId: { in: timesheetIds }, ...(siteFilter ? { siteId: { in: siteFilter } } : {}) },
    select: { id: true, timesheetId: true, recordedStartAt: true, recordedEndAt: true }
  });
  const fragmentIds = fragments.map((f) => f.id);
  const fragmentsByTimesheet = new Map<string, typeof fragments>();
  for (const f of fragments) {
    const list = fragmentsByTimesheet.get(f.timesheetId) ?? [];
    list.push(f);
    fragmentsByTimesheet.set(f.timesheetId, list);
  }

  const [lateSyncFragmentRows, adjustmentRows] = await Promise.all([
    fragmentIds.length > 0
      ? tx.attendanceException.findMany({ where: { type: 'LATE_SYNC_AFTER_SUBMIT', status: 'OPEN', clockShiftFragmentId: { in: fragmentIds } }, select: { clockShiftFragmentId: true } })
      : Promise.resolve([]),
    fragmentIds.length > 0 ? tx.clockShiftAdjustment.findMany({ where: { clockShiftFragmentId: { in: fragmentIds } }, select: { clockShiftFragmentId: true } }) : Promise.resolve([])
  ]);
  const lateSyncFragmentIds = new Set(lateSyncFragmentRows.map((r) => r.clockShiftFragmentId).filter((id): id is string => !!id));
  const adjustmentCountByFragment = new Map<string, number>();
  for (const row of adjustmentRows) {
    adjustmentCountByFragment.set(row.clockShiftFragmentId, (adjustmentCountByFragment.get(row.clockShiftFragmentId) ?? 0) + 1);
  }

  const versionIds = frozenTimesheets.map((t) => t.currentVersionId).filter((id): id is string => !!id);
  const draftIds = liveTimesheets.map((t) => t.draft?.id).filter((id): id is string => !!id);

  const [workSegments, draftSegments] = await Promise.all([
    versionIds.length > 0
      ? tx.workSegment.findMany({
          where: { timesheetVersionId: { in: versionIds }, ...(siteFilter ? { siteId: { in: siteFilter } } : {}) },
          select: { timesheetVersionId: true, startAt: true, endAt: true, originClockShiftFragmentId: true, breaks: { select: { startAt: true, endAt: true, paid: true } } }
        })
      : Promise.resolve([]),
    draftIds.length > 0
      ? tx.timesheetDraftSegment.findMany({
          where: { draftId: { in: draftIds }, ...(siteFilter ? { siteId: { in: siteFilter } } : {}) },
          select: { draftId: true, startAt: true, endAt: true, originClockShiftFragmentId: true, breaks: { select: { startAt: true, endAt: true, paid: true } } }
        })
      : Promise.resolve([])
  ]);
  const workSegmentsByVersion = new Map<string, typeof workSegments>();
  for (const s of workSegments) {
    const list = workSegmentsByVersion.get(s.timesheetVersionId) ?? [];
    list.push(s);
    workSegmentsByVersion.set(s.timesheetVersionId, list);
  }
  const draftSegmentsByDraft = new Map<string, typeof draftSegments>();
  for (const s of draftSegments) {
    const list = draftSegmentsByDraft.get(s.draftId) ?? [];
    list.push(s);
    draftSegmentsByDraft.set(s.draftId, list);
  }

  // docs/titanor-time/T8_REPORTS_DESIGN.md §2 — shared formula core (computeSegmentMs/
  // sumWorkedTimeMs), not a local copy. Only workedMs is used here (paid break stays in, unpaid
  // break subtracted once) — grossMs/paidBreakMs/unpaidBreakMs aren't part of this diff's shape.
  function segmentReportedMs(segs: { startAt: Date; endAt: Date; originClockShiftFragmentId: string | null; breaks: { startAt: Date; endAt: Date; paid: boolean }[] }[]): { ms: number; fragmentIds: string[] } {
    const totals = sumWorkedTimeMs(segs.map((seg) => computeSegmentMs(seg)));
    const usedFragmentIds = segs.map((seg) => seg.originClockShiftFragmentId).filter((id): id is string => !!id);
    return { ms: totals.workedMs, fragmentIds: usedFragmentIds };
  }

  for (const t of frozenTimesheets) {
    const myFragments = (fragmentsByTimesheet.get(t.id) ?? []).filter((f) => !lateSyncFragmentIds.has(f.id));
    const recordedMs = myFragments.reduce((sum, f) => sum + (f.recordedEndAt.getTime() - f.recordedStartAt.getTime()), 0);
    const segs = t.currentVersionId ? (workSegmentsByVersion.get(t.currentVersionId) ?? []) : [];
    const { ms: reportedMs, fragmentIds: usedFragmentIds } = segmentReportedMs(segs);
    const adjustmentCount = myFragments.reduce((sum, f) => sum + (adjustmentCountByFragment.get(f.id) ?? 0), 0);
    const recordedMinutes = msToMinutes(recordedMs);
    const reportedMinutes = msToMinutes(reportedMs);
    result.set(t.employeeId, {
      recordedMinutes,
      reportedMinutes,
      deltaMinutes: reportedMinutes - recordedMinutes,
      adjustmentCount
    });
    void usedFragmentIds; // parity with draft branch's shape; not separately needed here
  }

  for (const t of liveTimesheets) {
    const myFragments = fragmentsByTimesheet.get(t.id) ?? [];
    const recordedMs = myFragments.reduce((sum, f) => sum + (f.recordedEndAt.getTime() - f.recordedStartAt.getTime()), 0);
    const segs = t.draft ? (draftSegmentsByDraft.get(t.draft.id) ?? []) : [];
    const { ms: reportedMs } = segmentReportedMs(segs);
    const adjustmentCount = myFragments.reduce((sum, f) => sum + (adjustmentCountByFragment.get(f.id) ?? 0), 0);
    const recordedMinutes = msToMinutes(recordedMs);
    const reportedMinutes = msToMinutes(reportedMs);
    result.set(t.employeeId, {
      recordedMinutes,
      reportedMinutes,
      deltaMinutes: reportedMinutes - recordedMinutes,
      adjustmentCount
    });
  }

  return result;
}

// ---------------------------------------------------------------------------------------------
// Conflicts section — ADMIN/SUPER_ADMIN only. Addendum §D redaction contract.
// ---------------------------------------------------------------------------------------------

async function buildConflicts(tx: Prisma.TransactionClient): Promise<OverviewConflicts> {
  const [clockEventIdConflicts, rejectedTerminalReceipts, fifoRows, totalConflicts, totalReceipts, totalFifo] = await Promise.all([
    tx.clockEventIdConflict.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: CONFLICT_TAKE,
      select: { id: true, conflictType: true, createdAt: true, employeeId: true, employee: { select: { firstName: true, lastName: true } } }
    }),
    tx.deviceEventReceipt.findMany({
      where: { outcome: 'REJECTED_TERMINAL' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: CONFLICT_TAKE,
      select: { id: true, rejectionCode: true, createdAt: true, employeeId: true }
    }),
    tx.auditEvent.findMany({
      where: { eventType: 'FIFO_LEDGER_INCONSISTENT' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: CONFLICT_TAKE,
      select: { id: true, eventType: true, createdAt: true, entityType: true, entityId: true }
    }),
    tx.clockEventIdConflict.count(),
    tx.deviceEventReceipt.count({ where: { outcome: 'REJECTED_TERMINAL' } }),
    tx.auditEvent.count({ where: { eventType: 'FIFO_LEDGER_INCONSISTENT' } })
  ]);

  const deviceInstallationIds = fifoRows.filter((r) => r.entityType === 'WORKER_DEVICE_INSTALLATION' && r.entityId).map((r) => r.entityId as string);
  const installations =
    deviceInstallationIds.length > 0 ? await tx.workerDeviceInstallation.findMany({ where: { id: { in: deviceInstallationIds } }, select: { id: true, employeeId: true } }) : [];
  const installationById = new Map(installations.map((i) => [i.id, i]));

  const receiptEmployeeIds = rejectedTerminalReceipts.map((r) => r.employeeId);
  const fifoEmployeeIds = installations.map((i) => i.employeeId);
  const namesNeededIds = [...new Set([...receiptEmployeeIds, ...fifoEmployeeIds])];
  const employeesForNames = namesNeededIds.length > 0 ? await tx.employee.findMany({ where: { id: { in: namesNeededIds } }, select: { id: true, firstName: true, lastName: true } }) : [];
  const employeeNameById = new Map(employeesForNames.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));

  return {
    totalOpenOrRecent: totalConflicts + totalReceipts + totalFifo,
    clockEventIdConflicts: clockEventIdConflicts.map((c) => ({
      id: c.id,
      conflictType: c.conflictType,
      employee: { id: c.employeeId, name: `${c.employee.firstName} ${c.employee.lastName}` },
      createdAt: c.createdAt.toISOString()
    })),
    rejectedTerminalReceipts: rejectedTerminalReceipts.map((r) => ({
      id: r.id,
      rejectionCode: r.rejectionCode ?? undefined,
      employee: { id: r.employeeId, name: employeeNameById.get(r.employeeId) ?? '' },
      createdAt: r.createdAt.toISOString()
    })),
    fifoLedgerInconsistencies: fifoRows.map((r) => {
      const installation = r.entityId ? installationById.get(r.entityId) : undefined;
      return {
        id: r.id,
        eventType: r.eventType,
        employee: installation ? { id: installation.employeeId, name: employeeNameById.get(installation.employeeId) ?? '' } : null,
        createdAt: r.createdAt.toISOString()
      };
    })
  };
}

// ---------------------------------------------------------------------------------------------
// T7A.9B — server-only wrappers around the transaction contract above. GET /api/{admin,foreman}/
// overview and the /admin, /foreman Server Components both call these instead of each re-opening
// their own prisma.$transaction(...) — one place owns "resolve period, then buildOperationalOverview
// (plus, for foreman, the legacy pendingCount/exceptionCount and site scope), all inside one
// REPEATABLE READ transaction". Neither caller does an HTTP self-fetch to its own API route.
// ---------------------------------------------------------------------------------------------

const OVERVIEW_TX_OPTIONS = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 20_000 } as const;

export type AdminOverviewOutcome = { code: 'PERIOD_NOT_FOUND' } | { code: 'OK'; result: OverviewResult };

export async function getAdminOperationalOverview(filters: OverviewFilters, today: Date): Promise<AdminOverviewOutcome> {
  return prisma.$transaction(async (tx) => {
    const periodResult = await resolvePeriodForOverview(tx, filters.periodId, today);
    if (!periodResult.ok) {
      return { code: 'PERIOD_NOT_FOUND' as const };
    }
    const result = await buildOperationalOverview(tx, filters, { siteIds: null, excludeEmployeeId: null, includeConflicts: true }, periodResult.period, today);
    return { code: 'OK' as const, result };
  }, OVERVIEW_TX_OPTIONS);
}

export type ForemanOverviewOutcome = { code: 'PERIOD_NOT_FOUND' } | { code: 'OK'; legacy: ForemanOverview; result: OverviewResult };

export async function getForemanOperationalOverview(foremanUserId: string, foremanEmployeeId: string | null, filters: OverviewFilters, today: Date): Promise<ForemanOverviewOutcome> {
  return prisma.$transaction(async (tx) => {
    const periodResult = await resolvePeriodForOverview(tx, filters.periodId, today);
    if (!periodResult.ok) {
      return { code: 'PERIOD_NOT_FOUND' as const };
    }

    const [legacy, siteIds] = await Promise.all([getForemanOverview(foremanUserId, foremanEmployeeId, today, tx), getForemanSiteIds(foremanUserId, today, tx)]);

    const result = await buildOperationalOverview(tx, filters, { siteIds, excludeEmployeeId: foremanEmployeeId, includeConflicts: false }, periodResult.period, today);

    return { code: 'OK' as const, legacy, result };
  }, OVERVIEW_TX_OPTIONS);
}
