// UT3-B-fixup (Titanor Time — единый табель и подтверждение часов по заказчику) — a real, strict,
// PURE parser for GET /api/admin/time-ledger's query string. Split out of route.ts specifically so
// it can be unit-tested directly (no NextRequest, no DB) — see scripts/_test-time-ledger-query.ts.
//
// "Strict" means: every supported parameter is validated for real (a genuine calendar date, an
// actual true|false|1|0 boolean, a real UUID, a known enum value), a parameter given more than once
// is rejected rather than silently taking the first/last occurrence, and a garbage value never
// silently falls back to a default — it is always a 400, never a quietly-substituted success.

import type { NormalizedTimeLedgerQuery } from '@/lib/reporting/time-ledger';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';

export interface TimeLedgerQueryParseError {
  code: string;
  message: string;
  fieldErrors?: Record<string, string[]>;
}

export type TimeLedgerQueryParseResult = { ok: true; query: NormalizedTimeLedgerQuery } | { ok: false; error: TimeLedgerQueryParseError };

const SUPPORTED_PARAMS = ['allTime', 'startDate', 'endDate', 'employeeSearch', 'employeeId', 'siteId', 'workAreaId', 'status', 'onlyIssues', 'onlyChangedAfterApproval', 'submissionState', 'submissionSource', 'page', 'pageSize'] as const;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
/** ~2 years, generous for a leap year (365*2 + 1). */
const MAX_EXPLICIT_RANGE_DAYS = 731;
const PAGE_NUMBER_PATTERN = /^\d+$/;
const VALID_STATUSES = new Set(['all', 'ready', 'needs_attention', 'approved', 'changed_after_approval', 'not_submitted', 'source_error']);
const VALID_SUBMISSION_STATES = new Set(['all', 'submitted', 'not_submitted']);
const VALID_SUBMISSION_SOURCES = new Set(['all', 'manual', 'auto']);

/** Documented boolean encoding: 'true'/'1' -> true, 'false'/'0' -> false, anything else -> null (invalid). */
function parseStrictBoolean(raw: string): boolean | null {
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return null;
}

/** A REAL calendar date, not just YYYY-MM-DD shape — rejects e.g. 2026-02-30 (Date's own rollover
 *  would otherwise silently turn it into 2026-03-02). */
function isStrictCalendarDate(iso: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const asDate = new Date(Date.UTC(y, m - 1, d));
  return asDate.getUTCFullYear() === y && asDate.getUTCMonth() === m - 1 && asDate.getUTCDate() === d;
}

function daysBetweenIsoDates(startIso: string, endIso: string): number {
  return Math.round((Date.parse(`${endIso}T00:00:00.000Z`) - Date.parse(`${startIso}T00:00:00.000Z`)) / 86400000);
}

export function parseTimeLedgerQuery(searchParams: URLSearchParams): TimeLedgerQueryParseResult {
  // Pass 1 — no supported parameter may be repeated. Checked before reading any value, so a
  // repeated parameter is never silently resolved to its first/last occurrence.
  const duplicateFieldErrors: Record<string, string[]> = {};
  for (const name of SUPPORTED_PARAMS) {
    if (searchParams.getAll(name).length > 1) {
      duplicateFieldErrors[name] = ['must not be repeated'];
    }
  }
  if (Object.keys(duplicateFieldErrors).length > 0) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'A query parameter was repeated.', fieldErrors: duplicateFieldErrors } };
  }

  // Pass 2 — every field validated for its own type/format independently, collecting every error
  // in one pass (so the caller sees the full picture in a single 400, not one field at a time).
  const fieldErrors: Record<string, string[]> = {};

  const allTimeRaw = searchParams.get('allTime');
  const allTime = allTimeRaw === null ? false : parseStrictBoolean(allTimeRaw);
  if (allTimeRaw !== null && allTime === null) {
    fieldErrors.allTime = ["must be 'true', 'false', '1', or '0'"];
  }
  // Used only to decide whether startDate/endDate are required below — an invalid allTime value is
  // already flagged above and will fail the request regardless of this fallback.
  const allTimeRequested = allTimeRaw === 'true' || allTimeRaw === '1';

  const startDateRaw = searchParams.get('startDate');
  const endDateRaw = searchParams.get('endDate');
  if (!allTimeRequested) {
    if (startDateRaw === null) fieldErrors.startDate = ['required, YYYY-MM-DD (or pass allTime=true)'];
    else if (!isStrictCalendarDate(startDateRaw)) fieldErrors.startDate = ['must be a real calendar date, YYYY-MM-DD'];
    if (endDateRaw === null) fieldErrors.endDate = ['required, YYYY-MM-DD (or pass allTime=true)'];
    else if (!isStrictCalendarDate(endDateRaw)) fieldErrors.endDate = ['must be a real calendar date, YYYY-MM-DD'];
    if (startDateRaw && endDateRaw && !fieldErrors.startDate && !fieldErrors.endDate && startDateRaw > endDateRaw) {
      fieldErrors.endDate = ['must be >= startDate'];
    }
  }

  const employeeIdParam = searchParams.get('employeeId');
  if (employeeIdParam !== null && !UUID_PATTERN.test(employeeIdParam)) {
    fieldErrors.employeeId = ['must be a UUID'];
  }

  const siteIdParam = searchParams.get('siteId');
  if (siteIdParam !== null && !UUID_PATTERN.test(siteIdParam)) {
    fieldErrors.siteId = ['must be a UUID'];
  }

  const workAreaIdParam = searchParams.get('workAreaId');
  if (workAreaIdParam !== null && workAreaIdParam !== 'none' && !UUID_PATTERN.test(workAreaIdParam)) {
    fieldErrors.workAreaId = ["must be a UUID or the literal 'none'"];
  }

  const statusParam = searchParams.get('status') ?? 'all';
  if (!VALID_STATUSES.has(statusParam)) {
    fieldErrors.status = [`must be one of: ${[...VALID_STATUSES].join(', ')}`];
  }

  const submissionStateParam = searchParams.get('submissionState') ?? 'all';
  if (!VALID_SUBMISSION_STATES.has(submissionStateParam)) {
    fieldErrors.submissionState = [`must be one of: ${[...VALID_SUBMISSION_STATES].join(', ')}`];
  }

  const submissionSourceParam = searchParams.get('submissionSource') ?? 'all';
  if (!VALID_SUBMISSION_SOURCES.has(submissionSourceParam)) {
    fieldErrors.submissionSource = [`must be one of: ${[...VALID_SUBMISSION_SOURCES].join(', ')}`];
  }

  const onlyIssuesRaw = searchParams.get('onlyIssues');
  const onlyIssues = onlyIssuesRaw === null ? false : parseStrictBoolean(onlyIssuesRaw);
  if (onlyIssuesRaw !== null && onlyIssues === null) {
    fieldErrors.onlyIssues = ["must be 'true', 'false', '1', or '0'"];
  }

  const onlyChangedRaw = searchParams.get('onlyChangedAfterApproval');
  const onlyChangedAfterApproval = onlyChangedRaw === null ? false : parseStrictBoolean(onlyChangedRaw);
  if (onlyChangedRaw !== null && onlyChangedAfterApproval === null) {
    fieldErrors.onlyChangedAfterApproval = ["must be 'true', 'false', '1', or '0'"];
  }

  const pageParam = searchParams.get('page');
  let page = 1;
  if (pageParam !== null) {
    if (!PAGE_NUMBER_PATTERN.test(pageParam) || Number(pageParam) < 1) {
      fieldErrors.page = ['must be a positive integer (>= 1)'];
    } else {
      page = Number(pageParam);
    }
  }

  const pageSizeParam = searchParams.get('pageSize');
  let pageSize = DEFAULT_PAGE_SIZE;
  if (pageSizeParam !== null) {
    if (!PAGE_NUMBER_PATTERN.test(pageSizeParam) || Number(pageSizeParam) < 1 || Number(pageSizeParam) > MAX_PAGE_SIZE) {
      fieldErrors.pageSize = [`must be an integer between 1 and ${MAX_PAGE_SIZE}`];
    } else {
      pageSize = Number(pageSizeParam);
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid query parameters.', fieldErrors } };
  }

  // Pass 3 — every field is individually well-formed now; check cross-field semantic conflicts,
  // each with its own dedicated error code (never folded into the generic VALIDATION_ERROR).
  if (allTimeRequested && (startDateRaw !== null || endDateRaw !== null)) {
    return { ok: false, error: { code: 'CONFLICTING_RANGE_PARAMETERS', message: 'allTime cannot be combined with startDate/endDate.' } };
  }

  let requestedRange: { startDate: string; endDate: string } | null = null;
  if (!allTimeRequested) {
    // startDateRaw/endDateRaw are guaranteed non-null and calendar-valid here (Pass 2 above).
    const days = daysBetweenIsoDates(startDateRaw as string, endDateRaw as string);
    if (days > MAX_EXPLICIT_RANGE_DAYS) {
      return { ok: false, error: { code: 'RANGE_TOO_LARGE', message: `Explicit date range must be ${MAX_EXPLICIT_RANGE_DAYS} days or fewer (about 2 years). Use allTime=true for a longer history.` } };
    }
    requestedRange = { startDate: startDateRaw as string, endDate: endDateRaw as string };
  }

  // status=not_submitted / status=source_error rows never carry a submissionSource (neither a
  // placeholder nor a DRAFT/RETURNED-submissionState slice has one) — combining either with a
  // specific submissionSource can never match anything.
  if ((statusParam === 'not_submitted' || statusParam === 'source_error') && submissionSourceParam !== 'all') {
    return { ok: false, error: { code: 'CONFLICTING_FILTER_PARAMETERS', message: `status=${statusParam} rows never carry a submissionSource; combining it with submissionSource=${submissionSourceParam} can never match anything.` } };
  }
  // status=not_submitted already means submissionState=NOT_SUBMITTED by construction (see point 2
  // of the UT3-B-fixup) — requesting submissionState=submitted at the same time is a contradiction.
  if (statusParam === 'not_submitted' && submissionStateParam === 'submitted') {
    return { ok: false, error: { code: 'CONFLICTING_FILTER_PARAMETERS', message: 'status=not_submitted can never match submissionState=submitted.' } };
  }
  // onlyChangedAfterApproval already requires kind=WEEKLY_CUSTOMER_SLICE with
  // approvalState=CHANGED_AFTER_APPROVAL — any other explicit status is a contradiction.
  if (onlyChangedAfterApproval === true && statusParam !== 'all' && statusParam !== 'changed_after_approval') {
    return { ok: false, error: { code: 'CONFLICTING_FILTER_PARAMETERS', message: `onlyChangedAfterApproval=true conflicts with status=${statusParam}.` } };
  }

  const employeeSearchRaw = searchParams.get('employeeSearch');
  const employeeSearch = employeeSearchRaw && employeeSearchRaw.trim().length > 0 ? employeeSearchRaw.trim() : null;

  return {
    ok: true,
    query: {
      allTime: allTimeRequested,
      requestedRange,
      employeeSearch,
      employeeId: employeeIdParam,
      workAreaId: workAreaIdParam === null ? null : (workAreaIdParam as 'none' | string),
      siteId: siteIdParam,
      status: statusParam as NormalizedTimeLedgerQuery['status'],
      onlyIssues: onlyIssues === true,
      onlyChangedAfterApproval: onlyChangedAfterApproval === true,
      submissionState: submissionStateParam as NormalizedTimeLedgerQuery['submissionState'],
      submissionSource: submissionSourceParam as NormalizedTimeLedgerQuery['submissionSource'],
      page,
      pageSize
    }
  };
}
