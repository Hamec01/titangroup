// UT3 (Titanor Time — единый табель и подтверждение часов по заказчику) — the read-only library
// behind GET /api/admin/time-ledger. Implements the plan fixed across checkpoints
// UT3-A / UT3-A-R1 / UT3-A-R2 (TITANOR_TIME_UNIFIED_TIMESHEET_UPDATE_TZ_RU.md). No mutation, no
// AuditEvent, no approval endpoint — this file only ever reads.
//
// Reuses, never duplicates: lib/reporting/canonical-source.ts (resolveCanonicalSource),
// lib/reporting/weekly-customer-slice.ts (buildWeeklyCustomerSlices, the only fingerprint/
// hours/break-allocation formula), lib/reporting/auto-break.ts (loadPlannedUnpaidBreakBySourceAndDate,
// the sourceId+date-safe lookup fixed in UT1), lib/timesheet-edit-window.ts, lib/not-submitted.ts.

import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { resolveCanonicalSource, usesDraftSource, type CanonicalSourceTimesheetInput } from '@/lib/reporting/canonical-source';
import {
  buildWeeklyCustomerSlices,
  enumerateHelsinkiWeeks,
  helsinkiWeekBounds,
  type BuildSlicesInput,
  type RawDay,
  type RawSegment,
  type WeeklyCustomerSlice
} from '@/lib/reporting/weekly-customer-slice';
import { loadAutoUnpaidBreakThresholdMinutes, loadPlannedUnpaidBreakBySourceAndDate } from '@/lib/reporting/auto-break';
import { computeTimesheetEditCutoff, isWorkerWithinEditWindow } from '@/lib/timesheet-edit-window';
import { loadMissingTimesheetParticipants, type MissingTimesheetParticipant } from '@/lib/reporting/not-submitted';
import { computeSiteScopeHasExceptionBulk } from '@/lib/review-scopes';

type Db = Prisma.TransactionClient | typeof prisma;

// =================================================================================================
// Public types — the normalized (already-validated by route.ts) query and the response contract.
// =================================================================================================

export interface NormalizedTimeLedgerQuery {
  allTime: boolean;
  requestedRange: { startDate: string; endDate: string } | null; // null iff allTime
  employeeSearch: string | null;
  /** UT9-B — exact employeeId match (never a substring), for precise deep-linking (the
   *  TIMESHEET_AWAITING_APPROVAL notification's "Открыть в Табеле" — see NotificationCenter.tsx)
   *  where employeeSearch's contains-match could theoretically surface more than the one intended
   *  worker. Applied together with employeeSearch (AND, not OR) whenever both are set — in
   *  practice only one is ever supplied by a real caller. */
  employeeId: string | null;
  workAreaId: string | 'none' | null;
  siteId: string | null;
  status: 'all' | 'ready' | 'needs_attention' | 'approved' | 'changed_after_approval' | 'not_submitted' | 'source_error';
  onlyIssues: boolean;
  onlyChangedAfterApproval: boolean;
  submissionState: 'all' | 'submitted' | 'not_submitted';
  submissionSource: 'all' | 'manual' | 'auto';
  page: number;
  pageSize: number;
}

export interface LedgerActor {
  userId: string;
  employeeId: string | null;
}

export interface LedgerIssue {
  code: string;
  message: string;
}

export interface DisplayDay {
  date: string;
  dayType: string;
  confirmedZero: boolean;
  segments: { startAt: string; endAt: string; breaks: { startAt: string; endAt: string; paid: boolean }[] }[];
  autoUnpaidBreakMinutes: number;
  /** UT4-B-fixup #3 — this day's total, sourced 1:1 from WeeklyCustomerSlice.dayTotals (the SAME
   *  applyPreallocatedBreak() pass that produces the slice-level totals above), never a second,
   *  independent per-segment recomputation. 0/0/0 on a day this slice has no segments for (that day
   *  is simply absent from dayTotals, same convention as payload.days). */
  grossMinutes: number;
  breakMinutes: number;
  workedMinutes: number;
}

export interface WeeklyCustomerSliceRow {
  kind: 'WEEKLY_CUSTOMER_SLICE';
  logicalKey: { employeeId: string; timesheetId: string; siteId: string; workAreaId: string | null; weekStart: string; weekEnd: string };
  employeeName: string;
  employeeNumber: string;
  submissionState: 'SUBMITTED' | 'NOT_SUBMITTED';
  approvalState: 'READY' | 'NEEDS_ATTENTION' | 'APPROVED' | 'CHANGED_AFTER_APPROVAL';
  workedMinutes: number;
  grossMinutes: number;
  breakMinutes: number;
  currentFingerprint: string;
  canonicalSource: { dataSource: 'DRAFT' | 'CURRENT_VERSION'; sourceId: string; sourceKind: 'DRAFT' | 'VERSION'; sourceRevision: string | null; versionNumber: number | null; submissionSource: 'MANUAL' | 'AUTO' | null };
  currentApprovalItem: { id: string; fingerprint: string; approvedAt: string; approvedByUserName: string } | null;
  lastHistoricalApproval: { id: string; fingerprint: string; approvedAt: string; approvedByUserName: string; approvalState: 'CURRENT' | 'SUPERSEDED' } | null;
  supersededFingerprintMatch: boolean;
  selfApprovalBlocked: boolean;
  eligibility: { canApprove: boolean };
  blockers: LedgerIssue[];
  warnings: LedgerIssue[];
  info: LedgerIssue[];
  displayDays: DisplayDay[];
}

export interface NotSubmittedRow {
  kind: 'NOT_SUBMITTED';
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  periodId: string;
  periodStartDate: string;
  periodEndDate: string;
  timesheetId: string | null;
  timesheetStatus: 'DRAFT' | 'RETURNED' | null;
  weeksCovered: string[];
}

export interface SourceErrorRow {
  kind: 'SOURCE_ERROR';
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  timesheetId: string;
  periodId: string;
  periodStartDate: string;
  periodEndDate: string;
  reason: string;
  workedMinutes: null;
  approvable: false;
}

export type TimeLedgerEntry = WeeklyCustomerSliceRow | NotSubmittedRow | SourceErrorRow;

export interface CustomerGroup {
  workAreaId: string | null;
  workAreaName: string | null;
  siteId: string;
  siteName: string;
  rows: WeeklyCustomerSliceRow[];
}

export interface TimeLedgerResult {
  requestedRange: { startDate: string; endDate: string } | null;
  effectiveWeekRange: { startDate: string; endDate: string } | null;
  dataRange: { startDate: string; endDate: string } | null;
  allTime: boolean;
  summary: {
    workerCount: number;
    entryCount: number;
    sliceCount: number;
    workedMinutes: number;
    readyCount: number;
    needsAttentionCount: number;
    approvedCount: number;
    changedAfterApprovalCount: number;
    notSubmittedEntryCount: number;
    notSubmittedWorkerCount: number;
    sourceErrorCount: number;
  };
  customerGroups: CustomerGroup[];
  notSubmitted: NotSubmittedRow[];
  sourceErrors: SourceErrorRow[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
}

/** Thrown when the two-pass chunked pipeline's hydration (Pass 2) detects that the underlying
 *  data changed since the descriptor pass — UT3-A-R2 §7/§2. Route maps this to 409. */
export class TimeLedgerReadChangedError extends Error {
  constructor(public readonly affectedEntryKeys: string[]) {
    super('TIME_LEDGER_READ_CHANGED_DURING_QUERY');
  }
}

/** Test-only hook (UT3-A-R2 §3 requirement 3): fires once, after Pass 1 (descriptor pass)
 *  completes and before Pass 2 (hydration) starts, inside the SAME library call — lets a test
 *  mutate the DB between the two passes of one in-process invocation, without a public HTTP
 *  parameter. The production route never passes this. */
export interface TimeLedgerOptions {
  afterDescriptorPass?: () => Promise<void>;
  /** Overrides the internal chunk size — production never sets this; tests use a small value to
   *  exercise multi-chunk behavior without needing hundreds of fixture rows. */
  chunkSize?: number;
}

const DEFAULT_CHUNK_SIZE = 200;
/** 4 full weeks — the fast-path/chunked boundary fixed in UT3-A-R2 §8. */
const FAST_PATH_MAX_WEEKS = 4;

// =================================================================================================
// Small local helpers — date formatting, canonical JSON (same recipe as
// lib/reporting/weekly-customer-slice.ts's own local copy; kept as ANOTHER small local copy rather
// than an export from that module, same "zero cross-module coupling for a six-line helper"
// discipline already established there).
// =================================================================================================

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function parseIsoDateUtc(iso: string): Date {
  const [y, m, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}
function canonicalJsonStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJsonStringify(value)).digest('hex');
}
function employeeDisplayName(first: string, last: string): string {
  return `${last} ${first}`.trim();
}

// =================================================================================================
// Global comparator (UT3-A-R2 §6) — one structured tuple, one function, used identically by fast
// path, chunked Pass 1 (sorting the full descriptor list after all chunks), and page reshaping.
// Never a concatenated free-text string — every field compared independently.
// =================================================================================================

export interface SortTuple {
  groupRank: 0 | 1 | 2; // 0 = real customer (slice), 1 = NOT_SUBMITTED, 2 = SOURCE_ERROR
  siteId: string | null;
  workAreaSortKey: string; // '' = "Без заказчика"; meaningful only at groupRank 0
  weekOrPeriodStart: string;
  employeeDisplayName: string;
  employeeId: string;
  timesheetOrPeriodId: string;
  entryDiscriminant: string; // absolute, unique tie-break
}

export function compareEntries(a: SortTuple, b: SortTuple): number {
  return (
    a.groupRank - b.groupRank ||
    (a.siteId ?? '').localeCompare(b.siteId ?? '') ||
    a.workAreaSortKey.localeCompare(b.workAreaSortKey) ||
    a.weekOrPeriodStart.localeCompare(b.weekOrPeriodStart) ||
    a.employeeDisplayName.localeCompare(b.employeeDisplayName) ||
    a.employeeId.localeCompare(b.employeeId) ||
    a.timesheetOrPeriodId.localeCompare(b.timesheetOrPeriodId) ||
    a.entryDiscriminant.localeCompare(b.entryDiscriminant)
  );
}

export function sortTupleFor(entry: TimeLedgerEntry): SortTuple {
  if (entry.kind === 'WEEKLY_CUSTOMER_SLICE') {
    return {
      groupRank: 0,
      siteId: entry.logicalKey.siteId,
      workAreaSortKey: entry.logicalKey.workAreaId ?? '',
      weekOrPeriodStart: entry.logicalKey.weekStart,
      employeeDisplayName: entry.employeeName,
      employeeId: entry.logicalKey.employeeId,
      timesheetOrPeriodId: entry.logicalKey.timesheetId,
      entryDiscriminant: `SLICE:${entry.logicalKey.employeeId}:${entry.logicalKey.timesheetId}:${entry.logicalKey.siteId}:${entry.logicalKey.workAreaId ?? ''}:${entry.logicalKey.weekStart}`
    };
  }
  if (entry.kind === 'NOT_SUBMITTED') {
    return {
      groupRank: 1,
      siteId: null,
      workAreaSortKey: '',
      weekOrPeriodStart: entry.periodStartDate,
      employeeDisplayName: entry.employeeName,
      employeeId: entry.employeeId,
      timesheetOrPeriodId: entry.periodId,
      entryDiscriminant: `NOT_SUBMITTED:${entry.employeeId}:${entry.periodId}`
    };
  }
  return {
    groupRank: 2,
    siteId: null,
    workAreaSortKey: '',
    weekOrPeriodStart: entry.periodStartDate,
    employeeDisplayName: entry.employeeName,
    employeeId: entry.employeeId,
    timesheetOrPeriodId: entry.timesheetId,
    entryDiscriminant: `SOURCE_ERROR:${entry.employeeId}:${entry.timesheetId}`
  };
}

/** UT3-A-R2 §2 (requirement 2) — the consistency signature. Everything Tier-2/summary/ordering/
 *  eligibility/blockers/warnings/submissionState/approvalState/minutes/display-metadata/
 *  logicalKey/canonical-source-identity depend on. Explicitly EXCLUDES displayDays (the only
 *  "heavy" part) — that is what makes a descriptor light. */
export function entrySignature(entry: TimeLedgerEntry): string {
  const { ...rest } = entry as WeeklyCustomerSliceRow;
  if (entry.kind === 'WEEKLY_CUSTOMER_SLICE') {
    const { displayDays: _displayDays, ...withoutDisplayDays } = rest;
    void _displayDays;
    return digest(withoutDisplayDays);
  }
  return digest(entry);
}

// =================================================================================================
// Canonical source batch-load (UT3-A §5 / UT3-A-R2 confirmation) — the one place Timesheet rows
// become RawDay[] input for buildWeeklyCustomerSlices. Shared by fast path and every chunk of the
// chunked path — never called per-row.
// =================================================================================================

// UT5-B — exported (along with several of this section's siblings below) so the new single-slice
// approval orchestration (lib/reporting/weekly-approval.ts) reuses the EXACT same canonical-source
// loading / blocker-warning rules the batch read pipeline already uses, rather than a second
// diverging copy (UT5-A-R1 §10 "shared preparation service"). The batch pipeline itself
// (buildEntriesForTimesheets, runFastPath/runChunkedPath) stays private and unchanged — only the
// underlying rules/loaders it already calls become part of this module's public surface.
export interface TimesheetRow {
  id: string;
  status: string;
  employeeId: string;
  periodId: string;
  currentVersionId: string | null;
  employee: { firstName: string; lastName: string; employeeNumber: string };
  period: { startDate: Date; endDate: Date; status: string };
  draft: { id: string; contentRevision: bigint } | null;
  currentVersion: { id: string; versionNumber: number; submissionSource: string | null } | null;
}

export const TIMESHEET_SELECT = {
  id: true,
  status: true,
  employeeId: true,
  periodId: true,
  currentVersionId: true,
  employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
  period: { select: { startDate: true, endDate: true, status: true } },
  draft: { select: { id: true, contentRevision: true } },
  currentVersion: { select: { id: true, versionNumber: true, submissionSource: true } }
} satisfies Prisma.TimesheetSelect;

export interface CanonicalBatch {
  rawDaysByTimesheetId: Map<string, RawDay[]>;
  sourceIdByTimesheetId: Map<string, string>;
  /** Timesheets whose resolveCanonicalSource() call threw (missing draft/currentVersion row) —
   *  the SOURCE_ERROR case. Message is already a clean, stable, pre-written identifier string
   *  (REPORT_CANONICAL_SOURCE_INVARIANT_FAILURE: ...), never a stack trace or DB internals, so it
   *  is safe to expose as-is in a SourceErrorRow.reason (point 6). */
  sourceErrorByTimesheetId: Map<string, string>;
  plannedUnpaidBreakBySourceAndDate: Map<string, number>;
  autoBreakThresholdMinutes: number;
}

export async function loadCanonicalBatch(timesheets: TimesheetRow[], db: Prisma.TransactionClient | typeof prisma = prisma): Promise<CanonicalBatch> {
  const draftIds: string[] = [];
  const versionIds: string[] = [];
  const sourceIdByTimesheetId = new Map<string, string>();
  const sourceErrorByTimesheetId = new Map<string, string>();

  for (const t of timesheets) {
    const input: CanonicalSourceTimesheetInput = { id: t.id, status: t.status, currentVersionId: t.currentVersionId, draft: t.draft ? { id: t.draft.id } : null, currentVersion: t.currentVersion };
    try {
      const identity = resolveCanonicalSource(input);
      if (identity.dataSource === 'DRAFT' && identity.draftId) {
        draftIds.push(identity.draftId);
        sourceIdByTimesheetId.set(t.id, identity.draftId);
      } else if (identity.dataSource === 'CURRENT_VERSION' && identity.versionId) {
        versionIds.push(identity.versionId);
        sourceIdByTimesheetId.set(t.id, identity.versionId);
      }
    } catch (err) {
      sourceErrorByTimesheetId.set(t.id, err instanceof Error ? err.message : String(err));
    }
  }

  const [versionDays, draftDays, plannedUnpaidBreakBySourceAndDate, autoBreakThresholdMinutes] = await Promise.all([
    versionIds.length
      ? db.timesheetDay.findMany({
          where: { timesheetVersionId: { in: versionIds } },
          select: {
            timesheetVersionId: true,
            date: true,
            dayType: true,
            confirmedZero: true,
            segments: { select: { id: true, startAt: true, endAt: true, siteId: true, workAreaId: true, breaks: { select: { startAt: true, endAt: true, paid: true } } } }
          }
        })
      : Promise.resolve([]),
    draftIds.length
      ? db.timesheetDraftDay.findMany({
          where: { draftId: { in: draftIds } },
          select: {
            draftId: true,
            date: true,
            dayType: true,
            confirmedZero: true,
            segments: { select: { id: true, startAt: true, endAt: true, siteId: true, workAreaId: true, breaks: { select: { startAt: true, endAt: true, paid: true } } } }
          }
        })
      : Promise.resolve([]),
    loadPlannedUnpaidBreakBySourceAndDate({ versionIds, draftIds }, db),
    loadAutoUnpaidBreakThresholdMinutes(db)
  ]);

  const rawDaysByVersionId = new Map<string, RawDay[]>();
  for (const d of versionDays) {
    const list = rawDaysByVersionId.get(d.timesheetVersionId) ?? [];
    list.push({
      date: d.date,
      dayType: d.dayType,
      confirmedZero: d.confirmedZero,
      segments: d.segments.map((s): RawSegment => ({ id: s.id, startAt: s.startAt, endAt: s.endAt, siteId: s.siteId, workAreaId: s.workAreaId, breaks: s.breaks }))
    });
    rawDaysByVersionId.set(d.timesheetVersionId, list);
  }
  const rawDaysByDraftId = new Map<string, RawDay[]>();
  for (const d of draftDays) {
    const list = rawDaysByDraftId.get(d.draftId) ?? [];
    list.push({
      date: d.date,
      dayType: d.dayType,
      confirmedZero: d.confirmedZero,
      segments: d.segments.map((s): RawSegment => ({ id: s.id, startAt: s.startAt, endAt: s.endAt, siteId: s.siteId, workAreaId: s.workAreaId, breaks: s.breaks }))
    });
    rawDaysByDraftId.set(d.draftId, list);
  }

  const rawDaysByTimesheetId = new Map<string, RawDay[]>();
  for (const t of timesheets) {
    const sourceId = sourceIdByTimesheetId.get(t.id);
    if (!sourceId) continue;
    const days = usesDraftSource(t.status) ? (rawDaysByDraftId.get(sourceId) ?? []) : (rawDaysByVersionId.get(sourceId) ?? []);
    rawDaysByTimesheetId.set(t.id, days);
  }

  return { rawDaysByTimesheetId, sourceIdByTimesheetId, sourceErrorByTimesheetId, plannedUnpaidBreakBySourceAndDate, autoBreakThresholdMinutes };
}

// =================================================================================================
// displayDays (UT3-A-R2 §8) — always 7 days Mon..Sun, segments scoped strictly to this slice's own
// (siteId, workAreaId); dayType/confirmedZero are legitimate shared day-level facts (one
// TimesheetDay serves the whole employee-day, not one customer), never another customer's segments.
// =================================================================================================

function buildDisplayDays(weekStart: string, weekEnd: string, allRawDaysOfEmployeeWeek: RawDay[], siteId: string, workAreaId: string | null): DisplayDay[] {
  const byDate = new Map<string, RawDay>();
  for (const d of allRawDaysOfEmployeeWeek) byDate.set(formatDate(d.date), d);

  const out: DisplayDay[] = [];
  let cursor = parseIsoDateUtc(weekStart);
  const end = parseIsoDateUtc(weekEnd);
  while (cursor <= end) {
    const dateIso = formatDate(cursor);
    const raw = byDate.get(dateIso);
    const ownSegments = (raw?.segments ?? []).filter((s) => s.siteId === siteId && s.workAreaId === workAreaId);
    out.push({
      date: dateIso,
      dayType: raw?.dayType ?? 'WORK',
      confirmedZero: raw?.confirmedZero ?? false,
      segments: [...ownSegments]
        .sort((a, b) => a.startAt.getTime() - b.startAt.getTime() || a.endAt.getTime() - b.endAt.getTime() || a.id.localeCompare(b.id))
        .map((s) => ({ startAt: s.startAt.toISOString(), endAt: s.endAt.toISOString(), breaks: s.breaks.map((b) => ({ startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), paid: b.paid })) })),
      // Filled in by the caller once the slice's own per-day totals are known (buildWeeklyCustomerSlices
      // already computed them — see buildDisplayDaysForSlice below).
      autoUnpaidBreakMinutes: 0,
      grossMinutes: 0,
      breakMinutes: 0,
      workedMinutes: 0
    });
    cursor = new Date(cursor.getTime() + 86400000);
  }
  return out;
}

// =================================================================================================
// Approval matching (UT3-A-R2 §7/§9) — batch query bounded by timesheetId + weekStart, ordered
// batch.approvedAt DESC, createdAt DESC, id DESC. Implements the SUPERSEDED-only fix from
// UT3-A-R1 §3 / UT3-A-R2 §7.
// =================================================================================================

export interface ApprovalItemRow {
  id: string;
  timesheetId: string;
  siteId: string;
  workAreaId: string | null;
  weekStart: Date;
  fingerprint: string;
  approvalState: string;
  batch: { approvedAt: Date; approvedByUser: { username: string; employee: { firstName: string; lastName: string } | null } };
}

export async function loadApprovalItems(timesheetIds: string[], weekStarts: Date[], db: Prisma.TransactionClient | typeof prisma = prisma): Promise<Map<string, ApprovalItemRow[]>> {
  const byKey = new Map<string, ApprovalItemRow[]>();
  if (timesheetIds.length === 0 || weekStarts.length === 0) return byKey;

  const rows = await db.customerHoursApprovalItem.findMany({
    where: { timesheetId: { in: timesheetIds }, weekStart: { in: weekStarts } },
    orderBy: [{ batch: { approvedAt: 'desc' } }, { createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      timesheetId: true,
      siteId: true,
      workAreaId: true,
      weekStart: true,
      fingerprint: true,
      approvalState: true,
      batch: { select: { approvedAt: true, approvedByUser: { select: { username: true, employee: { select: { firstName: true, lastName: true } } } } } }
    }
  });

  for (const r of rows) {
    const key = `${r.timesheetId}::${r.siteId}::${r.workAreaId ?? ''}::${formatDate(r.weekStart)}`;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }
  return byKey;
}

export function approverName(batch: ApprovalItemRow['batch']): string {
  return batch.approvedByUser.employee ? `${batch.approvedByUser.employee.firstName} ${batch.approvedByUser.employee.lastName}`.trim() : batch.approvedByUser.username;
}

export interface ApprovalMatch {
  approvalState: 'READY' | 'NEEDS_ATTENTION' | 'APPROVED' | 'CHANGED_AFTER_APPROVAL';
  currentApprovalItem: WeeklyCustomerSliceRow['currentApprovalItem'];
  lastHistoricalApproval: WeeklyCustomerSliceRow['lastHistoricalApproval'];
  supersededFingerprintMatch: boolean;
}

export function matchApproval(slice: WeeklyCustomerSlice, items: ApprovalItemRow[]): ApprovalMatch {
  const current = items.find((i) => i.approvalState === 'CURRENT') ?? null;
  const mostRecent = items[0] ?? null; // already ordered batch.approvedAt DESC, createdAt DESC, id DESC

  const toApprovalItemDto = (i: ApprovalItemRow) => ({ id: i.id, fingerprint: i.fingerprint, approvedAt: i.batch.approvedAt.toISOString(), approvedByUserName: approverName(i.batch) });
  const currentApprovalItem = current ? toApprovalItemDto(current) : null;
  const lastHistoricalApproval = mostRecent ? { ...toApprovalItemDto(mostRecent), approvalState: mostRecent.approvalState as 'CURRENT' | 'SUPERSEDED' } : null;

  let approvalState: ApprovalMatch['approvalState'];
  let supersededFingerprintMatch = false;

  if (current) {
    approvalState = current.fingerprint === slice.fingerprint ? 'APPROVED' : 'CHANGED_AFTER_APPROVAL';
  } else if (mostRecent) {
    if (mostRecent.fingerprint === slice.fingerprint) {
      approvalState = 'NEEDS_ATTENTION';
      supersededFingerprintMatch = true;
    } else {
      approvalState = 'CHANGED_AFTER_APPROVAL';
    }
  } else {
    approvalState = 'READY'; // refined to NEEDS_ATTENTION by blockers in classifyIssues
  }

  return { approvalState, currentApprovalItem, lastHistoricalApproval, supersededFingerprintMatch };
}

// =================================================================================================
// Small shared loaders (blockers/warnings inputs) — always batched by the CURRENT chunk's
// timesheetIds, never queried per-row (point 9: query count must scale with chunk count, not
// entry count).
// =================================================================================================

export async function loadOpenAttendanceExceptionsByTimesheet(timesheetIds: string[], db: Db): Promise<Map<string, { id: string; type: string; occurredAt: Date }[]>> {
  const map = new Map<string, { id: string; type: string; occurredAt: Date }[]>();
  if (timesheetIds.length === 0) return map;
  const rows = await db.attendanceException.findMany({
    where: { timesheetId: { in: timesheetIds }, status: 'OPEN' },
    select: { id: true, type: true, timesheetId: true, occurredAt: true }
  });
  for (const r of rows) {
    if (!r.timesheetId) continue;
    const list = map.get(r.timesheetId) ?? [];
    list.push({ id: r.id, type: r.type, occurredAt: r.occurredAt });
    map.set(r.timesheetId, list);
  }
  return map;
}

const OPEN_CORRECTION_STATUSES = ['PENDING', 'DRAFT_OPEN', 'SUBMITTED'] as const;

export async function loadOpenCorrectionRequestTimesheetIds(timesheetIds: string[], db: Db): Promise<Set<string>> {
  if (timesheetIds.length === 0) return new Set();
  const rows = await db.correctionRequest.findMany({
    where: { timesheetId: { in: timesheetIds }, status: { in: [...OPEN_CORRECTION_STATUSES] } },
    select: { timesheetId: true }
  });
  return new Set(rows.map((r) => r.timesheetId));
}

export interface EditWindowPolicy {
  cutoffDaysAfterPeriodEnd: number;
  cutoffTime: Date;
}

export async function loadEditWindowPolicy(db: Db): Promise<EditWindowPolicy> {
  const policy = await db.companyAttendancePolicy.findFirst({ select: { cutoffDaysAfterPeriodEnd: true, cutoffTime: true } });
  return {
    cutoffDaysAfterPeriodEnd: policy?.cutoffDaysAfterPeriodEnd ?? 1,
    cutoffTime: policy?.cutoffTime ?? new Date(Date.UTC(1970, 0, 1, 23, 59, 0))
  };
}

export interface OpenShiftInfo {
  siteId: string;
  workAreaId: string | null;
  openedAt: Date;
}

/** Point 5 — EmployeeOpenShift.employeeId is that table's own primary key (one open shift per
 *  employee at most), so one IN-list query covers the whole batch regardless of size — no N+1. */
export async function loadOpenShiftsByEmployee(employeeIds: string[], db: Db): Promise<Map<string, OpenShiftInfo>> {
  const map = new Map<string, OpenShiftInfo>();
  if (employeeIds.length === 0) return map;
  const rows = await db.employeeOpenShift.findMany({
    where: { employeeId: { in: employeeIds } },
    select: { employeeId: true, siteId: true, workAreaId: true, openedAt: true }
  });
  for (const r of rows) {
    map.set(r.employeeId, { siteId: r.siteId, workAreaId: r.workAreaId, openedAt: r.openedAt });
  }
  return map;
}

// =================================================================================================
// Blockers / warnings / info classification (UT3-A-R2 §9, restoring the TZ §9.2 warning list).
// AttendanceException is never re-diagnosed here — any OPEN exception scoped to this timesheet AND
// this slice's own week is surfaced as a warning verbatim (point 5: EXCESSIVE_SHIFT_DURATION is
// already one of these types, generated by lib/attendance-clock.ts's own exact
// maxShiftDurationHours comparison — no separate threshold reimplemented here).
// =================================================================================================

export interface IssueClassificationContext {
  actor: LedgerActor;
  openExceptionsByTimesheetId: Map<string, { id: string; type: string; occurredAt: Date }[]>;
  openCorrectionTimesheetIds: Set<string>;
  editWindowPolicy: EditWindowPolicy;
  openShiftByEmployee: Map<string, OpenShiftInfo>;
  /** Point 6 — keyed exactly as computeSiteScopeHasExceptionBulk's own Map: `${timesheetVersionId}:${siteId}`.
   *  VERSION-sourced slices only; DRAFT-sourced slices have no comparable plan/actual formula and
   *  are deliberately left out of this map (never looked up), see classifyIssues below. */
  planActualMismatchByScope: Map<string, boolean>;
}

export interface IssueClassificationResult {
  blockers: LedgerIssue[];
  warnings: LedgerIssue[];
  info: LedgerIssue[];
  selfApprovalBlocked: boolean;
}

// UT6-A-R1 §1 — owner decision: self-approval, an open shift, and an open correction request are no
// longer blockers for weekly customer hours approval. The admin sees the reason and must click
// "Всё равно подтвердить" (confirm anyway), same as any other warning; the admin explicitly accepts
// responsibility for that decision. This function is the ONE shared classifier for both the batch
// GET /api/admin/time-ledger pipeline and every weekly-approval preview/commit (single- and
// mass-item) — reclassifying here changes both call sites identically, by design, rather than
// forking a second "mass-only" policy for the exact same condition.
export function classifyIssues(
  t: TimesheetRow,
  slice: WeeklyCustomerSlice,
  submissionSource: 'MANUAL' | 'AUTO' | null,
  supersededFingerprintMatch: boolean,
  isDraftSourced: boolean,
  sourceId: string,
  ctx: IssueClassificationContext
): IssueClassificationResult {
  const blockers: LedgerIssue[] = [];
  const warnings: LedgerIssue[] = [];
  const info: LedgerIssue[] = [];

  // selfApprovalBlocked keeps its established name/shape (WeeklyCustomerSliceRow.selfApprovalBlocked
  // is read elsewhere as a plain fact flag) even though it no longer blocks anything on its own —
  // renaming it is not part of this decision, and the warning it now produces is the actual signal.
  const selfApprovalBlocked = ctx.actor.employeeId !== null && ctx.actor.employeeId === slice.logicalKey.employeeId;
  if (selfApprovalBlocked) {
    warnings.push({ code: 'SELF_APPROVAL_FORBIDDEN', message: 'An admin is approving their own hours.' });
  }

  if (ctx.openCorrectionTimesheetIds.has(t.id)) {
    warnings.push({ code: 'OPEN_CORRECTION_REQUEST', message: 'This timesheet has an open or in-progress correction request.' });
  }

  const weekStartMs = parseIsoDateUtc(slice.logicalKey.weekStart).getTime();
  const weekEndExclusiveMs = parseIsoDateUtc(slice.logicalKey.weekEnd).getTime() + 86400000;

  // Point 5 — an OPEN_SHIFT blocker only when the open shift genuinely belongs to THIS slice: same
  // employee (implicit — openShiftByEmployee is already keyed by employeeId), same site, same
  // workArea, and opened within this slice's own week. A shift open for a DIFFERENT customer/site,
  // or outside this week, never blocks an unrelated slice.
  const openShift = ctx.openShiftByEmployee.get(slice.logicalKey.employeeId);
  if (
    openShift &&
    openShift.siteId === slice.logicalKey.siteId &&
    openShift.workAreaId === slice.logicalKey.workAreaId &&
    openShift.openedAt.getTime() >= weekStartMs &&
    openShift.openedAt.getTime() < weekEndExclusiveMs
  ) {
    warnings.push({ code: 'OPEN_SHIFT', message: 'This employee has an open (unclosed) shift for this site/customer within this week.' });
  }

  const exceptionsInWeek = (ctx.openExceptionsByTimesheetId.get(t.id) ?? []).filter((e) => e.occurredAt.getTime() >= weekStartMs && e.occurredAt.getTime() < weekEndExclusiveMs);
  for (const e of exceptionsInWeek) {
    warnings.push({ code: `OPEN_ATTENDANCE_EXCEPTION_${e.type}`, message: `Open attendance exception (${e.type}) within this week.` });
  }

  // Point 6 — plan vs actual, VERSION-sourced slices only (computeSiteScopeHasExceptionBulk
  // compares WorkSegment against TimesheetPlannedShift, both version-scoped tables; a DRAFT has no
  // comparable planned-shift formula reused from elsewhere, so this is intentionally left deferred
  // for DRAFT-sourced slices rather than inventing an incompatible one here).
  if (!isDraftSourced && ctx.planActualMismatchByScope.get(`${sourceId}:${slice.logicalKey.siteId}`)) {
    warnings.push({ code: 'PLAN_ACTUAL_MISMATCH', message: 'Actual worked time for this site differs from the planned shift.' });
  }

  if (submissionSource === 'AUTO') {
    warnings.push({ code: 'AUTOMATIC_SUBMISSION', message: 'This timesheet was submitted automatically by the scheduler, not by the worker.' });
  }

  if (t.period.status === 'OPEN' && isWorkerWithinEditWindow(t.period.status, t.period.endDate, ctx.editWindowPolicy)) {
    const cutoff = computeTimesheetEditCutoff(t.period.endDate, ctx.editWindowPolicy);
    warnings.push({ code: 'EDIT_WINDOW_STILL_OPEN', message: `The worker can still edit this timesheet until ${cutoff.toISOString()}.` });
  }

  // Point 4 — scoped strictly to THIS slice's own canonical payload days (only days that genuinely
  // carry this (siteId, workAreaId) pair's segments), never the padded 7-day displayDays view which
  // also covers other customers' days for the same employee/week.
  if (slice.payload.days.some((d) => d.confirmedZero)) {
    warnings.push({ code: 'CONFIRMED_ZERO_DAY_PRESENT', message: 'At least one day in this slice was explicitly confirmed as zero hours.' });
  }

  if (supersededFingerprintMatch) {
    warnings.push({ code: 'SUPERSEDED_FINGERPRINT_MATCH', message: 'Matches a previously superseded approval rather than a current one — verify before approving again.' });
  }

  return { blockers, warnings, info, selfApprovalBlocked };
}

// =================================================================================================
// displayDays + auto-break merge — buildDisplayDays (above) gives the padded 7-day/own-segments
// shape; this merges in THIS slice's own per-day auto-break minutes from its canonical payload
// (payload.days only lists days that have this slice's own segments, so days absent there simply
// keep the 0 default — this customer's time was never deducted from on a day it has no hours).
// =================================================================================================

function buildDisplayDaysForSlice(slice: WeeklyCustomerSlice, allRawDaysOfEmployeeWeek: RawDay[]): DisplayDay[] {
  const base = buildDisplayDays(slice.logicalKey.weekStart, slice.logicalKey.weekEnd, allRawDaysOfEmployeeWeek, slice.logicalKey.siteId, slice.logicalKey.workAreaId);
  const autoBreakByDate = new Map(slice.payload.days.map((d) => [d.date, d.autoUnpaidBreakMinutes]));
  const totalsByDate = new Map(slice.dayTotals.map((d) => [d.date, d]));
  return base.map((d) => {
    const totals = totalsByDate.get(d.date);
    return {
      ...d,
      autoUnpaidBreakMinutes: autoBreakByDate.get(d.date) ?? 0,
      grossMinutes: totals?.grossMinutes ?? 0,
      breakMinutes: totals?.breakMinutes ?? 0,
      workedMinutes: totals?.workedMinutes ?? 0
    };
  });
}

function computeWeeksCoveredForPeriod(periodStart: Date, periodEnd: Date, effectiveWeekRange: { startDate: string; endDate: string } | null): string[] {
  const periodStartIso = formatDate(periodStart);
  const periodEndIso = formatDate(periodEnd);
  const rangeStart = effectiveWeekRange && effectiveWeekRange.startDate > periodStartIso ? effectiveWeekRange.startDate : periodStartIso;
  const rangeEnd = effectiveWeekRange && effectiveWeekRange.endDate < periodEndIso ? effectiveWeekRange.endDate : periodEndIso;
  if (rangeStart > rangeEnd) return [];
  return enumerateHelsinkiWeeks(rangeStart, rangeEnd).map((w) => w.weekStart);
}

function makeSourceErrorRow(t: TimesheetRow, reason: string): SourceErrorRow {
  return {
    kind: 'SOURCE_ERROR',
    employeeId: t.employeeId,
    employeeName: employeeDisplayName(t.employee.firstName, t.employee.lastName),
    employeeNumber: t.employee.employeeNumber,
    timesheetId: t.id,
    periodId: t.periodId,
    periodStartDate: formatDate(t.period.startDate),
    periodEndDate: formatDate(t.period.endDate),
    reason,
    workedMinutes: null,
    approvable: false
  };
}

function makeNotSubmittedFromTimesheetRow(t: TimesheetRow, effectiveWeekRange: { startDate: string; endDate: string } | null): NotSubmittedRow {
  return {
    kind: 'NOT_SUBMITTED',
    employeeId: t.employeeId,
    employeeName: employeeDisplayName(t.employee.firstName, t.employee.lastName),
    employeeNumber: t.employee.employeeNumber,
    periodId: t.periodId,
    periodStartDate: formatDate(t.period.startDate),
    periodEndDate: formatDate(t.period.endDate),
    timesheetId: t.id,
    timesheetStatus: t.status === 'DRAFT' || t.status === 'RETURNED' ? t.status : null,
    weeksCovered: computeWeeksCoveredForPeriod(t.period.startDate, t.period.endDate, effectiveWeekRange)
  };
}

function participantToNotSubmittedRow(p: MissingTimesheetParticipant, effectiveWeekRange: { startDate: string; endDate: string } | null): NotSubmittedRow {
  return {
    kind: 'NOT_SUBMITTED',
    employeeId: p.employeeId,
    employeeName: employeeDisplayName(p.employeeFirstName, p.employeeLastName),
    employeeNumber: p.employeeNumber,
    periodId: p.periodId,
    periodStartDate: p.periodStartDate,
    periodEndDate: p.periodEndDate,
    timesheetId: null,
    timesheetStatus: null,
    weeksCovered: computeWeeksCoveredForPeriod(parseIsoDateUtc(p.periodStartDate), parseIsoDateUtc(p.periodEndDate), effectiveWeekRange)
  };
}

// =================================================================================================
// Core builder — the ONE place Timesheet rows become WeeklyCustomerSliceRow / NotSubmittedRow /
// SourceErrorRow entries. Called once per fast-path request, once per chunk in Pass 1, and once
// (restricted to a small id/key set) per Pass-2 hydration — never duplicated logic between paths.
// =================================================================================================

interface BuildEntriesOptions {
  effectiveWeekRange: { startDate: string; endDate: string } | null;
  /** Pass-2 hydration only — `${timesheetId}::${siteId}::${workAreaId ?? ''}::${weekStart}` keys. */
  restrictToLogicalKeys?: Set<string>;
}

interface BuildEntriesResult {
  sliceRows: WeeklyCustomerSliceRow[];
  notSubmittedFromTimesheet: NotSubmittedRow[];
  sourceErrors: SourceErrorRow[];
}

async function buildEntriesForTimesheets(timesheets: TimesheetRow[], actor: LedgerActor, db: Db, options: BuildEntriesOptions): Promise<BuildEntriesResult> {
  if (timesheets.length === 0) {
    return { sliceRows: [], notSubmittedFromTimesheet: [], sourceErrors: [] };
  }

  const timesheetIdsAll = timesheets.map((t) => t.id);
  const employeeIdsAll = [...new Set(timesheets.map((t) => t.employeeId))];
  const [batch, openExceptionsByTimesheetId, openCorrectionTimesheetIds, editWindowPolicy, openShiftByEmployee] = await Promise.all([
    loadCanonicalBatch(timesheets, db),
    loadOpenAttendanceExceptionsByTimesheet(timesheetIdsAll, db),
    loadOpenCorrectionRequestTimesheetIds(timesheetIdsAll, db),
    loadEditWindowPolicy(db),
    loadOpenShiftsByEmployee(employeeIdsAll, db)
  ]);

  const sourceErrors: SourceErrorRow[] = [];
  const notSubmittedFromTimesheet: NotSubmittedRow[] = [];
  const pending: { t: TimesheetRow; slice: WeeklyCustomerSlice }[] = [];

  for (const t of timesheets) {
    const sourceErrorMsg = batch.sourceErrorByTimesheetId.get(t.id);
    if (sourceErrorMsg) {
      sourceErrors.push(makeSourceErrorRow(t, sourceErrorMsg));
      continue;
    }
    const sourceId = batch.sourceIdByTimesheetId.get(t.id);
    if (!sourceId) continue;

    const rawDays = batch.rawDaysByTimesheetId.get(t.id) ?? [];
    const filteredDays = options.effectiveWeekRange
      ? rawDays.filter((d) => {
          const iso = formatDate(d.date);
          return iso >= options.effectiveWeekRange!.startDate && iso <= options.effectiveWeekRange!.endDate;
        })
      : rawDays;

    if (filteredDays.length === 0) {
      if (usesDraftSource(t.status)) notSubmittedFromTimesheet.push(makeNotSubmittedFromTimesheetRow(t, options.effectiveWeekRange));
      continue;
    }

    let slices: WeeklyCustomerSlice[];
    try {
      slices = buildWeeklyCustomerSlices({
        employeeId: t.employeeId,
        timesheetId: t.id,
        sourceId,
        days: filteredDays,
        plannedUnpaidBreakBySourceAndDate: batch.plannedUnpaidBreakBySourceAndDate,
        autoBreakThresholdMinutes: batch.autoBreakThresholdMinutes
      });
    } catch (err) {
      sourceErrors.push(makeSourceErrorRow(t, err instanceof Error ? err.message : String(err)));
      continue;
    }

    if (slices.length === 0) {
      if (usesDraftSource(t.status)) notSubmittedFromTimesheet.push(makeNotSubmittedFromTimesheetRow(t, options.effectiveWeekRange));
      continue;
    }

    for (const slice of slices) {
      if (options.restrictToLogicalKeys) {
        const key = `${t.id}::${slice.logicalKey.siteId}::${slice.logicalKey.workAreaId ?? ''}::${slice.logicalKey.weekStart}`;
        if (!options.restrictToLogicalKeys.has(key)) continue;
      }
      pending.push({ t, slice });
    }
  }

  if (pending.length === 0) {
    return { sliceRows: [], notSubmittedFromTimesheet, sourceErrors };
  }

  const timesheetIds = [...new Set(pending.map((p) => p.t.id))];
  const weekStarts = [...new Set(pending.map((p) => p.slice.logicalKey.weekStart))].map(parseIsoDateUtc);

  // Point 6 — batched (timesheetVersionId, siteId) scopes for every VERSION-sourced pending slice,
  // deduplicated (several work-area slices of the same timesheet/site share one scope). DRAFT-sourced
  // slices are never included — see classifyIssues' own comment on why that stays deferred.
  const versionScopeKeys = new Set<string>();
  const versionScopes: { timesheetVersionId: string; siteId: string }[] = [];
  for (const p of pending) {
    if (usesDraftSource(p.t.status)) continue;
    const versionId = batch.sourceIdByTimesheetId.get(p.t.id);
    if (!versionId) continue;
    const key = `${versionId}:${p.slice.logicalKey.siteId}`;
    if (versionScopeKeys.has(key)) continue;
    versionScopeKeys.add(key);
    versionScopes.push({ timesheetVersionId: versionId, siteId: p.slice.logicalKey.siteId });
  }

  const [approvalItemsByKey, planActualMismatchByScope] = await Promise.all([loadApprovalItems(timesheetIds, weekStarts, db), computeSiteScopeHasExceptionBulk(versionScopes, db)]);

  const sliceRows: WeeklyCustomerSliceRow[] = [];
  for (const { t, slice } of pending) {
    const approvalKey = `${t.id}::${slice.logicalKey.siteId}::${slice.logicalKey.workAreaId ?? ''}::${slice.logicalKey.weekStart}`;
    const items = approvalItemsByKey.get(approvalKey) ?? [];
    const match = matchApproval(slice, items);

    const isDraftSourced = usesDraftSource(t.status);
    const submissionSource = !isDraftSourced ? ((t.currentVersion?.submissionSource ?? null) as 'MANUAL' | 'AUTO' | null) : null;
    const sourceId = batch.sourceIdByTimesheetId.get(t.id)!;

    const issue = classifyIssues(t, slice, submissionSource, match.supersededFingerprintMatch, isDraftSourced, sourceId, {
      actor,
      openExceptionsByTimesheetId,
      openCorrectionTimesheetIds,
      editWindowPolicy,
      openShiftByEmployee,
      planActualMismatchByScope
    });
    const finalApprovalState: WeeklyCustomerSliceRow['approvalState'] =
      match.approvalState === 'READY' && (issue.blockers.length > 0 || issue.warnings.length > 0) ? 'NEEDS_ATTENTION' : match.approvalState;

    const rawDaysForEmployee = batch.rawDaysByTimesheetId.get(t.id) ?? [];

    sliceRows.push({
      kind: 'WEEKLY_CUSTOMER_SLICE',
      logicalKey: slice.logicalKey,
      employeeName: employeeDisplayName(t.employee.firstName, t.employee.lastName),
      employeeNumber: t.employee.employeeNumber,
      submissionState: isDraftSourced ? 'NOT_SUBMITTED' : 'SUBMITTED',
      approvalState: finalApprovalState,
      workedMinutes: slice.workedMinutes,
      grossMinutes: slice.grossMinutes,
      breakMinutes: slice.breakMinutes,
      currentFingerprint: slice.fingerprint,
      canonicalSource: {
        dataSource: isDraftSourced ? 'DRAFT' : 'CURRENT_VERSION',
        sourceId,
        sourceKind: isDraftSourced ? 'DRAFT' : 'VERSION',
        sourceRevision: isDraftSourced && t.draft ? String(t.draft.contentRevision) : null,
        versionNumber: !isDraftSourced ? (t.currentVersion?.versionNumber ?? null) : null,
        submissionSource
      },
      currentApprovalItem: match.currentApprovalItem,
      lastHistoricalApproval: match.lastHistoricalApproval,
      supersededFingerprintMatch: match.supersededFingerprintMatch,
      selfApprovalBlocked: issue.selfApprovalBlocked,
      eligibility: { canApprove: issue.blockers.length === 0 },
      blockers: issue.blockers,
      warnings: issue.warnings,
      info: issue.info,
      displayDays: buildDisplayDaysForSlice(slice, rawDaysForEmployee)
    });
  }

  return { sliceRows, notSubmittedFromTimesheet, sourceErrors };
}

// =================================================================================================
// Period + Timesheet loaders shared by fast path and every chunk of the chunked path.
// =================================================================================================

interface PeriodRow {
  id: string;
  startDate: Date;
  endDate: Date;
  status: string;
}

async function listOverlappingPeriods(range: { startDate: string; endDate: string } | null, db: Db): Promise<PeriodRow[]> {
  const where: Prisma.PayrollPeriodWhereInput = range ? { startDate: { lte: parseIsoDateUtc(range.endDate) }, endDate: { gte: parseIsoDateUtc(range.startDate) } } : {};
  return db.payrollPeriod.findMany({ where, select: { id: true, startDate: true, endDate: true, status: true }, orderBy: [{ startDate: 'asc' }, { id: 'asc' }] });
}

async function loadTimesheetsForPeriods(periodIds: string[], employeeSearch: string | null, employeeId: string | null, db: Db): Promise<TimesheetRow[]> {
  if (periodIds.length === 0) return [];
  const where: Prisma.TimesheetWhereInput = { periodId: { in: periodIds } };
  if (employeeId) {
    where.employeeId = employeeId;
  }
  if (employeeSearch) {
    where.employee = { OR: [{ firstName: { contains: employeeSearch, mode: 'insensitive' } }, { lastName: { contains: employeeSearch, mode: 'insensitive' } }, { employeeNumber: { contains: employeeSearch, mode: 'insensitive' } }] };
  }
  return db.timesheet.findMany({ where, select: TIMESHEET_SELECT, orderBy: [{ periodId: 'asc' }, { employeeId: 'asc' }, { id: 'asc' }] });
}

function normalizeToFullWeeks(range: { startDate: string; endDate: string }): { startDate: string; endDate: string } {
  const startWeek = helsinkiWeekBounds(parseIsoDateUtc(range.startDate));
  const endWeek = helsinkiWeekBounds(parseIsoDateUtc(range.endDate));
  return { startDate: startWeek.weekStart, endDate: endWeek.weekEnd };
}

// =================================================================================================
// Tier-2 filters — applied to the already-built entry list (Tier-1 = employeeSearch/date range,
// pushed into the DB queries above). siteId/workAreaId are structural properties of a real
// WEEKLY_CUSTOMER_SLICE only; NOT_SUBMITTED is pre-filtered by siteId at the loader level (via
// SiteAssignment history) and has no workArea concept at all; SOURCE_ERROR has neither (the
// canonical source failed before any segment could be examined) and always passes both.
// =================================================================================================

function applyTier2Filters(entries: TimeLedgerEntry[], query: NormalizedTimeLedgerQuery): TimeLedgerEntry[] {
  return entries.filter((e) => {
    // Point 8 — a siteId filter must exclude any entry whose site attribution the server cannot
    // prove: SOURCE_ERROR (canonical source failed before any segment was examined) and a
    // timesheet-backed NOT_SUBMITTED placeholder (an empty DRAFT has no segments, hence no site at
    // all). A PARTICIPANT-backed NOT_SUBMITTED (timesheetId === null) is different — it already
    // carries a real, proven site via loadMissingTimesheetParticipants' own SiteAssignment-history
    // filter, so it legitimately passes through here rather than being discarded.
    if (query.siteId) {
      if (e.kind === 'SOURCE_ERROR') return false;
      if (e.kind === 'NOT_SUBMITTED' && e.timesheetId !== null) return false;
      if (e.kind === 'WEEKLY_CUSTOMER_SLICE' && e.logicalKey.siteId !== query.siteId) return false;
    }

    if (query.workAreaId) {
      if (e.kind !== 'WEEKLY_CUSTOMER_SLICE') return false;
      const wanted = query.workAreaId === 'none' ? null : query.workAreaId;
      if (e.logicalKey.workAreaId !== wanted) return false;
    }

    if (query.status !== 'all') {
      if (query.status === 'not_submitted') {
        // UT3-B-fixup point 2 — a real DRAFT/RETURNED slice (submissionState=NOT_SUBMITTED) is
        // just as "not submitted" as a placeholder row; the accepted model never restricted this
        // status to placeholders only.
        if (!(e.kind === 'NOT_SUBMITTED' || (e.kind === 'WEEKLY_CUSTOMER_SLICE' && e.submissionState === 'NOT_SUBMITTED'))) return false;
      } else if (query.status === 'source_error') {
        if (e.kind !== 'SOURCE_ERROR') return false;
      } else {
        if (e.kind !== 'WEEKLY_CUSTOMER_SLICE') return false;
        if (e.approvalState.toLowerCase() !== query.status) return false;
      }
    }

    if (query.onlyChangedAfterApproval && !(e.kind === 'WEEKLY_CUSTOMER_SLICE' && e.approvalState === 'CHANGED_AFTER_APPROVAL')) return false;

    // Point 7 — explicit three-way semantics, not an accidental byproduct of a single condition:
    //   SOURCE_ERROR      -> always an issue (a real, unresolved data problem), always passes.
    //   NOT_SUBMITTED     -> always an issue by definition ("not yet submitted"), always passes.
    //   WEEKLY_CUSTOMER_SLICE -> passes only when it actually carries a blocker or warning; being
    //     DRAFT-sourced (submissionState=NOT_SUBMITTED) alone is not itself flagged as an issue.
    if (query.onlyIssues && e.kind === 'WEEKLY_CUSTOMER_SLICE' && e.blockers.length === 0 && e.warnings.length === 0) return false;

    if (query.submissionState !== 'all' && e.kind !== 'SOURCE_ERROR') {
      if (query.submissionState === 'submitted') {
        if (!(e.kind === 'WEEKLY_CUSTOMER_SLICE' && e.submissionState === 'SUBMITTED')) return false;
      } else {
        if (!(e.kind === 'NOT_SUBMITTED' || (e.kind === 'WEEKLY_CUSTOMER_SLICE' && e.submissionState === 'NOT_SUBMITTED'))) return false;
      }
    }

    if (query.submissionSource !== 'all') {
      if (e.kind !== 'WEEKLY_CUSTOMER_SLICE') return false;
      if (e.canonicalSource.submissionSource !== query.submissionSource.toUpperCase()) return false;
    }

    return true;
  });
}

// =================================================================================================
// Summary — computed once over the full Tier-2-filtered, sorted entry list, BEFORE pagination
// (UT3-A-R2 §4: must be exact, never CURRENT_PAGE_ONLY). Never touches displayDays, so it works
// identically on fast-path full entries and chunked-path light (displayDays-stripped) entries.
// =================================================================================================

function computeSummary(entries: TimeLedgerEntry[]): TimeLedgerResult['summary'] {
  const employeeIds = new Set<string>();
  const notSubmittedEmployeeIds = new Set<string>();
  let workedMinutes = 0;
  let sliceCount = 0;
  let readyCount = 0;
  let needsAttentionCount = 0;
  let approvedCount = 0;
  let changedAfterApprovalCount = 0;
  let notSubmittedEntryCount = 0;
  let sourceErrorCount = 0;

  for (const e of entries) {
    if (e.kind === 'WEEKLY_CUSTOMER_SLICE') {
      employeeIds.add(e.logicalKey.employeeId);
      workedMinutes += e.workedMinutes;
      sliceCount += 1;
      // Point 3 — a worker with several draft customer slices (one per site/workArea) still counts
      // once toward notSubmittedWorkerCount; the Set below is exactly what dedupes that.
      if (e.submissionState === 'NOT_SUBMITTED') notSubmittedEmployeeIds.add(e.logicalKey.employeeId);
      if (e.approvalState === 'READY') readyCount += 1;
      else if (e.approvalState === 'NEEDS_ATTENTION') needsAttentionCount += 1;
      else if (e.approvalState === 'APPROVED') approvedCount += 1;
      else changedAfterApprovalCount += 1;
    } else if (e.kind === 'NOT_SUBMITTED') {
      employeeIds.add(e.employeeId);
      notSubmittedEmployeeIds.add(e.employeeId);
      notSubmittedEntryCount += 1;
    } else {
      employeeIds.add(e.employeeId);
      sourceErrorCount += 1;
    }
  }

  return {
    workerCount: employeeIds.size,
    entryCount: entries.length,
    sliceCount,
    workedMinutes,
    readyCount,
    needsAttentionCount,
    approvedCount,
    changedAfterApprovalCount,
    notSubmittedEntryCount,
    notSubmittedWorkerCount: notSubmittedEmployeeIds.size,
    sourceErrorCount
  };
}

// =================================================================================================
// Fast path (<=4 effective weeks, not allTime) — single pass, full entries built directly with real
// displayDays. No descriptor/signature/Pass-2 mechanism: there is no time gap for data to change
// across (UT3-A-R2 §7 scopes the consistency check to the chunked path only).
// =================================================================================================

async function runFastPath(query: NormalizedTimeLedgerQuery, actor: LedgerActor, effectiveWeekRange: { startDate: string; endDate: string } | null, periods: PeriodRow[], db: Db): Promise<TimeLedgerEntry[]> {
  const periodIds = periods.map((p) => p.id);
  const timesheets = await loadTimesheetsForPeriods(periodIds, query.employeeSearch, query.employeeId, db);
  const built = await buildEntriesForTimesheets(timesheets, actor, db, { effectiveWeekRange });
  const missingParticipants = await loadMissingTimesheetParticipants({ periodIds, employeeSearch: query.employeeSearch, employeeId: query.employeeId, siteId: query.siteId }, db);
  const missingRows = missingParticipants.map((p) => participantToNotSubmittedRow(p, effectiveWeekRange));

  const all: TimeLedgerEntry[] = [...built.sliceRows, ...built.notSubmittedFromTimesheet, ...built.sourceErrors, ...missingRows];
  const filtered = applyTier2Filters(all, query);
  filtered.sort((a, b) => compareEntries(sortTupleFor(a), sortTupleFor(b)));
  return filtered;
}

// =================================================================================================
// Chunked path (>4 effective weeks, or allTime) — genuine two-pass pipeline (UT3-A-R2 §2/§4/§7):
//
// Pass 1: scan every period chunk, build FULL entries (buildEntriesForTimesheets already includes
// displayDays), compute each survivor's consistency signature from the full entry BEFORE stripping
// displayDays, then keep only the light (displayDays: []) copy in the global sorted list — this is
// what keeps Pass 1's retained memory bounded by survivor count, not by total segment/day volume.
//
// Pass 2 (hydratePage, below): re-fetches and rebuilds ONLY the requested page's entries fresh, and
// verifies each against its stored Pass-1 signature.
// =================================================================================================

interface ChunkedScanResult {
  sortedLightEntries: TimeLedgerEntry[];
  signatures: Map<string, string>;
}

async function runChunkedPath(
  query: NormalizedTimeLedgerQuery,
  actor: LedgerActor,
  effectiveWeekRange: { startDate: string; endDate: string } | null,
  periods: PeriodRow[],
  options: TimeLedgerOptions,
  db: Db
): Promise<ChunkedScanResult> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const lightEntries: TimeLedgerEntry[] = [];
  const signatures = new Map<string, string>();

  for (let i = 0; i < periods.length; i += chunkSize) {
    const chunk = periods.slice(i, i + chunkSize);
    const periodIds = chunk.map((p) => p.id);

    const timesheets = await loadTimesheetsForPeriods(periodIds, query.employeeSearch, query.employeeId, db);
    const built = await buildEntriesForTimesheets(timesheets, actor, db, { effectiveWeekRange });
    const missingParticipants = await loadMissingTimesheetParticipants({ periodIds, employeeSearch: query.employeeSearch, employeeId: query.employeeId, siteId: query.siteId }, db);
    const missingRows = missingParticipants.map((p) => participantToNotSubmittedRow(p, effectiveWeekRange));

    const chunkEntries: TimeLedgerEntry[] = [...built.sliceRows, ...built.notSubmittedFromTimesheet, ...built.sourceErrors, ...missingRows];
    const filtered = applyTier2Filters(chunkEntries, query);

    for (const e of filtered) {
      const tuple = sortTupleFor(e);
      signatures.set(tuple.entryDiscriminant, entrySignature(e));
      lightEntries.push(e.kind === 'WEEKLY_CUSTOMER_SLICE' ? { ...e, displayDays: [] } : e);
    }
  }

  lightEntries.sort((a, b) => compareEntries(sortTupleFor(a), sortTupleFor(b)));
  return { sortedLightEntries: lightEntries, signatures };
}

/** Pass 2 — re-fetches and rebuilds fresh, full entries for exactly the page's descriptors, and
 *  verifies each against the signature Pass 1 recorded. Any mismatch, OR an entry that no longer
 *  exists under the same kind/logical key, fails the WHOLE page with TimeLedgerReadChangedError
 *  (UT3-A-R2 §2/§7). */
async function hydratePage(
  pageLight: TimeLedgerEntry[],
  signatures: Map<string, string>,
  effectiveWeekRange: { startDate: string; endDate: string } | null,
  actor: LedgerActor,
  query: NormalizedTimeLedgerQuery,
  db: Db
): Promise<TimeLedgerEntry[]> {
  if (pageLight.length === 0) return [];

  const sliceEntries = pageLight.filter((e): e is WeeklyCustomerSliceRow => e.kind === 'WEEKLY_CUSTOMER_SLICE');
  const notSubmittedTimesheetBacked = pageLight.filter((e): e is NotSubmittedRow => e.kind === 'NOT_SUBMITTED' && e.timesheetId !== null);
  const notSubmittedParticipantBacked = pageLight.filter((e): e is NotSubmittedRow => e.kind === 'NOT_SUBMITTED' && e.timesheetId === null);
  const sourceErrorEntries = pageLight.filter((e): e is SourceErrorRow => e.kind === 'SOURCE_ERROR');

  const timesheetIds = [...new Set([...sliceEntries.map((e) => e.logicalKey.timesheetId), ...notSubmittedTimesheetBacked.map((e) => e.timesheetId as string), ...sourceErrorEntries.map((e) => e.timesheetId)])];
  const restrictKeys = new Set(sliceEntries.map((e) => `${e.logicalKey.timesheetId}::${e.logicalKey.siteId}::${e.logicalKey.workAreaId ?? ''}::${e.logicalKey.weekStart}`));

  const freshTimesheets = timesheetIds.length ? await db.timesheet.findMany({ where: { id: { in: timesheetIds } }, select: TIMESHEET_SELECT }) : [];
  const rebuilt = await buildEntriesForTimesheets(freshTimesheets, actor, db, { effectiveWeekRange, restrictToLogicalKeys: restrictKeys.size ? restrictKeys : undefined });

  const freshByDiscriminant = new Map<string, TimeLedgerEntry>();
  for (const r of [...rebuilt.sliceRows, ...rebuilt.notSubmittedFromTimesheet, ...rebuilt.sourceErrors]) {
    freshByDiscriminant.set(sortTupleFor(r).entryDiscriminant, r);
  }

  const participantPeriodIds = [...new Set(notSubmittedParticipantBacked.map((e) => e.periodId))];
  if (participantPeriodIds.length > 0) {
    const freshParticipants = await loadMissingTimesheetParticipants({ periodIds: participantPeriodIds, employeeSearch: query.employeeSearch, employeeId: query.employeeId, siteId: query.siteId }, db);
    for (const p of freshParticipants) {
      const row = participantToNotSubmittedRow(p, effectiveWeekRange);
      freshByDiscriminant.set(sortTupleFor(row).entryDiscriminant, row);
    }
  }

  const changedKeys: string[] = [];
  const result: TimeLedgerEntry[] = [];
  for (const light of pageLight) {
    const tuple = sortTupleFor(light);
    const fresh = freshByDiscriminant.get(tuple.entryDiscriminant);
    if (!fresh) {
      changedKeys.push(tuple.entryDiscriminant);
      continue;
    }
    if (entrySignature(fresh) !== signatures.get(tuple.entryDiscriminant)) {
      changedKeys.push(tuple.entryDiscriminant);
      continue;
    }
    result.push(fresh);
  }

  if (changedKeys.length > 0) {
    throw new TimeLedgerReadChangedError(changedKeys);
  }
  return result;
}

// =================================================================================================
// Page reshape — groups the (already globally sorted) page's WEEKLY_CUSTOMER_SLICE rows by
// (siteId, workAreaId) in first-appearance order (which, because the input is pre-sorted, is
// already the correct group order), then hydrates the bounded, page-sized set of site/workArea
// names in one small batch query each (point 9: "hydration adds a bounded constant batch").
// =================================================================================================

async function hydrateGroupNames(groups: CustomerGroup[], db: Db): Promise<void> {
  if (groups.length === 0) return;
  const siteIds = [...new Set(groups.map((g) => g.siteId))];
  const workAreaIds = [...new Set(groups.map((g) => g.workAreaId).filter((id): id is string => id !== null))];

  const [sites, workAreas] = await Promise.all([
    db.workSite.findMany({ where: { id: { in: siteIds } }, select: { id: true, name: true } }),
    workAreaIds.length ? db.workArea.findMany({ where: { id: { in: workAreaIds } }, select: { id: true, name: true } }) : Promise.resolve([] as { id: string; name: string }[])
  ]);
  const siteNameById = new Map(sites.map((s) => [s.id, s.name]));
  const workAreaNameById = new Map(workAreas.map((w) => [w.id, w.name]));

  for (const g of groups) {
    g.siteName = siteNameById.get(g.siteId) ?? '';
    g.workAreaName = g.workAreaId ? (workAreaNameById.get(g.workAreaId) ?? null) : null;
  }
}

function reshapePage(pageEntries: TimeLedgerEntry[]): { customerGroups: CustomerGroup[]; notSubmitted: NotSubmittedRow[]; sourceErrors: SourceErrorRow[] } {
  const groups: CustomerGroup[] = [];
  const groupIndex = new Map<string, CustomerGroup>();
  const notSubmitted: NotSubmittedRow[] = [];
  const sourceErrors: SourceErrorRow[] = [];

  for (const e of pageEntries) {
    if (e.kind === 'WEEKLY_CUSTOMER_SLICE') {
      const key = `${e.logicalKey.siteId}::${e.logicalKey.workAreaId ?? ''}`;
      let group = groupIndex.get(key);
      if (!group) {
        group = { workAreaId: e.logicalKey.workAreaId, workAreaName: null, siteId: e.logicalKey.siteId, siteName: '', rows: [] };
        groupIndex.set(key, group);
        groups.push(group);
      }
      group.rows.push(e);
    } else if (e.kind === 'NOT_SUBMITTED') {
      notSubmitted.push(e);
    } else {
      sourceErrors.push(e);
    }
  }

  return { customerGroups: groups, notSubmitted, sourceErrors };
}

// =================================================================================================
// dataRange (point 4) — the true extent of the FULL, Tier-1+Tier-2-FILTERED entry set, never the
// raw set of periods that merely overlap the request before any filter is applied (that earlier
// version could report a non-empty range for a filter that matched zero entries). Only meaningful
// for allTime — for an explicit range the caller already knows what it asked for, so this is always
// null there (point 4's "либо null, либо не сериализоваться" — null keeps the field's shape stable
// across both modes rather than making it appear/disappear).
// =================================================================================================

function computeDataRange(entries: TimeLedgerEntry[]): { startDate: string; endDate: string } | null {
  let min: string | null = null;
  let max: string | null = null;
  for (const e of entries) {
    const [start, end] = e.kind === 'WEEKLY_CUSTOMER_SLICE' ? [e.logicalKey.weekStart, e.logicalKey.weekEnd] : [e.periodStartDate, e.periodEndDate];
    if (min === null || start < min) min = start;
    if (max === null || end > max) max = end;
  }
  return min !== null && max !== null ? { startDate: min, endDate: max } : null;
}

// =================================================================================================
// Public entry point.
// =================================================================================================

export async function getTimeLedger(query: NormalizedTimeLedgerQuery, actor: LedgerActor, options: TimeLedgerOptions = {}, db: Db = prisma): Promise<TimeLedgerResult> {
  const effectiveWeekRange = query.allTime ? null : normalizeToFullWeeks(query.requestedRange!);
  const weekCount = effectiveWeekRange ? enumerateHelsinkiWeeks(effectiveWeekRange.startDate, effectiveWeekRange.endDate).length : Number.POSITIVE_INFINITY;
  const mode: 'fast' | 'chunked' = !query.allTime && weekCount <= FAST_PATH_MAX_WEEKS ? 'fast' : 'chunked';

  const periods = await listOverlappingPeriods(effectiveWeekRange, db);

  let sortedFull: TimeLedgerEntry[];
  let hydrate: (page: TimeLedgerEntry[]) => Promise<TimeLedgerEntry[]>;

  if (mode === 'fast') {
    sortedFull = await runFastPath(query, actor, effectiveWeekRange, periods, db);
    hydrate = async (page) => page;
  } else {
    const scan = await runChunkedPath(query, actor, effectiveWeekRange, periods, options, db);
    sortedFull = scan.sortedLightEntries;
    await options.afterDescriptorPass?.();
    hydrate = (page) => hydratePage(page, scan.signatures, effectiveWeekRange, actor, query, db);
  }

  const summary = computeSummary(sortedFull);
  const dataRange = query.allTime ? computeDataRange(sortedFull) : null;

  // Point 9 — pagination.page always echoes the REQUESTED page, never silently substitutes the
  // last page for an out-of-range request (that made page=999 return a confusing duplicate of the
  // last page). A page beyond totalPages simply has no rows. totalPages is the honest count — 0 for
  // an empty result, never a fictitious "page 1 of 1" for zero items.
  const totalItems = sortedFull.length;
  const totalPages = Math.ceil(totalItems / query.pageSize);
  const offset = (query.page - 1) * query.pageSize;
  const pageLight = offset < totalItems ? sortedFull.slice(offset, offset + query.pageSize) : [];
  const pageFull = await hydrate(pageLight);

  const { customerGroups, notSubmitted, sourceErrors } = reshapePage(pageFull);
  await hydrateGroupNames(customerGroups, db);

  return {
    requestedRange: query.requestedRange,
    effectiveWeekRange,
    dataRange,
    allTime: query.allTime,
    summary,
    customerGroups,
    notSubmitted,
    sourceErrors,
    pagination: { page: query.page, pageSize: query.pageSize, totalItems, totalPages }
  };
}
