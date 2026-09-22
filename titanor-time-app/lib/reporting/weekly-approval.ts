// UT5-B (Titanor Time — единый табель и подтверждение часов по заказчику) — the one shared
// orchestration both the preview and commit endpoints call (UT5-A-R1 §10 "shared preparation
// service"). Reuses, never re-derives: resolveCanonicalSource (lib/reporting/canonical-source.ts),
// buildWeeklyCustomerSlices/computeSliceFingerprint (lib/reporting/weekly-customer-slice.ts, the
// only auto-break/fingerprint formula), and — exported from lib/reporting/time-ledger.ts
// specifically for this module — the exact same classifyIssues() blocker/warning rules and
// loadApprovalItems()/matchApproval() approval-matching logic the batch GET /api/admin/time-ledger
// pipeline already uses. That batch pipeline itself (buildEntriesForTimesheets, the fast/chunked
// paths) is deliberately NOT rerouted through this single-slice function — doing so would risk
// reintroducing N+1 query patterns into UT3-A-R2's already-shipped, already-tested pagination
// design. Only the underlying RULES are shared; the ORCHESTRATION differs by design (batch-loaded
// vs single-slice-under-lock).
//
// `mode: 'COMMIT'` never acquires any lock itself — the caller (the /approvals route handler) must
// already hold Employee/Timesheet/(TimesheetDraft if DRAFT-sourced)/CustomerHoursApprovalItem FOR
// UPDATE locks before calling this function with a transaction client, exactly the same "caller
// holds the locks" contract lib/worker-timesheets.ts's submitWorkerTimesheetCore already uses.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { resolveCanonicalSource, usesDraftSource } from '@/lib/reporting/canonical-source';
import { buildWeeklyCustomerSlices, type CanonicalSlicePayload, type WeeklyCustomerSlice } from '@/lib/reporting/weekly-customer-slice';
import { computeSiteScopeHasExceptionBulk } from '@/lib/review-scopes';
import {
  TIMESHEET_SELECT,
  loadCanonicalBatch,
  loadApprovalItems,
  matchApproval,
  approverName,
  loadOpenAttendanceExceptionsByTimesheet,
  loadOpenCorrectionRequestTimesheetIds,
  loadEditWindowPolicy,
  loadOpenShiftsByEmployee,
  classifyIssues,
  type LedgerActor,
  type LedgerIssue
} from '@/lib/reporting/time-ledger';
import type { ConfirmationItemKey } from '@/lib/customer-hours-confirmation-token';

type ApprovalDb = Prisma.TransactionClient | typeof prisma;

function parseIsoDateUtc(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

// =================================================================================================
// Request-body validation — shared by both the preview and commit routes so "what a valid itemKey
// looks like" is parsed exactly once, not twice.
// =================================================================================================

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

function isStrictMondayIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const asDate = new Date(Date.UTC(y, m - 1, d));
  if (asDate.getUTCFullYear() !== y || asDate.getUTCMonth() !== m - 1 || asDate.getUTCDate() !== d) return false;
  return asDate.getUTCDay() === 1; // Monday, same 0=Sun..6=Sat getUTCDay() convention as elsewhere
}

export interface ValidatedApprovalRequestBody {
  itemKey: ConfirmationItemKey;
  expectedFingerprint: string;
}

/** Never throws on malformed input — every failure becomes a fieldErrors entry, never a 500. */
export function validateApprovalRequestBody(body: unknown): { ok: true; value: ValidatedApprovalRequestBody } | { ok: false; fieldErrors: Record<string, string[]> } {
  const fieldErrors: Record<string, string[]> = {};
  if (body === null || typeof body !== 'object') {
    return { ok: false, fieldErrors: { body: ['must be a JSON object'] } };
  }
  const b = body as Record<string, unknown>;

  const rawItemKey = b.itemKey;
  if (rawItemKey === null || typeof rawItemKey !== 'object') {
    fieldErrors.itemKey = ['must be an object'];
  } else {
    const k = rawItemKey as Record<string, unknown>;
    if (typeof k.timesheetId !== 'string' || !UUID_PATTERN.test(k.timesheetId)) fieldErrors['itemKey.timesheetId'] = ['must be a UUID'];
    if (typeof k.siteId !== 'string' || !UUID_PATTERN.test(k.siteId)) fieldErrors['itemKey.siteId'] = ['must be a UUID'];
    if (k.workAreaId !== null && (typeof k.workAreaId !== 'string' || !UUID_PATTERN.test(k.workAreaId))) fieldErrors['itemKey.workAreaId'] = ['must be a UUID or null'];
    if (!isStrictMondayIso(k.weekStart)) fieldErrors['itemKey.weekStart'] = ['must be a real calendar date, YYYY-MM-DD, and a Monday'];
  }

  if (typeof b.expectedFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(b.expectedFingerprint)) {
    fieldErrors.expectedFingerprint = ['must be 64 lowercase hex characters'];
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  const k = rawItemKey as Record<string, unknown>;
  return {
    ok: true,
    value: {
      itemKey: { timesheetId: k.timesheetId as string, siteId: k.siteId as string, workAreaId: (k.workAreaId as string | null) ?? null, weekStart: k.weekStart as string },
      expectedFingerprint: b.expectedFingerprint as string
    }
  };
}

// =================================================================================================
// prepareWeeklyCustomerApproval — the shared function.
// =================================================================================================

export type ApprovalPreparationMode = 'READ' | 'COMMIT';

export interface WeeklyApprovalCanonicalSource {
  dataSource: 'DRAFT' | 'CURRENT_VERSION';
  sourceId: string;
  sourceKind: 'DRAFT' | 'VERSION';
  sourceRevision: string | null;
  versionNumber: number | null;
  submissionSource: 'MANUAL' | 'AUTO' | null;
}

export interface WeeklyApprovalExistingItem {
  id: string;
  fingerprint: string;
  approvedAt: string;
  approvedByUserName: string;
}

export interface WeeklyApprovalPreparationOk {
  ok: true;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  siteName: string;
  workAreaName: string | null;
  slice: WeeklyCustomerSlice;
  canonicalSource: WeeklyApprovalCanonicalSource;
  submissionState: 'SUBMITTED' | 'NOT_SUBMITTED';
  /** The CURRENT CustomerHoursApprovalItem for this exact logical key, if one exists. In COMMIT
   *  mode the caller has already locked this row FOR UPDATE (or locked nothing, if none existed at
   *  lock time — safe precisely because the Timesheet lock already serializes every concurrent
   *  commit attempt for this timesheet, UT5-A-R1 §3). */
  existingCurrentItem: WeeklyApprovalExistingItem | null;
  /** True when the slice's CURRENT fingerprint matches a SUPERSEDED (not CURRENT) historical
   *  record rather than nothing/the current one — surfaced as a warning, same signal the read-side
   *  ledger already shows (SUPERSEDED_FINGERPRINT_MATCH). */
  supersededFingerprintMatch: boolean;
  blockers: LedgerIssue[];
  warnings: LedgerIssue[];
  eligibility: { canApprove: boolean };
}

export type WeeklyApprovalPreparationResult =
  | WeeklyApprovalPreparationOk
  | { ok: false; reason: 'INVALID_WORK_AREA_SITE' }
  | { ok: false; reason: 'TIMESHEET_NOT_FOUND' }
  | { ok: false; reason: 'SOURCE_ERROR'; detail: string }
  | { ok: false; reason: 'SLICE_NOT_FOUND' }
  | { ok: false; reason: 'INVARIANT_FAILURE'; detail: string };

export async function prepareWeeklyCustomerApproval(input: { itemKey: ConfirmationItemKey; actor: LedgerActor; mode: ApprovalPreparationMode; db: ApprovalDb }): Promise<WeeklyApprovalPreparationResult> {
  const { itemKey, actor, db } = input;

  if (itemKey.workAreaId !== null) {
    const workArea = await db.workArea.findUnique({ where: { id: itemKey.workAreaId }, select: { siteId: true } });
    if (!workArea || workArea.siteId !== itemKey.siteId) {
      return { ok: false, reason: 'INVALID_WORK_AREA_SITE' };
    }
  }

  const timesheet = await db.timesheet.findUnique({ where: { id: itemKey.timesheetId }, select: TIMESHEET_SELECT });
  if (!timesheet) {
    return { ok: false, reason: 'TIMESHEET_NOT_FOUND' };
  }

  const canonicalBatch = await loadCanonicalBatch([timesheet], db);
  const sourceError = canonicalBatch.sourceErrorByTimesheetId.get(timesheet.id);
  if (sourceError) {
    return { ok: false, reason: 'SOURCE_ERROR', detail: sourceError };
  }
  const sourceId = canonicalBatch.sourceIdByTimesheetId.get(timesheet.id);
  const rawDays = canonicalBatch.rawDaysByTimesheetId.get(timesheet.id) ?? [];
  if (!sourceId || rawDays.length === 0) {
    return { ok: false, reason: 'SLICE_NOT_FOUND' };
  }

  let slices: WeeklyCustomerSlice[];
  try {
    slices = buildWeeklyCustomerSlices({
      employeeId: timesheet.employeeId,
      timesheetId: timesheet.id,
      sourceId,
      days: rawDays,
      plannedUnpaidBreakBySourceAndDate: canonicalBatch.plannedUnpaidBreakBySourceAndDate,
      autoBreakThresholdMinutes: canonicalBatch.autoBreakThresholdMinutes
    });
  } catch (err) {
    return { ok: false, reason: 'INVARIANT_FAILURE', detail: err instanceof Error ? err.message : String(err) };
  }

  const slice = slices.find((s) => s.logicalKey.siteId === itemKey.siteId && s.logicalKey.workAreaId === itemKey.workAreaId && s.logicalKey.weekStart === itemKey.weekStart);
  if (!slice) {
    return { ok: false, reason: 'SLICE_NOT_FOUND' };
  }

  const itemsByKey = await loadApprovalItems([timesheet.id], [parseIsoDateUtc(itemKey.weekStart)], db);
  const approvalKey = `${timesheet.id}::${itemKey.siteId}::${itemKey.workAreaId ?? ''}::${itemKey.weekStart}`;
  const items = itemsByKey.get(approvalKey) ?? [];
  const match = matchApproval(slice, items);
  const existingCurrentRow = items.find((i) => i.approvalState === 'CURRENT') ?? null;

  const isDraftSourced = usesDraftSource(timesheet.status);
  const submissionSource = !isDraftSourced ? ((timesheet.currentVersion?.submissionSource ?? null) as 'MANUAL' | 'AUTO' | null) : null;

  const [openExceptionsByTimesheetId, openCorrectionTimesheetIds, editWindowPolicy, openShiftByEmployee, planActualMismatchByScope] = await Promise.all([
    loadOpenAttendanceExceptionsByTimesheet([timesheet.id], db),
    loadOpenCorrectionRequestTimesheetIds([timesheet.id], db),
    loadEditWindowPolicy(db),
    loadOpenShiftsByEmployee([timesheet.employeeId], db),
    isDraftSourced ? Promise.resolve(new Map<string, boolean>()) : computeSiteScopeHasExceptionBulk([{ timesheetVersionId: sourceId, siteId: itemKey.siteId }], db)
  ]);

  const issue = classifyIssues(timesheet, slice, submissionSource, match.supersededFingerprintMatch, isDraftSourced, sourceId, {
    actor,
    openExceptionsByTimesheetId,
    openCorrectionTimesheetIds,
    editWindowPolicy,
    openShiftByEmployee,
    planActualMismatchByScope
  });

  const [site, workArea] = await Promise.all([
    db.workSite.findUnique({ where: { id: itemKey.siteId }, select: { name: true } }),
    itemKey.workAreaId ? db.workArea.findUnique({ where: { id: itemKey.workAreaId }, select: { name: true } }) : Promise.resolve(null)
  ]);

  const canonicalSource: WeeklyApprovalCanonicalSource = {
    dataSource: isDraftSourced ? 'DRAFT' : 'CURRENT_VERSION',
    sourceId,
    sourceKind: isDraftSourced ? 'DRAFT' : 'VERSION',
    sourceRevision: isDraftSourced && timesheet.draft ? String(timesheet.draft.contentRevision) : null,
    versionNumber: !isDraftSourced ? (timesheet.currentVersion?.versionNumber ?? null) : null,
    submissionSource
  };

  return {
    ok: true,
    employeeId: timesheet.employeeId,
    employeeName: `${timesheet.employee.lastName} ${timesheet.employee.firstName}`.trim(),
    employeeNumber: timesheet.employee.employeeNumber,
    siteName: site?.name ?? '',
    workAreaName: workArea?.name ?? null,
    slice,
    canonicalSource,
    submissionState: isDraftSourced ? 'NOT_SUBMITTED' : 'SUBMITTED',
    existingCurrentItem: existingCurrentRow
      ? { id: existingCurrentRow.id, fingerprint: existingCurrentRow.fingerprint, approvedAt: existingCurrentRow.batch.approvedAt.toISOString(), approvedByUserName: approverName(existingCurrentRow.batch) }
      : null,
    supersededFingerprintMatch: match.supersededFingerprintMatch,
    blockers: issue.blockers,
    warnings: issue.warnings,
    eligibility: { canApprove: issue.blockers.length === 0 }
  };
}

// =================================================================================================
// Snapshot builders — UT5-A-R1 §5's exact V1 shapes. `canonicalPayload` embeds the literal
// CanonicalSlicePayload the fingerprint was computed over (never display names — that type
// structurally has no name fields at all, see weekly-customer-slice.ts) so the item's snapshot is a
// fully self-contained historical record, independent of whatever the live canonical source says
// later. Never contains GPS, a confirmation token, a session/cookie, or a full User row.
// =================================================================================================

export interface SelectionSnapshotV1 {
  schemaVersion: 1;
  mode: 'SINGLE';
  itemKeys: ConfirmationItemKey[];
}

export function buildSelectionSnapshotV1(itemKeys: ConfirmationItemKey[]): SelectionSnapshotV1 {
  return { schemaVersion: 1, mode: 'SINGLE', itemKeys };
}

export interface ApprovalItemSnapshotV1 {
  schemaVersion: 1;
  logicalKey: { employeeId: string; timesheetId: string; siteId: string; workAreaId: string | null; weekStart: string; weekEnd: string };
  canonicalSource: WeeklyApprovalCanonicalSource;
  fingerprint: string;
  workedMinutes: number;
  grossMinutes: number;
  breakMinutes: number;
  canonicalPayload: CanonicalSlicePayload;
  displayMetadata: { employeeName: string; employeeNumber: string; siteName: string; workAreaName: string | null };
}

export function buildApprovalItemSnapshotV1(prepared: WeeklyApprovalPreparationOk): ApprovalItemSnapshotV1 {
  return {
    schemaVersion: 1,
    logicalKey: {
      employeeId: prepared.employeeId,
      timesheetId: prepared.slice.logicalKey.timesheetId,
      siteId: prepared.slice.logicalKey.siteId,
      workAreaId: prepared.slice.logicalKey.workAreaId,
      weekStart: prepared.slice.logicalKey.weekStart,
      weekEnd: prepared.slice.logicalKey.weekEnd
    },
    canonicalSource: prepared.canonicalSource,
    fingerprint: prepared.slice.fingerprint,
    workedMinutes: prepared.slice.workedMinutes,
    grossMinutes: prepared.slice.grossMinutes,
    breakMinutes: prepared.slice.breakMinutes,
    canonicalPayload: prepared.slice.payload,
    displayMetadata: { employeeName: prepared.employeeName, employeeNumber: prepared.employeeNumber, siteName: prepared.siteName, workAreaName: prepared.workAreaName }
  };
}
