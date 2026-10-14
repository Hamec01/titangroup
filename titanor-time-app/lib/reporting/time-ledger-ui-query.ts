// UT4-B (Titanor Time — единый табель) — the ONE pure function that turns the /admin/timesheets
// page's URL into both (a) a typed UI state and (b) the exact NormalizedTimeLedgerQuery the ledger
// API expects. Used identically by the initial Server Component render and every subsequent client
// fetch, so server and client can never disagree about what a given URL means (no hydration
// mismatch) — see TimesheetsLedgerPage.tsx / TimesheetsLedgerView.tsx.
//
// Deliberately UI-only concerns, separate from lib/reporting/time-ledger-query.ts (the strict HTTP
// API parser): this module understands `view`/date-range-as-1..4-Helsinki-weeks, that one does not
// and must not — the API stays a plain startDate/endDate/allTime contract regardless of how this
// page chooses to let an admin pick a range.
//
// Scope note: the TZ's "Доп. фильтры → произвольные даты" free-form date picker is NOT implemented
// in UT4-B — the 1/2/3/4-week quick selector plus arrows/"Текущая неделя" already gives full
// navigation over any past/future week range, and the fixup's own required feature list does not
// list a free date picker. Every date range this module can produce is therefore always a Monday
// start and an exact 7/14/21/28-day span. Flagged as deferred in the UT4-B report.

import type { NormalizedTimeLedgerQuery } from '@/lib/reporting/time-ledger';
import { utcIsoToHelsinkiDate } from '@/lib/helsinki-datetime';

export type TimeLedgerUiView = 'table' | 'summary';
export type WeeksOption = 1 | 2 | 3 | 4;

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
const WEEK_SPAN_DAYS: Record<WeeksOption, number> = { 1: 7, 2: 14, 3: 21, 4: 28 };

const VALID_STATUSES = new Set(['all', 'ready', 'needs_attention', 'approved', 'changed_after_approval', 'not_submitted', 'source_error']);
const VALID_SUBMISSION_STATES = new Set(['all', 'submitted', 'not_submitted']);
const VALID_SUBMISSION_SOURCES = new Set(['all', 'manual', 'auto']);
const PAGE_NUMBER_PATTERN = /^\d+$/;
/** UT4-B-fixup #5 — every supported UI query parameter, mirrored 1:1 against
 *  lib/reporting/time-ledger-query.ts's own SUPPORTED_PARAMS list (plus this page's own `view`),
 *  so a repeated parameter is rejected here exactly as strictly as the HTTP API already rejects it
 *  — never silently resolved to its first/last occurrence. */
const SUPPORTED_PARAMS = [
  'view',
  'allTime',
  'startDate',
  'endDate',
  'employeeSearch',
  'employeeId',
  'siteId',
  'workAreaId',
  'status',
  'onlyIssues',
  'onlyChangedAfterApproval',
  'submissionState',
  'submissionSource',
  'page',
  'pageSize'
] as const;

export interface TimeLedgerUiState {
  view: TimeLedgerUiView;
  allTime: boolean;
  /** Monday, YYYY-MM-DD. Null iff allTime. */
  startDate: string | null;
  /** Sunday, YYYY-MM-DD, always startDate + 6/13/20/27 days. Null iff allTime. */
  endDate: string | null;
  employeeSearch: string | null;
  /** UT9-B — exact employeeId deep-link filter (the TIMESHEET_AWAITING_APPROVAL notification's
   *  "Открыть в Табеле"). Never set by any filter control in this UI — only ever arrives via a URL
   *  the notification itself builds. */
  employeeId: string | null;
  siteId: string | null;
  workAreaId: string | 'none' | null;
  status: NormalizedTimeLedgerQuery['status'];
  onlyIssues: boolean;
  onlyChangedAfterApproval: boolean;
  submissionState: NormalizedTimeLedgerQuery['submissionState'];
  submissionSource: NormalizedTimeLedgerQuery['submissionSource'];
  page: number;
  pageSize: number;
}

export type ParseTimeLedgerUiStateResult = { ok: true; state: TimeLedgerUiState } | { ok: false };

// ---------------------------------------------------------------------------------------------
// Plain UTC-midnight calendar arithmetic (the project-wide convention once a Helsinki calendar
// date is already resolved to a YYYY-MM-DD string — see weekly-customer-slice.ts's own header
// comment). The only genuinely timezone-aware step is utcIsoToHelsinkiDate() below.
// ---------------------------------------------------------------------------------------------

function parseIsoDateUtc(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function formatIsoDateUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addUtcDays(iso: string, days: number): string {
  return formatIsoDateUtc(new Date(parseIsoDateUtc(iso).getTime() + days * 86400000));
}
function daysBetweenInclusive(startIso: string, endIso: string): number {
  return Math.round((parseIsoDateUtc(endIso).getTime() - parseIsoDateUtc(startIso).getTime()) / 86400000) + 1;
}
/** Monday-Sunday Helsinki week bounds for one calendar date — same 0=Mon..6=Sun convention as
 *  lib/reporting/weekly-customer-slice.ts's own helsinkiWeekBounds (kept as a small local copy,
 *  same "zero cross-module coupling" discipline established there, since this module is UI-only
 *  and must not depend on the pure-builder module). */
function mondayOfWeek(iso: string): string {
  const offset = (parseIsoDateUtc(iso).getUTCDay() + 6) % 7; // 0=Mon..6=Sun
  return addUtcDays(iso, -offset);
}
function sundayOfWeek(iso: string): string {
  return addUtcDays(mondayOfWeek(iso), 6);
}
/** UT4-B-fixup #1 — any valid (calendar-correct) startDate/endDate pair is accepted and normalized
 *  to the full Helsinki week(s) it touches: startDate down to that week's Monday, endDate up to
 *  that week's Sunday. A 1-4 week normalized result still lights up the matching quick-range
 *  button (weeksCountFromRange below); a wider one simply shows with no button active — both are
 *  valid, neither is rejected. Only a syntactically/calendrically invalid date is still rejected
 *  (isStrictCalendarDate below, unchanged). */
function normalizeToFullHelsinkiWeeks(startIso: string, endIso: string): { startDate: string; endDate: string } {
  return { startDate: mondayOfWeek(startIso), endDate: sundayOfWeek(endIso) };
}
function isStrictCalendarDate(iso: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const asDate = new Date(Date.UTC(y, m - 1, d));
  return asDate.getUTCFullYear() === y && asDate.getUTCMonth() === m - 1 && asDate.getUTCDate() === d;
}

/** The Monday-Sunday Helsinki week `now` falls in, as YYYY-MM-DD strings. */
export function currentHelsinkiWeekRange(now: Date): { startDate: string; endDate: string } {
  const todayIso = utcIsoToHelsinkiDate(now.toISOString());
  const mondayOffset = (parseIsoDateUtc(todayIso).getUTCDay() + 6) % 7; // 0=Mon..6=Sun
  const startDate = addUtcDays(todayIso, -mondayOffset);
  return { startDate, endDate: addUtcDays(startDate, 6) };
}

/** Same end date, start pushed back to cover `weeks` full weeks — TZ §5.1's own worked examples
 *  ("1 неделя: 21.09–27.09; 2 недели: 14.09–27.09; ...") anchor on the END, not the start. */
export function rangeForWeeksEndingAt(endDate: string, weeks: WeeksOption): { startDate: string; endDate: string } {
  return { startDate: addUtcDays(endDate, -(WEEK_SPAN_DAYS[weeks] - 1)), endDate };
}

/** Arrows: shift the whole range by its own full length so weeks can never overlap by accident. */
export function shiftRangeByOwnLength(startDate: string, endDate: string, direction: 1 | -1): { startDate: string; endDate: string } {
  const spanDays = daysBetweenInclusive(startDate, endDate);
  return { startDate: addUtcDays(startDate, direction * spanDays), endDate: addUtcDays(endDate, direction * spanDays) };
}

/** Which of the four quick-range buttons (if any) the given range currently matches — for
 *  highlighting the active one. Null for a range this module never produces itself (defensive). */
export function weeksCountFromRange(startDate: string, endDate: string): WeeksOption | null {
  const span = daysBetweenInclusive(startDate, endDate);
  const entry = (Object.entries(WEEK_SPAN_DAYS) as [string, number][]).find(([, days]) => days === span);
  return entry ? (Number(entry[0]) as WeeksOption) : null;
}

// ---------------------------------------------------------------------------------------------
// Parse — strict. A garbage/self-contradictory URL is `{ ok: false }`, never a silent default that
// changes meaning, and never a throw (the page shows "Некорректные параметры" + "Сбросить фильтры"
// instead of crashing — point 5 of the fixup).
// ---------------------------------------------------------------------------------------------

export function parseTimeLedgerUiState(searchParams: URLSearchParams, now: Date): ParseTimeLedgerUiStateResult {
  for (const name of SUPPORTED_PARAMS) {
    if (searchParams.getAll(name).length > 1) return { ok: false };
  }

  const viewRaw = searchParams.get('view');
  if (viewRaw !== null && viewRaw !== 'table' && viewRaw !== 'summary') return { ok: false };
  const view: TimeLedgerUiView = viewRaw === 'summary' ? 'summary' : 'table';

  const allTimeRaw = searchParams.get('allTime');
  if (allTimeRaw !== null && allTimeRaw !== 'true' && allTimeRaw !== 'false') return { ok: false };
  const allTimeRequested = allTimeRaw === 'true';

  const startDateRaw = searchParams.get('startDate');
  const endDateRaw = searchParams.get('endDate');

  let allTime = false;
  let startDate: string | null = null;
  let endDate: string | null = null;

  if (allTimeRequested) {
    if (startDateRaw !== null || endDateRaw !== null) return { ok: false }; // CONFLICTING_RANGE_PARAMETERS-equivalent
    allTime = true;
  } else if (startDateRaw === null && endDateRaw === null) {
    const wk = currentHelsinkiWeekRange(now);
    startDate = wk.startDate;
    endDate = wk.endDate;
  } else if (startDateRaw !== null && endDateRaw !== null) {
    if (!isStrictCalendarDate(startDateRaw) || !isStrictCalendarDate(endDateRaw)) return { ok: false };
    if (startDateRaw > endDateRaw) return { ok: false }; // mirrors the HTTP API's own startDate<=endDate rule
    const normalized = normalizeToFullHelsinkiWeeks(startDateRaw, endDateRaw);
    startDate = normalized.startDate;
    endDate = normalized.endDate;
  } else {
    return { ok: false }; // only one of startDate/endDate present — ambiguous
  }

  const employeeId = searchParams.get('employeeId');
  if (employeeId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(employeeId)) return { ok: false };

  const siteId = searchParams.get('siteId');
  if (siteId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteId)) return { ok: false };

  const workAreaIdRaw = searchParams.get('workAreaId');
  if (workAreaIdRaw !== null && workAreaIdRaw !== 'none' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workAreaIdRaw)) return { ok: false };

  const statusRaw = searchParams.get('status') ?? 'all';
  if (!VALID_STATUSES.has(statusRaw)) return { ok: false };

  const submissionStateRaw = searchParams.get('submissionState') ?? 'all';
  if (!VALID_SUBMISSION_STATES.has(submissionStateRaw)) return { ok: false };

  const submissionSourceRaw = searchParams.get('submissionSource') ?? 'all';
  if (!VALID_SUBMISSION_SOURCES.has(submissionSourceRaw)) return { ok: false };

  const onlyIssuesRaw = searchParams.get('onlyIssues');
  if (onlyIssuesRaw !== null && onlyIssuesRaw !== 'true' && onlyIssuesRaw !== 'false') return { ok: false };

  const onlyChangedRaw = searchParams.get('onlyChangedAfterApproval');
  if (onlyChangedRaw !== null && onlyChangedRaw !== 'true' && onlyChangedRaw !== 'false') return { ok: false };

  const pageRaw = searchParams.get('page');
  let page = 1;
  if (pageRaw !== null) {
    if (!PAGE_NUMBER_PATTERN.test(pageRaw) || Number(pageRaw) < 1) return { ok: false };
    page = Number(pageRaw);
  }

  const pageSizeRaw = searchParams.get('pageSize');
  let pageSize = DEFAULT_PAGE_SIZE;
  if (pageSizeRaw !== null) {
    if (!PAGE_NUMBER_PATTERN.test(pageSizeRaw) || Number(pageSizeRaw) < 1 || Number(pageSizeRaw) > MAX_PAGE_SIZE) return { ok: false };
    pageSize = Number(pageSizeRaw);
  }

  const employeeSearchRaw = searchParams.get('employeeSearch');
  const employeeSearch = employeeSearchRaw && employeeSearchRaw.trim().length > 0 ? employeeSearchRaw.trim() : null;

  return {
    ok: true,
    state: {
      view,
      allTime,
      startDate,
      endDate,
      employeeSearch,
      employeeId,
      siteId,
      workAreaId: workAreaIdRaw as 'none' | string | null,
      status: statusRaw as NormalizedTimeLedgerQuery['status'],
      onlyIssues: onlyIssuesRaw === 'true',
      onlyChangedAfterApproval: onlyChangedRaw === 'true',
      submissionState: submissionStateRaw as NormalizedTimeLedgerQuery['submissionState'],
      submissionSource: submissionSourceRaw as NormalizedTimeLedgerQuery['submissionSource'],
      page,
      pageSize
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Serialize — the exact inverse of parse, always emitting a consistent, minimal URL (defaults
// omitted). Used for every href/router.replace() call so server-rendered links and client
// navigation always agree byte-for-byte on the same state.
// ---------------------------------------------------------------------------------------------

export function uiStateToSearchParams(state: TimeLedgerUiState): URLSearchParams {
  const p = new URLSearchParams();
  if (state.view !== 'table') p.set('view', state.view);
  if (state.allTime) {
    p.set('allTime', 'true');
  } else {
    p.set('startDate', state.startDate as string);
    p.set('endDate', state.endDate as string);
  }
  if (state.employeeSearch) p.set('employeeSearch', state.employeeSearch);
  if (state.employeeId) p.set('employeeId', state.employeeId);
  if (state.siteId) p.set('siteId', state.siteId);
  if (state.workAreaId) p.set('workAreaId', state.workAreaId);
  if (state.status !== 'all') p.set('status', state.status);
  if (state.onlyIssues) p.set('onlyIssues', 'true');
  if (state.onlyChangedAfterApproval) p.set('onlyChangedAfterApproval', 'true');
  if (state.submissionState !== 'all') p.set('submissionState', state.submissionState);
  if (state.submissionSource !== 'all') p.set('submissionSource', state.submissionSource);
  if (state.page !== 1) p.set('page', String(state.page));
  if (state.pageSize !== DEFAULT_PAGE_SIZE) p.set('pageSize', String(state.pageSize));
  return p;
}

export function uiStateToHref(pathname: string, state: TimeLedgerUiState): string {
  const qs = uiStateToSearchParams(state).toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/** Convert the UI state into exactly the query shape lib/reporting/time-ledger.ts's getTimeLedger
 *  (and the /api/admin/time-ledger route) expect. */
export function uiStateToApiQuery(state: TimeLedgerUiState): NormalizedTimeLedgerQuery {
  return {
    allTime: state.allTime,
    requestedRange: state.allTime ? null : { startDate: state.startDate as string, endDate: state.endDate as string },
    employeeSearch: state.employeeSearch,
    employeeId: state.employeeId,
    workAreaId: state.workAreaId,
    siteId: state.siteId,
    status: state.status,
    onlyIssues: state.onlyIssues,
    onlyChangedAfterApproval: state.onlyChangedAfterApproval,
    submissionState: state.submissionState,
    submissionSource: state.submissionSource,
    page: state.page,
    pageSize: state.pageSize
  };
}

/** Build the /api/admin/time-ledger fetch URL (path + query string) for a given state. */
export function uiStateToApiUrl(state: TimeLedgerUiState): string {
  const q = uiStateToApiQuery(state);
  const p = new URLSearchParams();
  if (q.allTime) {
    p.set('allTime', 'true');
  } else {
    p.set('startDate', q.requestedRange!.startDate);
    p.set('endDate', q.requestedRange!.endDate);
  }
  if (q.employeeSearch) p.set('employeeSearch', q.employeeSearch);
  if (q.employeeId) p.set('employeeId', q.employeeId);
  if (q.siteId) p.set('siteId', q.siteId);
  if (q.workAreaId) p.set('workAreaId', q.workAreaId);
  if (q.status !== 'all') p.set('status', q.status);
  if (q.onlyIssues) p.set('onlyIssues', 'true');
  if (q.onlyChangedAfterApproval) p.set('onlyChangedAfterApproval', 'true');
  if (q.submissionState !== 'all') p.set('submissionState', q.submissionState);
  if (q.submissionSource !== 'all') p.set('submissionSource', q.submissionSource);
  p.set('page', String(q.page));
  p.set('pageSize', String(q.pageSize));
  return `/api/admin/time-ledger?${p.toString()}`;
}

/** UT7-B-fixup #2 / UT7-B-fixup-2 #4 — build the GET /api/admin/time-ledger/historical-approvals
 *  fetch URL for a given state: allTime/startDate/endDate/employeeSearch/siteId/workAreaId, PLUS
 *  status/onlyIssues/onlyChangedAfterApproval — the server needs these to decide whether historical
 *  rows are compatible with the active filter at all (isHistoricalCompatibleFilter); omitting them
 *  would make the server always see status='all' regardless of what the admin actually selected. No
 *  page/pageSize — this list is its own bounded query, not paginated like the main ledger. */
export function uiStateToHistoricalApiUrl(state: TimeLedgerUiState): string {
  const p = new URLSearchParams();
  if (state.allTime) {
    p.set('allTime', 'true');
  } else {
    p.set('startDate', state.startDate as string);
    p.set('endDate', state.endDate as string);
  }
  if (state.employeeSearch) p.set('employeeSearch', state.employeeSearch);
  if (state.siteId) p.set('siteId', state.siteId);
  if (state.workAreaId) p.set('workAreaId', state.workAreaId);
  if (state.status !== 'all') p.set('status', state.status);
  if (state.onlyIssues) p.set('onlyIssues', 'true');
  if (state.onlyChangedAfterApproval) p.set('onlyChangedAfterApproval', 'true');
  return `/api/admin/time-ledger/historical-approvals?${p.toString()}`;
}

/** UT8-B — the filter subset GET /api/admin/time-ledger/summary and its /export sibling accept:
 *  allTime/startDate/endDate/employeeSearch/siteId/workAreaId only — no status/onlyIssues/
 *  onlyChangedAfterApproval/page/pageSize (the summary always aggregates the whole matching scope
 *  with every status). allTime/an over-long range are passed through AS-IS (even when the current
 *  UI state has them) — the server is the one that rejects them (ALL_TIME_NOT_ALLOWED/
 *  RANGE_TOO_LARGE), which the Сводка tab then shows as an explicit "narrow the period" message,
 *  never silently substituting a different range itself. */
function summaryFilterParams(state: TimeLedgerUiState): URLSearchParams {
  const p = new URLSearchParams();
  if (state.allTime) {
    p.set('allTime', 'true');
  } else if (state.startDate && state.endDate) {
    p.set('startDate', state.startDate);
    p.set('endDate', state.endDate);
  }
  if (state.employeeSearch) p.set('employeeSearch', state.employeeSearch);
  if (state.siteId) p.set('siteId', state.siteId);
  if (state.workAreaId) p.set('workAreaId', state.workAreaId);
  return p;
}

export function uiStateToSummaryApiUrl(state: TimeLedgerUiState): string {
  return `/api/admin/time-ledger/summary?${summaryFilterParams(state).toString()}`;
}

export function uiStateToSummaryExportApiUrl(state: TimeLedgerUiState, format: 'csv' | 'pdf', mode: 'preview' | 'final' | 'recorded'): string {
  const p = summaryFilterParams(state);
  p.set('format', format);
  p.set('mode', mode);
  return `/api/admin/time-ledger/summary/export?${p.toString()}`;
}

/** Applies `changes` on top of `current`. Any change other than an explicit `page` change resets
 *  pagination back to 1 (point 5 — "при изменении фильтра сбрасывать page=1"). Callers that mean
 *  to change the date range must set `allTime`+`startDate`+`endDate` together. */
export function nextUiState(current: TimeLedgerUiState, changes: Partial<TimeLedgerUiState>): TimeLedgerUiState {
  const next: TimeLedgerUiState = { ...current, ...changes };
  if (!('page' in changes)) {
    next.page = 1;
  }
  return next;
}

export function defaultTimeLedgerUiState(now: Date): TimeLedgerUiState {
  const wk = currentHelsinkiWeekRange(now);
  return {
    view: 'table',
    allTime: false,
    startDate: wk.startDate,
    endDate: wk.endDate,
    employeeSearch: null,
    employeeId: null,
    siteId: null,
    workAreaId: null,
    status: 'all',
    onlyIssues: false,
    onlyChangedAfterApproval: false,
    submissionState: 'all',
    submissionSource: 'all',
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE
  };
}

/** Count of URL params that differ from a bare "current week, no filters" state — for the mobile
 *  "Фильтры (N)" badge. View/page/pageSize are navigation, not filters, and never counted. */
export function activeFilterCount(state: TimeLedgerUiState): number {
  let n = 0;
  if (state.employeeSearch) n += 1;
  if (state.employeeId) n += 1;
  if (state.siteId) n += 1;
  if (state.workAreaId) n += 1;
  if (state.status !== 'all') n += 1;
  if (state.onlyIssues) n += 1;
  if (state.onlyChangedAfterApproval) n += 1;
  if (state.submissionState !== 'all') n += 1;
  if (state.submissionSource !== 'all') n += 1;
  return n;
}
