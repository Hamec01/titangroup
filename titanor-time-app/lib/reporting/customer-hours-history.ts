// UT7-B-fixup #2 — "Удалённые часы обязаны оставаться видимыми администратору". Once
// customer-hours-reconciliation.ts (UT7-B) supersedes a CustomerHoursApprovalItem because its
// logical key's slice disappeared or its Timesheet's source became unreadable, that logical key
// stops producing a WeeklyCustomerSliceRow at all (buildEntriesForTimesheets only ever emits a row
// for a slice buildWeeklyCustomerSlices actually built) — the approval history silently drops off
// the ledger. This module is a small, SEPARATE, bounded read path that finds exactly those
// now-orphaned approval records, scoped by the same siteId/workAreaId/employeeSearch/date-range
// filters as the main ledger query, so the admin can still see what used to be confirmed and why it
// is no longer shown as current hours.
//
// Deliberately NOT woven into lib/reporting/time-ledger.ts's own two-pass/chunked batch pipeline
// (TimeLedgerEntry/sortTupleFor/compareEntries/entrySignature): that pipeline's unified pagination
// across WeeklyCustomerSliceRow/NotSubmittedRow/SourceErrorRow is already a well-tested, delicate
// piece of machinery, and grafting a fourth entry kind onto it would touch a file well outside this
// fixup's scope for a feature that is inherently rare (only timesheets whose approved hours later
// vanished or became unreadable). Instead this is its own bounded query + its own
// GET /api/admin/time-ledger/historical-approvals, read by the client as an additional call
// alongside the main ledger fetch and merged into the matching CustomerGroupSection by (siteId,
// workAreaId) — see TimesheetsLedgerView.tsx. This second call is explicitly a SECONDARY,
// best-effort diagnostic source: TimesheetsLedgerPage.tsx never lets a failure here take down the
// main "Табель" (Promise.allSettled, not Promise.all), and the client clears/retries it
// independently of the main ledger fetch — see that file's header comments.
//
// UT7-B-fixup-2 #4 — historical rows represent "changed after approval" in spirit, so they are only
// resolved at all when the active status/issue filter is compatible with that state (see
// isHistoricalCompatibleFilter) — never shown under a filter that specifically asks for something
// else (only-approved, ready, not-submitted, ...).
//
// Query plan (no N+1, and no single logical key's long history can crowd out other keys):
//  1. groupBy(timesheetId, siteId, workAreaId, weekStart) over CustomerHoursApprovalItem, filtered
//     exactly like the main ledger's own Tier-1 filters (siteId/workAreaId/employeeSearch/weekStart
//     range) PLUS: every SUPERSEDED item (its logical key might have no CURRENT left at all), OR a
//     CURRENT item whose own Timesheet already has currentVersionId=null while not draft-sourced (the
//     one realistic, cheap-to-detect structural signal that this key's live slice cannot resolve
//     right now even though nothing was ever superseded — reconciliation only runs inside a submit,
//     so a source that becomes unreadable through some other means leaves any CURRENT item exactly as
//     it was, by design). Aggregated by _max(createdAt) and ordered by it descending, so the query
//     naturally returns the MOST RECENTLY touched logical keys first regardless of how many old
//     SUPERSEDED rows any single key happens to carry — a key with a long history can never push a
//     different key out of the result the way a flat "take N raw rows" scan could. take
//     MAX_HISTORICAL_ROWS + 1 groups, one more than the display limit, purely to detect truncation.
//  2. Re-fetch the one full row per returned group (matched by its own _max(createdAt)) with the
//     relations the response needs (employee/site/workArea/batch.approvedByUser) — a single
//     `findMany` with an OR of the (at most MAX_HISTORICAL_ROWS + 1) group keys, so still one query.
//  3. Resolve every candidate's LIVE state in one batched pass via
//     prepareWeeklyCustomerApprovalsBatch (UT6-B's existing batched loader — the same one mass
//     approval already uses to avoid N+1 across many distinct timesheets). ok:true means the slice
//     still exists live and matches normally (a CURRENT item that turned out to be readable after
//     all, or a SUPERSEDED-with-no-CURRENT item whose slice still exists — already shown normally as
//     CHANGED_AFTER_APPROVAL via matchApproval's mostRecent branch) — skip. !ok with reason
//     SLICE_NOT_FOUND -> genuinely removed. Any other !ok reason -> the timesheet's source is
//     technically unreadable right now.
//  4. Return the remaining candidates as read-only rows plus a `truncated` flag — never a write,
//     never a synthetic new CustomerHoursApprovalItem, and never a silently-incomplete list presented
//     as complete.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { approverName, type LedgerActor, type NormalizedTimeLedgerQuery } from '@/lib/reporting/time-ledger';
import { prepareWeeklyCustomerApprovalsBatch } from '@/lib/reporting/weekly-approval';

type Db = Prisma.TransactionClient | typeof prisma;

/** Generous but finite — this is an admin diagnostic view of an inherently rare condition (approved
 *  hours that later vanished or became unreadable), never a primary, high-volume list. Overridable
 *  only by a direct, server-side caller (the DB test suite) — GET .../historical-approvals never
 *  exposes this as a request parameter, so production behaviour is always this exact constant. */
const MAX_HISTORICAL_ROWS = 200;

export interface HistoricalApprovalRow {
  timesheetId: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  siteId: string;
  siteName: string;
  workAreaId: string | null;
  workAreaName: string | null;
  weekStart: string;
  weekEnd: string;
  reason: 'SLICE_REMOVED' | 'SOURCE_UNREADABLE';
  lastApproval: {
    fingerprint: string;
    workedMinutes: number;
    grossMinutes: number;
    breakMinutes: number;
    approvedAt: string;
    approvedByUserName: string;
  };
}

export interface HistoricalApprovalIssuesResult {
  rows: HistoricalApprovalRow[];
  /** true when more logical keys matched than MAX_HISTORICAL_ROWS could show — the caller must say
   *  so explicitly (UT7-B-fixup-2 #3) rather than silently presenting a partial list as complete. */
  truncated: boolean;
}

function parseIsoDateUtc(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function formatDateIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function logicalKeyString(timesheetId: string, siteId: string, workAreaId: string | null, weekStartIso: string): string {
  return `${timesheetId}::${siteId}::${workAreaId ?? ''}::${weekStartIso}`;
}

/**
 * UT7-B-fixup-2 #4 — historical rows are a "changed after approval" fact. Shown only when the
 * active status/issue filter is compatible with that state: status=all, status=changed_after_approval,
 * or either onlyChangedAfterApproval/onlyIssues explicitly asking for exactly this kind of thing.
 * Hidden under any other explicit status (only-approved, ready, not_submitted, needs_attention,
 * source_error) — those filters ask for something historical rows are definitionally not. Pure,
 * exported, directly unit-testable.
 */
export function isHistoricalCompatibleFilter(query: Pick<NormalizedTimeLedgerQuery, 'status' | 'onlyIssues' | 'onlyChangedAfterApproval'>): boolean {
  if (query.onlyChangedAfterApproval) return true;
  if (query.onlyIssues) return true;
  return query.status === 'all' || query.status === 'changed_after_approval';
}

export async function loadHistoricalApprovalIssues(
  query: Pick<NormalizedTimeLedgerQuery, 'allTime' | 'requestedRange' | 'employeeSearch' | 'siteId' | 'workAreaId' | 'status' | 'onlyIssues' | 'onlyChangedAfterApproval'>,
  actor: LedgerActor,
  db: Db = prisma,
  maxRows: number = MAX_HISTORICAL_ROWS
): Promise<HistoricalApprovalIssuesResult> {
  if (!isHistoricalCompatibleFilter(query)) return { rows: [], truncated: false };

  const where: Prisma.CustomerHoursApprovalItemWhereInput = {
    // Every SUPERSEDED item is a candidate (its logical key might have no CURRENT left at all — the
    // reconciliation-superseded case). A CURRENT item is normally already fully represented by a
    // normal ledger row and would never need to be a candidate — EXCEPT when its own Timesheet's
    // currentVersionId is already null while not a DRAFT: the one realistic, structural signal that
    // this specific logical key's live slice cannot resolve right now even though nothing was ever
    // superseded (reconciliation only ever runs inside a submit — a source that becomes unreadable
    // through some other means, e.g. a corrupted currentVersionId, leaves any CURRENT item exactly as
    // it was, by design — see customer-hours-reconciliation.ts's fixup #1 fast-path guard). This
    // structural check is cheap (an indexed equality on the joined Timesheet), unlike running the
    // full batched slice-resolution below against every healthy CURRENT item on every page load.
    // status not in (DRAFT, RETURNED) mirrors lib/reporting/canonical-source.ts's usesDraftSource
    // exactly — a RETURNED timesheet legitimately still carries a stale non-null currentVersionId
    // and reads the draft regardless, so it is never itself a "source unreadable" signal.
    OR: [{ approvalState: 'SUPERSEDED' }, { approvalState: 'CURRENT', timesheet: { currentVersionId: null, status: { notIn: ['DRAFT', 'RETURNED'] } } }]
  };
  if (query.siteId) where.siteId = query.siteId;
  if (query.workAreaId === 'none') where.workAreaId = null;
  else if (query.workAreaId) where.workAreaId = query.workAreaId;
  if (!query.allTime && query.requestedRange) {
    where.weekStart = { gte: parseIsoDateUtc(query.requestedRange.startDate), lte: parseIsoDateUtc(query.requestedRange.endDate) };
  }
  if (query.employeeSearch) {
    where.employee = {
      OR: [
        { firstName: { contains: query.employeeSearch, mode: 'insensitive' } },
        { lastName: { contains: query.employeeSearch, mode: 'insensitive' } },
        { employeeNumber: { contains: query.employeeSearch, mode: 'insensitive' } }
      ]
    };
  }

  // One row per logical key, ordered by its own most recent touch — a key with a long SUPERSEDED
  // history can never crowd another key out of this result, unlike a flat "take N raw rows" scan
  // followed by in-memory grouping would.
  const groups = await db.customerHoursApprovalItem.groupBy({
    by: ['timesheetId', 'siteId', 'workAreaId', 'weekStart'],
    where,
    _max: { createdAt: true },
    orderBy: { _max: { createdAt: 'desc' } },
    take: maxRows + 1
  });
  if (groups.length === 0) return { rows: [], truncated: false };

  const truncated = groups.length > maxRows;
  const shownGroups = groups.slice(0, maxRows);

  const candidateRows = await db.customerHoursApprovalItem.findMany({
    where: {
      OR: shownGroups.map((g) => ({ timesheetId: g.timesheetId, siteId: g.siteId, workAreaId: g.workAreaId, weekStart: g.weekStart, createdAt: g._max.createdAt as Date }))
    },
    orderBy: [{ id: 'desc' }], // defensive tie-break only — real ties (same key, same exact createdAt) are not expected
    select: {
      id: true,
      timesheetId: true,
      employeeId: true,
      siteId: true,
      workAreaId: true,
      weekStart: true,
      weekEnd: true,
      fingerprint: true,
      workedMinutes: true,
      grossMinutes: true,
      breakMinutes: true,
      employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
      site: { select: { name: true } },
      workArea: { select: { name: true } },
      batch: { select: { approvedAt: true, approvedByUser: { select: { username: true, employee: { select: { firstName: true, lastName: true } } } } } }
    }
  });

  const mostRecentByKey = new Map<string, (typeof candidateRows)[number]>();
  for (const row of candidateRows) {
    const key = logicalKeyString(row.timesheetId, row.siteId, row.workAreaId, formatDateIso(row.weekStart));
    if (!mostRecentByKey.has(key)) mostRecentByKey.set(key, row);
  }
  const candidates = [...mostRecentByKey.values()];
  if (candidates.length === 0) return { rows: [], truncated };

  // One batched round-trip resolves every candidate's LIVE state at once (UT6-B's existing batched
  // loader — the same infrastructure mass approval already uses to avoid N+1 across many distinct
  // timesheets). expectedFingerprint is a required field of the shared selection shape but is never
  // read for matchesExpectedFingerprint purposes here — only `ok`/`reason` are used below.
  const selection = candidates.map((c) => ({
    itemKey: { timesheetId: c.timesheetId, siteId: c.siteId, workAreaId: c.workAreaId, weekStart: formatDateIso(c.weekStart) },
    expectedFingerprint: '0'.repeat(64)
  }));
  const results = await prepareWeeklyCustomerApprovalsBatch({ selection, actor, mode: 'READ', db });

  const rows: HistoricalApprovalRow[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const result = results[i];
    if (result.ok) continue; // the slice still exists live -> already shown normally, not historical
    const reason: HistoricalApprovalRow['reason'] = result.reason === 'SLICE_NOT_FOUND' ? 'SLICE_REMOVED' : 'SOURCE_UNREADABLE';
    rows.push({
      timesheetId: c.timesheetId,
      employeeId: c.employeeId,
      employeeName: `${c.employee.lastName} ${c.employee.firstName}`.trim(),
      employeeNumber: c.employee.employeeNumber,
      siteId: c.siteId,
      siteName: c.site.name,
      workAreaId: c.workAreaId,
      workAreaName: c.workArea?.name ?? null,
      weekStart: formatDateIso(c.weekStart),
      weekEnd: formatDateIso(c.weekEnd),
      reason,
      lastApproval: {
        fingerprint: c.fingerprint,
        workedMinutes: c.workedMinutes,
        grossMinutes: c.grossMinutes,
        breakMinutes: c.breakMinutes,
        approvedAt: c.batch.approvedAt.toISOString(),
        approvedByUserName: approverName(c.batch)
      }
    });
  }
  return { rows, truncated };
}
