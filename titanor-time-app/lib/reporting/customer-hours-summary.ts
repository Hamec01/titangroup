// UT8-B (Titanor Time — единый табель, «Сводка» и клиентская выгрузка) — the read-only aggregation
// behind GET /api/admin/time-ledger/summary and GET /api/admin/time-ledger/summary/export.
//
// Owner decisions this module implements directly (UT8-A sign-off):
//  - The ONLY thing that matters for a customer document is the NEW per-(employee,site,workArea,
//    week) confirmation: CustomerHoursApprovalItem.CURRENT + fingerprint match. Timesheet.status
//    (FINAL_APPROVED) is NOT used here — that remains the old, internal payroll/period workflow.
//  - No new hours formula, ever. Every number here comes from getTimeLedger() — the exact same
//    WeeklyCustomerSliceRow the admin already sees in "Табель" — never a fresh computation from
//    segments (that is what lib/reporting/customer-time-report.ts does, and is explicitly NOT
//    reused here; see that module's own now-legacy status).
//  - A calendar day split between two customers uses whatever split buildWeeklyCustomerSlices (via
//    getTimeLedger) already produced — never a second, independent redistribution.
//  - Historical rows (removed slice / source-unreadable) are read via the existing
//    loadHistoricalApprovalIssues (UT7-B-fixup-2) — never re-derived.
//  - Summary/export always require an explicit, finite range capped at SUMMARY_MAX_WEEKS — allTime
//    is refused outright (a client document must have a stated period).
//  - The whole selected scope is aggregated in one pass (no UI pagination) but is itself bounded by
//    SUMMARY_MAX_SLICES — exceeding it is a hard refusal (SELECTION_TOO_LARGE), never a silent
//    truncation of the numbers a customer might see.
//  - UT8-B-fixup #1 — loadHistoricalApprovalIssues' own `truncated` flag means there could be MORE
//    historical rows outside what was actually returned, and some of those HIDDEN rows could be
//    SOURCE_UNREADABLE (which must block). Rather than trust an incomplete list, `truncated: true`
//    always adds its own HISTORICAL_INCOMPLETE blocker — the whole final export refuses until the
//    filter is narrowed enough that the historical list is no longer truncated.
//  - UT8-B-fixup-2 — ledgerResult.notSubmitted (a worker expected to have a timesheet for this
//    period who has none submitted at all — no segments exist, so there is structurally nothing to
//    confirm) must ALSO block: an expected-but-missing worker in scope is exactly the kind of thing
//    a customer document must never silently omit as if the scope were fully accounted for.
//  - UT8-B-fixup-3 #1 — getTimeLedger's own Tier-2 filter drops EVERY NotSubmittedRow once
//    query.workAreaId is set (it only lets WEEKLY_CUSTOMER_SLICE entries through), and drops the
//    Timesheet-backed half of it once query.siteId is set (it only keeps the participant-backed,
//    timesheetId===null half). Since a customer-scoped export (siteId, usually with workAreaId too)
//    is THE primary scenario, relying on ledgerResult.notSubmitted there would silently miss a
//    worker who never submitted anything for exactly the selected customer. Whenever query.siteId OR
//    query.workAreaId is set, this module resolves "not submitted, attributed to this customer"
//    itself — via each candidate's historical SiteAssignment overlapping the period (never the
//    current/latest assignment, never an unproven attribution) — see
//    loadNotSubmittedAttributedToCustomer below.
//  - UT8-B-fixup-4 — the admin UI's own customer picker (LedgerFilterBar.pickCustomer) navigates by
//    workAreaId ALONE — it never sets siteId, because WorkArea.id is already globally unique (a
//    work area belongs to exactly one site), so workAreaId alone already pins one customer
//    unambiguously. Relying on query.siteId being set (as fixup-3 #1 did) therefore missed the
//    actual primary path: picking a customer from the UI. loadNotSubmittedAttributedToCustomer now
//    activates on EITHER filter and matches SiteAssignment by whichever of (siteId, workAreaId) the
//    caller actually supplied (both, if both are supplied — never guessed from only one when the
//    other is also present). The one genuinely ambiguous combination — workAreaId='none' (the
//    explicit "no customer" bucket) with no siteId, which would otherwise mean "every site's
//    no-work-area assignments company-wide" — is refused outright (WORK_AREA_NONE_REQUIRES_SITE)
//    rather than silently widening the selection; see validateSummaryRange's sibling check below.
//  - UT8-B-fixup-3 #2 — a WeeklyCustomerSliceRow can have approvalState==='APPROVED' while
//    submissionState !== 'SUBMITTED' (an admin pre-confirmed a draft the worker hasn't formally
//    submitted yet — a deliberate, existing feature of the approval workflow, see
//    lib/reporting/weekly-approval.ts). Such a row must NEVER count as confirmedMinutes for a
//    customer document: the worker's own submission is the thing being represented, not a
//    still-editable draft. It is reclassified as its own NOT_SUBMITTED blocker (with real hours and
//    a real site/workArea/week, unlike the entirely-missing case above) and stops blocking the
//    moment the worker actually submits and the confirmation still matches.

import { prisma } from '@/lib/prisma';
import { getTimeLedger, type NormalizedTimeLedgerQuery, type LedgerActor, type WeeklyCustomerSliceRow, type SourceErrorRow, type NotSubmittedRow } from '@/lib/reporting/time-ledger';
import { loadHistoricalApprovalIssues, type HistoricalApprovalRow } from '@/lib/reporting/customer-hours-history';
import { helsinkiWeekBounds, enumerateHelsinkiWeeks } from '@/lib/reporting/weekly-customer-slice';

type Db = Parameters<typeof getTimeLedger>[3];

function formatDateIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * UT8-B-fixup-3 #1 — every PayrollPeriod overlapping [startDate, endDate]. Small local duplicate of
 * lib/reporting/time-ledger.ts's own private listOverlappingPeriods (same "zero cross-module
 * coupling for a six-line helper" convention already established across this codebase).
 */
async function listOverlappingPeriods(range: { startDate: string; endDate: string }, db: Db = prisma): Promise<{ id: string; startDate: Date; endDate: Date }[]> {
  return db.payrollPeriod.findMany({
    where: { startDate: { lte: parseIsoDateUtc(range.endDate) }, endDate: { gte: parseIsoDateUtc(range.startDate) } },
    select: { id: true, startDate: true, endDate: true }
  });
}

/**
 * UT8-B-fixup-3 #1 / UT8-B-fixup-4 — "not submitted, attributed to exactly this customer" (siteId
 * and/or workAreaId — at least one must be supplied by the caller, checked with an assertion below
 * rather than silently scanning company-wide). Two candidate sources, matching
 * lib/reporting/time-ledger.ts's own NotSubmittedRow construction exactly (never a third, diverging
 * definition of "not submitted"):
 *  (a) an expected PayrollPeriodParticipant with NO Timesheet at all for the period
 *      (mirrors lib/reporting/not-submitted.ts's loadMissingTimesheetParticipants);
 *  (b) a Timesheet that exists with status DRAFT/RETURNED but whose draft has ZERO segments
 *      (mirrors buildEntriesForTimesheets' own makeNotSubmittedFromTimesheetRow condition).
 * Neither candidate has any segment to read a site/workArea from, so attribution is resolved the
 * only provable way: a SiteAssignment for that exact employee matching whichever of (siteId,
 * workAreaId) was actually supplied — both, if both were supplied — whose [validFrom, validTo)
 * window overlaps the period's own [startDate, endDate] — never the employee's current/latest
 * assignment, which could easily be a different customer by the time an admin runs this report.
 * WorkArea.id is globally unique (never composite with siteId — see the WorkArea model), so
 * workAreaId ALONE already pins one customer unambiguously; siteId alone still scopes to "any
 * work area at this site" as before. One batched query per source, one batched SiteAssignment
 * query for every candidate employee — no N+1 regardless of candidate count.
 */
async function loadNotSubmittedAttributedToCustomer(
  periods: { id: string; startDate: Date; endDate: Date }[],
  filters: { siteId: string | null; workAreaId: string | 'none' | null; employeeSearch: string | null },
  db: Db = prisma
): Promise<NotSubmittedRow[]> {
  if (!filters.siteId && !filters.workAreaId) {
    // Invariant guarded by the one caller (loadCustomerHoursSummary only reaches here when at least
    // one of siteId/workAreaId is set) — fail loudly rather than ever silently resolving to an
    // unscoped, company-wide SiteAssignment scan.
    throw new Error('loadNotSubmittedAttributedToCustomer requires siteId and/or workAreaId');
  }
  const periodIds = periods.map((p) => p.id);
  if (periodIds.length === 0) return [];

  const employeeWhere = filters.employeeSearch
    ? { OR: [{ firstName: { contains: filters.employeeSearch, mode: 'insensitive' as const } }, { lastName: { contains: filters.employeeSearch, mode: 'insensitive' as const } }, { employeeNumber: { contains: filters.employeeSearch, mode: 'insensitive' as const } }] }
    : undefined;

  const [missingParticipants, draftTimesheets] = await Promise.all([
    db.payrollPeriodParticipant.findMany({
      where: { periodId: { in: periodIds }, expected: true, timesheets: { none: {} }, ...(employeeWhere ? { employee: employeeWhere } : {}) },
      select: {
        employeeId: true,
        periodId: true,
        employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
        period: { select: { startDate: true, endDate: true } }
      }
    }),
    db.timesheet.findMany({
      where: { periodId: { in: periodIds }, status: { in: ['DRAFT', 'RETURNED'] }, ...(employeeWhere ? { employee: employeeWhere } : {}) },
      select: {
        id: true,
        employeeId: true,
        periodId: true,
        employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
        period: { select: { startDate: true, endDate: true } },
        draft: { select: { _count: { select: { timesheetDraftSegments: true } } } }
      }
    })
  ]);

  interface Candidate {
    employeeId: string;
    periodId: string;
    employeeFirstName: string;
    employeeLastName: string;
    employeeNumber: string;
    periodStart: Date;
    periodEnd: Date;
  }
  const candidates: Candidate[] = [
    ...missingParticipants.map((p) => ({ employeeId: p.employeeId, periodId: p.periodId, employeeFirstName: p.employee.firstName, employeeLastName: p.employee.lastName, employeeNumber: p.employee.employeeNumber, periodStart: p.period.startDate, periodEnd: p.period.endDate })),
    ...draftTimesheets
      .filter((t) => (t.draft?._count.timesheetDraftSegments ?? 0) === 0)
      .map((t) => ({ employeeId: t.employeeId, periodId: t.periodId, employeeFirstName: t.employee.firstName, employeeLastName: t.employee.lastName, employeeNumber: t.employee.employeeNumber, periodStart: t.period.startDate, periodEnd: t.period.endDate }))
  ];
  if (candidates.length === 0) return [];

  // Mirrors getTimeLedger's own Tier-2 workAreaId semantics exactly (lib/reporting/time-ledger.ts
  // ~line 1024): falsy (null/undefined) = no work-area filter at all; the string 'none' = match
  // ONLY assignments with workAreaId===null (the site-level, no-specific-work-area bucket); any
  // other string = match that exact work area. Getting 'none' backwards here would either silently
  // widen or silently narrow which SiteAssignment counts as proof — both are unacceptable for a
  // block that decides whether a final export is allowed. siteId is included in the `where` only
  // when actually supplied — UT8-B-fixup-4: the UI's customer picker supplies workAreaId ALONE, and
  // since WorkArea.id is globally unique that is already sufficient, unambiguous proof on its own.
  const assignmentWhere: Record<string, unknown> = {};
  if (filters.siteId) assignmentWhere.siteId = filters.siteId;
  if (filters.workAreaId === 'none') assignmentWhere.workAreaId = null;
  else if (filters.workAreaId) assignmentWhere.workAreaId = filters.workAreaId;
  const employeeIds = [...new Set(candidates.map((c) => c.employeeId))];
  const assignments = await db.siteAssignment.findMany({
    where: { employeeId: { in: employeeIds }, ...assignmentWhere },
    select: { employeeId: true, validFrom: true, validTo: true }
  });
  const assignmentsByEmployee = new Map<string, { validFrom: Date; validTo: Date | null }[]>();
  for (const a of assignments) {
    const list = assignmentsByEmployee.get(a.employeeId) ?? [];
    list.push({ validFrom: a.validFrom, validTo: a.validTo });
    assignmentsByEmployee.set(a.employeeId, list);
  }

  const result: NotSubmittedRow[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = `${c.employeeId}::${c.periodId}`;
    if (seen.has(key)) continue; // defensive — the two source queries are structurally disjoint, but never trust that silently
    const list = assignmentsByEmployee.get(c.employeeId);
    if (!list) continue;
    const overlaps = list.some((a) => a.validFrom <= c.periodEnd && (a.validTo === null || a.validTo >= c.periodStart));
    if (!overlaps) continue;
    seen.add(key);
    result.push({
      kind: 'NOT_SUBMITTED',
      employeeId: c.employeeId,
      employeeName: `${c.employeeLastName} ${c.employeeFirstName}`.trim(),
      employeeNumber: c.employeeNumber,
      periodId: c.periodId,
      periodStartDate: formatDateIso(c.periodStart),
      periodEndDate: formatDateIso(c.periodEnd),
      timesheetId: null,
      timesheetStatus: null,
      weeksCovered: []
    });
  }
  return result;
}

/** Owner decision (UT8-A) — the normal working range for the summary/export is at most 6 calendar
 *  weeks. The Табель table itself is unaffected (getTimeLedger's own allTime/chunked path still
 *  covers any range); this cap is specific to the customer-facing summary/export surface. */
export const SUMMARY_MAX_WEEKS = 6;

/** Owner decision (UT8-A) — an explicit upper bound on how many weekly slices one summary/export
 *  call may aggregate. Exceeding it is SELECTION_TOO_LARGE, never a silent truncation. */
export const SUMMARY_MAX_SLICES = 500;

function parseIsoDateUtc(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export type SummaryRangeQuery = Pick<NormalizedTimeLedgerQuery, 'allTime' | 'requestedRange'>;

export type SummaryRangeError = { code: 'ALL_TIME_NOT_ALLOWED' } | { code: 'RANGE_TOO_LARGE'; maxWeeks: number; actualWeeks: number };

/**
 * Pure — no I/O. `allTime=true` (or a missing range) is always rejected: a client document must
 * have a stated period. Otherwise the range is normalized to full Helsinki weeks (mirroring
 * getTimeLedger's own normalization) and the resulting week count is checked against
 * SUMMARY_MAX_WEEKS. Exported so both the route and unit tests can call it directly.
 */
export function validateSummaryRange(query: SummaryRangeQuery): SummaryRangeError | null {
  if (query.allTime || !query.requestedRange) {
    return { code: 'ALL_TIME_NOT_ALLOWED' };
  }
  const startWeek = helsinkiWeekBounds(parseIsoDateUtc(query.requestedRange.startDate)).weekStart;
  const endWeek = helsinkiWeekBounds(parseIsoDateUtc(query.requestedRange.endDate)).weekEnd;
  const actualWeeks = enumerateHelsinkiWeeks(startWeek, endWeek).length;
  if (actualWeeks > SUMMARY_MAX_WEEKS) {
    return { code: 'RANGE_TOO_LARGE', maxWeeks: SUMMARY_MAX_WEEKS, actualWeeks };
  }
  return null;
}

export interface SummaryCustomerTotal {
  siteId: string;
  siteName: string;
  workAreaId: string | null;
  workAreaName: string | null;
  recordedMinutes: number;
  recordedWorkerCount: number;
  confirmedMinutes: number;
  confirmedWorkerCount: number;
  /** UT8-B-fixup #5 — hours, not just a row count, since the "Сводка" tab's whole scenario is
   *  customer + hours. pendingCount/changedCount (week counts) are kept alongside for a "N weeks"
   *  style label if ever needed, but the primary UI column is the minutes field. */
  pendingMinutes: number;
  changedMinutes: number;
  pendingCount: number;
  changedCount: number;
  warningCount: number;
  historicalCount: number;
}

export type SummaryBlockerReason = 'PENDING' | 'NEEDS_ATTENTION' | 'CHANGED_AFTER_APPROVAL' | 'SOURCE_UNREADABLE' | 'HISTORICAL_INCOMPLETE' | 'NOT_SUBMITTED';

export interface SummaryBlocker {
  reason: SummaryBlockerReason;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  /** null only for a whole-timesheet SOURCE_UNREADABLE (lib/reporting/time-ledger.ts's own
   *  SourceErrorRow never resolved a single segment, so no site/week can be attributed). */
  siteId: string | null;
  siteName: string | null;
  workAreaId: string | null;
  workAreaName: string | null;
  weekStart: string | null;
  weekEnd: string | null;
}

export interface CustomerHoursSummaryTotals {
  recordedMinutes: number;
  recordedWorkerCount: number;
  confirmedMinutes: number;
  pendingMinutes: number;
  changedMinutes: number;
  confirmedWorkerCount: number;
  pendingWorkerCount: number;
  changedWorkerCount: number;
  warningCount: number;
  sourceErrorCount: number;
  historicalCount: number;
  historicalTruncated: boolean;
  /** UT8-B-fixup-2 — a worker expected to have a timesheet for this period with NONE submitted at
   *  all (lib/reporting/time-ledger.ts's own NotSubmittedRow). notSubmittedCount is the number of
   *  such (employee, period) entries; notSubmittedWorkerCount is the distinct worker count (one
   *  worker can be missing across several periods in a wide-enough range). */
  notSubmittedCount: number;
  notSubmittedWorkerCount: number;
}

export interface CustomerHoursSummaryResult {
  ok: true;
  requestedRange: { startDate: string; endDate: string };
  effectiveWeekRange: { startDate: string; endDate: string };
  /** Every WEEKLY_CUSTOMER_SLICE row in the selected scope, any approvalState — the same rows
   *  already shown in "Табель" for this filter. Used internally by the export renderers; the
   *  summary route itself never serializes this field wholesale to the client (only the aggregates
   *  below), keeping the JSON response small. */
  rows: WeeklyCustomerSliceRow[];
  /** Whole-timesheet source failures in scope (lib/reporting/time-ledger.ts's SourceErrorRow) —
   *  always a blocker, never counted as confirmed. */
  sourceErrors: SourceErrorRow[];
  /** Historical (removed / source-unreadable) rows in scope — see customer-hours-history.ts. Never
   *  added to any total; only SOURCE_UNREADABLE ones become a blocker (a genuinely removed slice
   *  does not block confirming anything else). */
  historical: HistoricalApprovalRow[];
  /** UT8-B-fixup-2 — workers expected but missing a submitted timesheet entirely, in scope. Always
   *  a blocker (see SummaryBlockerReason NOT_SUBMITTED below), never counted toward any hours total
   *  (there are, by definition, no hours to count). */
  notSubmitted: NotSubmittedRow[];
  totals: CustomerHoursSummaryTotals;
  byCustomer: SummaryCustomerTotal[];
  /** true iff there is nothing in `blockers` — the whole selected scope is APPROVED, with no
   *  source errors and no unresolved SOURCE_UNREADABLE historical rows. */
  readyForCustomerExport: boolean;
  blockers: SummaryBlocker[];
}

export type CustomerHoursSummaryOutcome =
  | CustomerHoursSummaryResult
  | { ok: false; reason: 'ALL_TIME_NOT_ALLOWED' }
  | { ok: false; reason: 'RANGE_TOO_LARGE'; maxWeeks: number; actualWeeks: number }
  | { ok: false; reason: 'SELECTION_TOO_LARGE'; totalItems: number; max: number }
  /** UT8-B-fixup-4 #3 — workAreaId='none' (the explicit "no customer" bucket) with no siteId would
   *  mean "every site's no-work-area assignments, company-wide" for NOT_SUBMITTED attribution —
   *  genuinely ambiguous for a document that is supposed to represent ONE customer. Refused outright
   *  rather than silently widening the selection; narrow with a siteId to proceed. */
  | { ok: false; reason: 'WORK_AREA_NONE_REQUIRES_SITE' };

function emptyCustomerTotal(siteId: string, siteName: string, workAreaId: string | null, workAreaName: string | null): SummaryCustomerTotal {
  return { siteId, siteName, workAreaId, workAreaName, recordedMinutes: 0, recordedWorkerCount: 0, confirmedMinutes: 0, confirmedWorkerCount: 0, pendingMinutes: 0, changedMinutes: 0, pendingCount: 0, changedCount: 0, warningCount: 0, historicalCount: 0 };
}

export async function loadCustomerHoursSummary(
  query: Pick<NormalizedTimeLedgerQuery, 'allTime' | 'requestedRange' | 'employeeSearch' | 'siteId' | 'workAreaId'>,
  actor: LedgerActor,
  db: Db = prisma,
  /** Overridable only by a direct, server-side caller (the DB test suite) — GET .../summary and
   *  .../summary/export never expose this as a request parameter, so production behaviour is always
   *  SUMMARY_MAX_SLICES. Mirrors customer-hours-history.ts's own maxRows testability seam. */
  maxSlices: number = SUMMARY_MAX_SLICES,
  /** Overridable only by a direct, server-side caller (the DB test suite) — passed straight through
   *  to loadHistoricalApprovalIssues' own maxRows seam, which GET .../summary and .../summary/export
   *  never expose either; production behaviour is always that function's own default. Exists so the
   *  "historicalTruncated blocks final export" rule (UT8-B-fixup #1) can be exercised with a couple
   *  of real historical rows instead of needing MAX_HISTORICAL_ROWS+1 real fixtures. */
  maxHistoricalRows?: number
): Promise<CustomerHoursSummaryOutcome> {
  const rangeError = validateSummaryRange(query);
  if (rangeError) {
    return rangeError.code === 'ALL_TIME_NOT_ALLOWED'
      ? { ok: false, reason: 'ALL_TIME_NOT_ALLOWED' }
      : { ok: false, reason: 'RANGE_TOO_LARGE', maxWeeks: rangeError.maxWeeks, actualWeeks: rangeError.actualWeeks };
  }
  // UT8-B-fixup-4 #3 — the one genuinely ambiguous NOT_SUBMITTED-attribution combination (see
  // loadNotSubmittedAttributedToCustomer's own header comment) — refused before any query runs.
  if (query.workAreaId === 'none' && !query.siteId) {
    return { ok: false, reason: 'WORK_AREA_NONE_REQUIRES_SITE' };
  }
  const requestedRange = query.requestedRange!;

  // Status/issue filters are deliberately forced to "show everything" — the summary's whole job is
  // to show the confirmed/pending/changed BREAKDOWN itself, never a pre-filtered subset of it.
  const ledgerQuery: NormalizedTimeLedgerQuery = {
    allTime: false,
    requestedRange,
    employeeSearch: query.employeeSearch,
    // UT9-B — the exact-employeeId deep-link filter is a Табель-only concept (the notification
    // redirect); the Сводка/export surface never accepts it as an input, so it is always null here.
    employeeId: null,
    workAreaId: query.workAreaId,
    siteId: query.siteId,
    status: 'all',
    onlyIssues: false,
    onlyChangedAfterApproval: false,
    submissionState: 'all',
    submissionSource: 'all',
    page: 1,
    pageSize: maxSlices + 1 // +1 only to detect "more than the limit", never to display it
  };
  const ledgerResult = await getTimeLedger(ledgerQuery, actor, {}, db);
  if (ledgerResult.pagination.totalItems > maxSlices) {
    return { ok: false, reason: 'SELECTION_TOO_LARGE', totalItems: ledgerResult.pagination.totalItems, max: maxSlices };
  }

  const historicalOutcome = await loadHistoricalApprovalIssues(
    { allTime: false, requestedRange, employeeSearch: query.employeeSearch, siteId: query.siteId, workAreaId: query.workAreaId, status: 'all', onlyIssues: false, onlyChangedAfterApproval: false },
    actor,
    db,
    maxHistoricalRows
  );

  // UT8-B-fixup-3 #1 / UT8-B-fixup-4 — getTimeLedger's own Tier-2 filter drops NotSubmittedRow
  // entries once EITHER siteId or workAreaId is set (see module header). The admin UI's own customer
  // picker (LedgerFilterBar.pickCustomer) navigates by workAreaId ALONE — checking siteId alone (as
  // fixup-3 #1 did) missed that actual primary path entirely. Whenever this summary is scoped by
  // either filter, ledgerResult.notSubmitted cannot be trusted to be complete, so it is resolved here
  // instead via provable historical SiteAssignment overlap. A wholly unscoped call (neither siteId
  // nor workAreaId) is unaffected by that filter and keeps using ledgerResult.notSubmitted as before.
  const notSubmitted: NotSubmittedRow[] =
    query.siteId || query.workAreaId
      ? await loadNotSubmittedAttributedToCustomer(
          await listOverlappingPeriods(ledgerResult.effectiveWeekRange!, db),
          { siteId: query.siteId, workAreaId: query.workAreaId, employeeSearch: query.employeeSearch ?? null },
          db
        )
      : ledgerResult.notSubmitted;

  const rows = ledgerResult.customerGroups.flatMap((g) => g.rows);
  const siteWorkAreaNameByKey = new Map<string, { siteName: string; workAreaName: string | null }>();
  for (const g of ledgerResult.customerGroups) {
    siteWorkAreaNameByKey.set(`${g.siteId}::${g.workAreaId ?? ''}`, { siteName: g.siteName, workAreaName: g.workAreaName });
  }
  for (const h of historicalOutcome.rows) {
    const key = `${h.siteId}::${h.workAreaId ?? ''}`;
    if (!siteWorkAreaNameByKey.has(key)) siteWorkAreaNameByKey.set(key, { siteName: h.siteName, workAreaName: h.workAreaName });
  }

  // byCustomer — one entry per (siteId, workAreaId) seen either as a live group or as an
  // orphan-historical key (every one of that customer's approvals became historical — mirrors
  // TimesheetsLedgerView.tsx's own orphan-group handling for the exact same reason).
  const byCustomerMap = new Map<string, SummaryCustomerTotal>();
  for (const g of ledgerResult.customerGroups) {
    byCustomerMap.set(`${g.siteId}::${g.workAreaId ?? ''}`, emptyCustomerTotal(g.siteId, g.siteName, g.workAreaId, g.workAreaName));
  }
  for (const h of historicalOutcome.rows) {
    const key = `${h.siteId}::${h.workAreaId ?? ''}`;
    if (!byCustomerMap.has(key)) byCustomerMap.set(key, emptyCustomerTotal(h.siteId, h.siteName, h.workAreaId, h.workAreaName));
  }

  const confirmedWorkers = new Set<string>();
  const recordedWorkers = new Set<string>();
  const pendingWorkers = new Set<string>();
  const changedWorkers = new Set<string>();
  let confirmedMinutes = 0;
  let recordedMinutes = 0;
  let pendingMinutes = 0;
  let changedMinutes = 0;
  let warningCount = 0;
  const blockers: SummaryBlocker[] = [];
  const perCustomerConfirmedWorkers = new Map<string, Set<string>>();
  const perCustomerRecordedWorkers = new Map<string, Set<string>>();

  for (const row of rows) {
    const key = `${row.logicalKey.siteId}::${row.logicalKey.workAreaId ?? ''}`;
    const cust = byCustomerMap.get(key)!;
    recordedMinutes += row.workedMinutes;
    recordedWorkers.add(row.logicalKey.employeeId);
    cust.recordedMinutes += row.workedMinutes;
    let recordedSet = perCustomerRecordedWorkers.get(key);
    if (!recordedSet) {
      recordedSet = new Set();
      perCustomerRecordedWorkers.set(key, recordedSet);
    }
    recordedSet.add(row.logicalKey.employeeId);
    if (row.warnings.length > 0) {
      warningCount += 1;
      cust.warningCount += 1;
    }
    // UT8-B-fixup-3 #2 — checked BEFORE approvalState: an admin can confirm a still-DRAFT/RETURNED
    // slice the worker hasn't formally submitted (a deliberate, separate feature of the approval
    // workflow — see lib/reporting/weekly-approval.ts), but a customer document represents the
    // worker's own submission, not a still-editable draft. Such a row never reaches confirmedMinutes
    // no matter what approvalState says, and is reported as NOT_SUBMITTED (with its real hours and
    // site/workArea/week — unlike the entirely-missing case, this row DOES have a logicalKey) rather
    // than PENDING/CHANGED_AFTER_APPROVAL, matching what the worker's own device would show.
    if (row.submissionState !== 'SUBMITTED') {
      pendingMinutes += row.workedMinutes;
      pendingWorkers.add(row.logicalKey.employeeId);
      cust.pendingMinutes += row.workedMinutes;
      cust.pendingCount += 1;
      const names = siteWorkAreaNameByKey.get(key);
      blockers.push({
        reason: 'NOT_SUBMITTED',
        employeeId: row.logicalKey.employeeId,
        employeeName: row.employeeName,
        employeeNumber: row.employeeNumber,
        siteId: row.logicalKey.siteId,
        siteName: names?.siteName ?? '',
        workAreaId: row.logicalKey.workAreaId,
        workAreaName: names?.workAreaName ?? null,
        weekStart: row.logicalKey.weekStart,
        weekEnd: row.logicalKey.weekEnd
      });
      continue;
    }
    if (row.approvalState === 'APPROVED') {
      confirmedMinutes += row.workedMinutes;
      confirmedWorkers.add(row.logicalKey.employeeId);
      cust.confirmedMinutes += row.workedMinutes;
      let set = perCustomerConfirmedWorkers.get(key);
      if (!set) {
        set = new Set();
        perCustomerConfirmedWorkers.set(key, set);
      }
      set.add(row.logicalKey.employeeId);
      continue;
    }
    const reason: SummaryBlockerReason = row.approvalState === 'CHANGED_AFTER_APPROVAL' ? 'CHANGED_AFTER_APPROVAL' : row.approvalState === 'NEEDS_ATTENTION' ? 'NEEDS_ATTENTION' : 'PENDING';
    if (reason === 'CHANGED_AFTER_APPROVAL') {
      changedMinutes += row.workedMinutes;
      changedWorkers.add(row.logicalKey.employeeId);
      cust.changedMinutes += row.workedMinutes;
      cust.changedCount += 1;
    } else {
      pendingMinutes += row.workedMinutes;
      pendingWorkers.add(row.logicalKey.employeeId);
      cust.pendingMinutes += row.workedMinutes;
      cust.pendingCount += 1;
    }
    const names = siteWorkAreaNameByKey.get(key);
    blockers.push({
      reason,
      employeeId: row.logicalKey.employeeId,
      employeeName: row.employeeName,
      employeeNumber: row.employeeNumber,
      siteId: row.logicalKey.siteId,
      siteName: names?.siteName ?? '',
      workAreaId: row.logicalKey.workAreaId,
      workAreaName: names?.workAreaName ?? null,
      weekStart: row.logicalKey.weekStart,
      weekEnd: row.logicalKey.weekEnd
    });
  }
  for (const [key, set] of perCustomerConfirmedWorkers) {
    byCustomerMap.get(key)!.confirmedWorkerCount = set.size;
  }
  for (const [key, set] of perCustomerRecordedWorkers) {
    byCustomerMap.get(key)!.recordedWorkerCount = set.size;
  }

  for (const h of historicalOutcome.rows) {
    const key = `${h.siteId}::${h.workAreaId ?? ''}`;
    byCustomerMap.get(key)!.historicalCount += 1;
    if (h.reason !== 'SOURCE_UNREADABLE') continue; // SLICE_REMOVED never blocks — nothing left to confirm there
    blockers.push({
      reason: 'SOURCE_UNREADABLE',
      employeeId: h.employeeId,
      employeeName: h.employeeName,
      employeeNumber: h.employeeNumber,
      siteId: h.siteId,
      siteName: h.siteName,
      workAreaId: h.workAreaId,
      workAreaName: h.workAreaName,
      weekStart: h.weekStart,
      weekEnd: h.weekEnd
    });
  }

  for (const se of ledgerResult.sourceErrors) {
    blockers.push({
      reason: 'SOURCE_UNREADABLE',
      employeeId: se.employeeId,
      employeeName: se.employeeName,
      employeeNumber: se.employeeNumber,
      siteId: null,
      siteName: null,
      workAreaId: null,
      workAreaName: null,
      weekStart: null,
      weekEnd: null
    });
  }

  // UT8-B-fixup-2 — a NotSubmittedRow has no segments at all, hence no site/workArea attribution
  // (structurally the same reason SourceErrorRow's blocker leaves siteId/workAreaId null above) —
  // its "week" is really the whole period it covers, so weekStart/weekEnd reuse periodStartDate/
  // periodEndDate rather than a single week. Always a blocker: an expected worker with literally
  // nothing submitted must never be silently treated as "nothing to confirm, scope is fine".
  // UT8-B-fixup-3 #1 — `notSubmitted` (not ledgerResult.notSubmitted) so a site-scoped summary uses
  // the SiteAssignment-attributed list instead of the tier-2-filtered, possibly-incomplete one.
  for (const ns of notSubmitted) {
    blockers.push({
      reason: 'NOT_SUBMITTED',
      employeeId: ns.employeeId,
      employeeName: ns.employeeName,
      employeeNumber: ns.employeeNumber,
      siteId: null,
      siteName: null,
      workAreaId: null,
      workAreaName: null,
      weekStart: ns.periodStartDate,
      weekEnd: ns.periodEndDate
    });
  }

  // UT8-B-fixup #1 — historicalOutcome.truncated means MAX_HISTORICAL_ROWS was reached: there could
  // be more historical rows outside what was actually returned, and we have no way to know whether
  // any of the HIDDEN ones are SOURCE_UNREADABLE (which would need to block). Rather than silently
  // presenting the scope as ready, the whole final export is refused with its own explicit reason
  // until the filter is narrowed enough that the historical list is no longer truncated.
  if (historicalOutcome.truncated) {
    blockers.push({
      reason: 'HISTORICAL_INCOMPLETE',
      employeeId: '',
      employeeName: '',
      employeeNumber: '',
      siteId: null,
      siteName: null,
      workAreaId: null,
      workAreaName: null,
      weekStart: null,
      weekEnd: null
    });
  }

  const byCustomer = [...byCustomerMap.values()].sort((a, b) => `${a.siteName} ${a.workAreaName ?? ''}`.localeCompare(`${b.siteName} ${b.workAreaName ?? ''}`));

  // UT8-B-fixup-3 — notSubmittedCount/notSubmittedWorkerCount now cover BOTH NOT_SUBMITTED sources
  // (the entirely-missing `notSubmitted` list above and the submissionState-mismatched rows folded
  // into `blockers` in the main loop) by reading them back off the one already-complete `blockers`
  // array, rather than re-deriving a second, easy-to-desync count.
  const notSubmittedBlockers = blockers.filter((b) => b.reason === 'NOT_SUBMITTED');

  return {
    ok: true,
    requestedRange,
    effectiveWeekRange: ledgerResult.effectiveWeekRange!,
    rows,
    sourceErrors: ledgerResult.sourceErrors,
    historical: historicalOutcome.rows,
    notSubmitted,
    totals: {
      recordedMinutes,
      recordedWorkerCount: recordedWorkers.size,
      confirmedMinutes,
      pendingMinutes,
      changedMinutes,
      confirmedWorkerCount: confirmedWorkers.size,
      pendingWorkerCount: pendingWorkers.size,
      changedWorkerCount: changedWorkers.size,
      warningCount,
      sourceErrorCount: ledgerResult.sourceErrors.length,
      historicalCount: historicalOutcome.rows.length,
      historicalTruncated: historicalOutcome.truncated,
      notSubmittedCount: notSubmittedBlockers.length,
      notSubmittedWorkerCount: new Set(notSubmittedBlockers.map((b) => b.employeeId)).size
    },
    byCustomer,
    readyForCustomerExport: blockers.length === 0,
    blockers
  };
}
