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
import { createHash } from 'node:crypto';
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

/** The one place "what a valid {itemKey, expectedFingerprint} pair looks like" is checked — shared
 *  by the single-item body validator below and validateMassSelection (UT6-B), so mass never
 *  re-derives these field checks. `prefix` becomes part of every fieldErrors key it produces
 *  (empty for the single-item route, `selection[i].` for a mass one), so error shapes stay
 *  byte-identical to what the single-item route already returned before this was extracted. */
function parseSelectionItemFields(rawItemKey: unknown, rawFingerprint: unknown, prefix: string): { fieldErrors: Record<string, string[]>; value?: undefined } | { fieldErrors?: undefined; value: ValidatedApprovalRequestBody } {
  const fieldErrors: Record<string, string[]> = {};
  if (rawItemKey === null || typeof rawItemKey !== 'object') {
    fieldErrors[`${prefix}itemKey`] = ['must be an object'];
  } else {
    const k = rawItemKey as Record<string, unknown>;
    if (typeof k.timesheetId !== 'string' || !UUID_PATTERN.test(k.timesheetId)) fieldErrors[`${prefix}itemKey.timesheetId`] = ['must be a UUID'];
    if (typeof k.siteId !== 'string' || !UUID_PATTERN.test(k.siteId)) fieldErrors[`${prefix}itemKey.siteId`] = ['must be a UUID'];
    if (k.workAreaId !== null && (typeof k.workAreaId !== 'string' || !UUID_PATTERN.test(k.workAreaId))) fieldErrors[`${prefix}itemKey.workAreaId`] = ['must be a UUID or null'];
    if (!isStrictMondayIso(k.weekStart)) fieldErrors[`${prefix}itemKey.weekStart`] = ['must be a real calendar date, YYYY-MM-DD, and a Monday'];
  }

  if (typeof rawFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(rawFingerprint)) {
    fieldErrors[`${prefix}expectedFingerprint`] = ['must be 64 lowercase hex characters'];
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }
  const k = rawItemKey as Record<string, unknown>;
  return {
    value: {
      itemKey: { timesheetId: k.timesheetId as string, siteId: k.siteId as string, workAreaId: (k.workAreaId as string | null) ?? null, weekStart: k.weekStart as string },
      expectedFingerprint: rawFingerprint as string
    }
  };
}

/** Never throws on malformed input — every failure becomes a fieldErrors entry, never a 500. */
export function validateApprovalRequestBody(body: unknown): { ok: true; value: ValidatedApprovalRequestBody } | { ok: false; fieldErrors: Record<string, string[]> } {
  if (body === null || typeof body !== 'object') {
    return { ok: false, fieldErrors: { body: ['must be a JSON object'] } };
  }
  const b = body as Record<string, unknown>;
  const parsed = parseSelectionItemFields(b.itemKey, b.expectedFingerprint, '');
  if (parsed.fieldErrors) return { ok: false, fieldErrors: parsed.fieldErrors };
  return { ok: true, value: parsed.value };
}

// =================================================================================================
// Mass selection — validation, canonical sort, and selectionHash (UT6-A-R1 §2/§4/§11). The ONE place
// "what a valid mass selection looks like" is parsed; both new mass routes (preview and commit) call
// this instead of re-deriving the array/limit/duplicate/single-customer rules themselves.
// =================================================================================================

/** UT6-A-R1 §12 — 200 weekly slices is comfortably small for one transaction's lock set, one
 *  selectionSnapshot, and the audit rows a full commit writes (at most ~2 AuditEvent rows per
 *  written item plus one for the batch), while still covering any realistic "confirm this whole
 *  customer's week" action. Exceeding it is a clean, explicit SELECTION_TOO_LARGE rejection — the
 *  selection itself is never silently truncated or deduplicated. */
export const MAX_MASS_SELECTION_ITEMS = 200;

const ALLOWED_SELECTION_ITEM_FIELDS = ['itemKey', 'expectedFingerprint'];
const ALLOWED_ITEM_KEY_FIELDS = ['timesheetId', 'siteId', 'workAreaId', 'weekStart'];

function hasOnlyKeys(obj: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(obj).every((k) => allowed.includes(k));
}

function selectionLogicalKeyString(k: ConfirmationItemKey): string {
  return `${k.timesheetId}::${k.siteId}::${k.workAreaId ?? ''}::${k.weekStart}`;
}

export interface MassValidationError {
  code: 'EMPTY_SELECTION' | 'SELECTION_TOO_LARGE' | 'DUPLICATE_SELECTION_ITEM' | 'MIXED_CUSTOMER_SELECTION' | 'MIXED_WEEK_SELECTION' | 'VALIDATION_ERROR';
  message: string;
  fieldErrors?: Record<string, string[]>;
}

/** UT9-B — 'CUSTOMER' (default, UT6-A-R1 §4's original rule): every item shares one (siteId,
 *  workAreaId). 'WEEK' ("Принять всю неделю"): every item shares one (timesheetId, weekStart)
 *  instead — site/workArea are free to vary, since the whole point is confirming ALL of one
 *  worker's customers for one week in a single atomic operation (UT9-A point 4/UT9-B decision 3).
 *  Never a third selection shape — both still funnel through the exact same batch prepare/commit
 *  engine below. */
export type MassSelectionScope = 'CUSTOMER' | 'WEEK';

/**
 * Validates a raw `selection` array (UT6-A-R1 §2): non-empty, at most MAX_MASS_SELECTION_ITEMS, no
 * unknown/extra fields on the array itself or on any item/itemKey, every item individually
 * well-formed (reusing parseSelectionItemFields, never a second copy of those field checks), no
 * repeated logical key, and — depending on `scope` — every item belonging to the exact same
 * customer (siteId + workAreaId, including null; UT6-A-R1 §4's original "one operation, one
 * customer" rule) or the exact same (timesheetId, weekStart) pair (UT9-B's "whole week" scope).
 * Never silently deduplicates or truncates; every rejection is a named, stable error code.
 */
export function validateMassSelection(rawSelection: unknown, scope: MassSelectionScope = 'CUSTOMER'): { ok: true; value: ValidatedApprovalRequestBody[] } | { ok: false; error: MassValidationError } {
  if (!Array.isArray(rawSelection)) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'selection must be an array.', fieldErrors: { selection: ['must be an array'] } } };
  }
  if (rawSelection.length === 0) {
    return { ok: false, error: { code: 'EMPTY_SELECTION', message: 'selection must not be empty.' } };
  }
  if (rawSelection.length > MAX_MASS_SELECTION_ITEMS) {
    return { ok: false, error: { code: 'SELECTION_TOO_LARGE', message: `selection must not exceed ${MAX_MASS_SELECTION_ITEMS} items.` } };
  }

  const fieldErrors: Record<string, string[]> = {};
  const items: ValidatedApprovalRequestBody[] = [];
  for (let i = 0; i < rawSelection.length; i++) {
    const raw = rawSelection[i];
    const prefix = `selection[${i}].`;
    if (raw === null || typeof raw !== 'object') {
      fieldErrors[`selection[${i}]`] = ['must be an object'];
      continue;
    }
    const rec = raw as Record<string, unknown>;
    if (!hasOnlyKeys(rec, ALLOWED_SELECTION_ITEM_FIELDS)) {
      fieldErrors[`selection[${i}]`] = ['must not contain unknown fields'];
      continue;
    }
    if (rec.itemKey !== null && typeof rec.itemKey === 'object' && !hasOnlyKeys(rec.itemKey as Record<string, unknown>, ALLOWED_ITEM_KEY_FIELDS)) {
      fieldErrors[`${prefix}itemKey`] = ['must not contain unknown fields'];
      continue;
    }
    const parsed = parseSelectionItemFields(rec.itemKey, rec.expectedFingerprint, prefix);
    if (parsed.fieldErrors) {
      Object.assign(fieldErrors, parsed.fieldErrors);
      continue;
    }
    items.push(parsed.value);
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid selection.', fieldErrors } };
  }

  const seen = new Set<string>();
  for (const item of items) {
    const key = selectionLogicalKeyString(item.itemKey);
    if (seen.has(key)) {
      return { ok: false, error: { code: 'DUPLICATE_SELECTION_ITEM', message: 'The same logical week/customer slice was selected more than once.' } };
    }
    seen.add(key);
  }

  if (scope === 'WEEK') {
    const firstTimesheetId = items[0].itemKey.timesheetId;
    const firstWeekStart = items[0].itemKey.weekStart;
    if (items.some((item) => item.itemKey.timesheetId !== firstTimesheetId || item.itemKey.weekStart !== firstWeekStart)) {
      return { ok: false, error: { code: 'MIXED_WEEK_SELECTION', message: 'All selected items must belong to the same timesheet and week.' } };
    }
  } else {
    const firstSiteId = items[0].itemKey.siteId;
    const firstWorkAreaId = items[0].itemKey.workAreaId;
    if (items.some((item) => item.itemKey.siteId !== firstSiteId || item.itemKey.workAreaId !== firstWorkAreaId)) {
      return { ok: false, error: { code: 'MIXED_CUSTOMER_SELECTION', message: 'All selected items must belong to the same customer (siteId + workAreaId).' } };
    }
  }

  return { ok: true, value: items };
}

export function compareSelectionItems(a: ValidatedApprovalRequestBody, b: ValidatedApprovalRequestBody): number {
  return (
    a.itemKey.siteId.localeCompare(b.itemKey.siteId) ||
    (a.itemKey.workAreaId ?? '').localeCompare(b.itemKey.workAreaId ?? '') ||
    a.itemKey.weekStart.localeCompare(b.itemKey.weekStart) ||
    a.itemKey.timesheetId.localeCompare(b.itemKey.timesheetId) ||
    a.expectedFingerprint.localeCompare(b.expectedFingerprint)
  );
}

/** UT6-A-R1 §11 — the one canonical order both mass routes sort by before hashing or locking. */
export function sortSelectionCanonically(selection: ValidatedApprovalRequestBody[]): ValidatedApprovalRequestBody[] {
  return [...selection].sort(compareSelectionItems);
}

function canonicalJsonStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * sha256 of the canonically-sorted selection (UT6-A-R1 §3/§11) — what the mass confirmation token
 * binds to instead of embedding every item, and what the mass commit route folds into its
 * Idempotency-Key request hash so a retry submitting the same logical selection in a different array
 * order still hashes identically to the original attempt. All fields of every item participate
 * (itemKey's four fields plus expectedFingerprint), and the order of the INPUT array never affects
 * the result — sortSelectionCanonically runs first. Same stable-JSON-then-sha256 recipe as every
 * other fingerprint/hash in this codebase, kept as its own small local copy rather than a shared
 * export, matching the project's established "zero cross-module coupling for a six-line helper"
 * discipline (see weekly-customer-slice.ts's own local copy for the precedent).
 */
export function computeSelectionHash(selection: ValidatedApprovalRequestBody[]): string {
  const sorted = sortSelectionCanonically(selection);
  const canonical = sorted.map((s) => ({
    timesheetId: s.itemKey.timesheetId,
    siteId: s.itemKey.siteId,
    workAreaId: s.itemKey.workAreaId,
    weekStart: s.itemKey.weekStart,
    expectedFingerprint: s.expectedFingerprint
  }));
  return createHash('sha256').update(canonicalJsonStringify(canonical)).digest('hex');
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
// prepareWeeklyCustomerApprovalsBatch — UT6-B's batched sibling of prepareWeeklyCustomerApproval
// (UT6-A-R1 §7/§16). Same per-item rules (buildWeeklyCustomerSlices, classifyIssues, matchApproval),
// but every supporting query (canonical batch, approval items, open exceptions/corrections, edit
// window, open shifts, plan/actual mismatch, site/work-area/employee names) runs ONCE for the whole
// selection instead of once per item — calling prepareWeeklyCustomerApproval N times for a
// 200-item mass preview would cost N times the round-trips of loading them batched, exactly the
// N+1 pattern UT3-A-R2's batch pipeline already avoids elsewhere. Mirrors the existing relationship
// between buildEntriesForTimesheets (batch) and prepareWeeklyCustomerApproval (single): a third
// orchestration layer over the SAME underlying pure functions, never a second copy of any formula.
//
// mode: 'COMMIT' never acquires locks itself, same contract as prepareWeeklyCustomerApproval — the
// caller (the mass commit route) must already hold every Employee/Timesheet/TimesheetDraft/
// CustomerHoursApprovalItem lock this call will read, before calling it with a transaction client.
// =================================================================================================

export type WeeklyApprovalBatchItemResult = { itemKey: ConfirmationItemKey; expectedFingerprint: string } & (
  | (Omit<WeeklyApprovalPreparationOk, 'ok'> & { ok: true; matchesExpectedFingerprint: boolean })
  | { ok: false; reason: 'INVALID_WORK_AREA_SITE' | 'TIMESHEET_NOT_FOUND' | 'SOURCE_ERROR' | 'SLICE_NOT_FOUND' | 'INVARIANT_FAILURE'; detail?: string }
);

export async function prepareWeeklyCustomerApprovalsBatch(input: {
  selection: ValidatedApprovalRequestBody[];
  actor: LedgerActor;
  mode: ApprovalPreparationMode;
  db: ApprovalDb;
}): Promise<WeeklyApprovalBatchItemResult[]> {
  const { selection, actor, db } = input;

  // Step 1 — workArea -> siteId, batched (dedup: several selection items can share one workAreaId).
  const workAreaIds = [...new Set(selection.map((s) => s.itemKey.workAreaId).filter((id): id is string => id !== null))];
  const workAreas = workAreaIds.length ? await db.workArea.findMany({ where: { id: { in: workAreaIds } }, select: { id: true, siteId: true, name: true } }) : [];
  const workAreaSiteById = new Map(workAreas.map((w) => [w.id, w.siteId]));
  const workAreaNameById = new Map(workAreas.map((w) => [w.id, w.name]));

  // Step 2 — every distinct Timesheet the selection touches, one query.
  const timesheetIds = [...new Set(selection.map((s) => s.itemKey.timesheetId))];
  const timesheets = await db.timesheet.findMany({ where: { id: { in: timesheetIds } }, select: TIMESHEET_SELECT });
  const timesheetById = new Map(timesheets.map((t) => [t.id, t]));

  // Step 3 — canonical source (draft/version days) for every timesheet found, one batched call.
  const canonicalBatch = await loadCanonicalBatch(timesheets, db);

  // Step 4 — build every timesheet's slices ONCE (never once per selection item — a timesheet can
  // appear several times in one selection, one entry per week).
  const slicesByTimesheetId = new Map<string, WeeklyCustomerSlice[] | { error: string }>();
  for (const t of timesheets) {
    const sourceError = canonicalBatch.sourceErrorByTimesheetId.get(t.id);
    if (sourceError) {
      slicesByTimesheetId.set(t.id, { error: sourceError });
      continue;
    }
    const sourceId = canonicalBatch.sourceIdByTimesheetId.get(t.id);
    const rawDays = canonicalBatch.rawDaysByTimesheetId.get(t.id) ?? [];
    if (!sourceId || rawDays.length === 0) {
      slicesByTimesheetId.set(t.id, { error: 'SLICE_NOT_FOUND' });
      continue;
    }
    try {
      const slices = buildWeeklyCustomerSlices({
        employeeId: t.employeeId,
        timesheetId: t.id,
        sourceId,
        days: rawDays,
        plannedUnpaidBreakBySourceAndDate: canonicalBatch.plannedUnpaidBreakBySourceAndDate,
        autoBreakThresholdMinutes: canonicalBatch.autoBreakThresholdMinutes
      });
      slicesByTimesheetId.set(t.id, slices);
    } catch (err) {
      slicesByTimesheetId.set(t.id, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Step 5 — every other supporting loader, batched across the whole selection.
  const weekStartDates = [...new Set(selection.map((s) => s.itemKey.weekStart))].map(parseIsoDateUtc);
  const employeeIds = [...new Set(timesheets.map((t) => t.employeeId))];
  const siteIds = [...new Set(selection.map((s) => s.itemKey.siteId))];
  const [itemsByKey, openExceptionsByTimesheetId, openCorrectionTimesheetIds, editWindowPolicy, openShiftByEmployee, sites] = await Promise.all([
    loadApprovalItems(timesheetIds, weekStartDates, db),
    loadOpenAttendanceExceptionsByTimesheet(timesheetIds, db),
    loadOpenCorrectionRequestTimesheetIds(timesheetIds, db),
    loadEditWindowPolicy(db),
    loadOpenShiftsByEmployee(employeeIds, db),
    db.workSite.findMany({ where: { id: { in: siteIds } }, select: { id: true, name: true } })
  ]);
  const siteNameById = new Map(sites.map((s) => [s.id, s.name]));

  const versionScopeKeys = new Set<string>();
  const versionScopes: { timesheetVersionId: string; siteId: string }[] = [];
  for (const s of selection) {
    const t = timesheetById.get(s.itemKey.timesheetId);
    if (!t || usesDraftSource(t.status)) continue;
    const versionId = canonicalBatch.sourceIdByTimesheetId.get(t.id);
    if (!versionId) continue;
    const key = `${versionId}:${s.itemKey.siteId}`;
    if (versionScopeKeys.has(key)) continue;
    versionScopeKeys.add(key);
    versionScopes.push({ timesheetVersionId: versionId, siteId: s.itemKey.siteId });
  }
  const planActualMismatchByScope = await computeSiteScopeHasExceptionBulk(versionScopes, db);

  // Step 6 — resolve every selection item from the already-loaded batch data (zero further queries).
  const results: WeeklyApprovalBatchItemResult[] = [];
  for (const { itemKey, expectedFingerprint } of selection) {
    if (itemKey.workAreaId !== null) {
      const actualSiteId = workAreaSiteById.get(itemKey.workAreaId);
      if (!actualSiteId || actualSiteId !== itemKey.siteId) {
        results.push({ itemKey, expectedFingerprint, ok: false, reason: 'INVALID_WORK_AREA_SITE' });
        continue;
      }
    }

    const t = timesheetById.get(itemKey.timesheetId);
    if (!t) {
      results.push({ itemKey, expectedFingerprint, ok: false, reason: 'TIMESHEET_NOT_FOUND' });
      continue;
    }

    const slicesOrError = slicesByTimesheetId.get(t.id);
    if (!slicesOrError || 'error' in slicesOrError) {
      const isSliceNotFound = !!slicesOrError && 'error' in slicesOrError && slicesOrError.error === 'SLICE_NOT_FOUND';
      const isSourceError = canonicalBatch.sourceErrorByTimesheetId.has(t.id);
      const reason = isSliceNotFound ? 'SLICE_NOT_FOUND' : isSourceError ? 'SOURCE_ERROR' : 'INVARIANT_FAILURE';
      const detail = slicesOrError && 'error' in slicesOrError && !isSliceNotFound ? slicesOrError.error : undefined;
      results.push({ itemKey, expectedFingerprint, ok: false, reason, detail });
      continue;
    }

    const slice = slicesOrError.find((s) => s.logicalKey.siteId === itemKey.siteId && s.logicalKey.workAreaId === itemKey.workAreaId && s.logicalKey.weekStart === itemKey.weekStart);
    if (!slice) {
      results.push({ itemKey, expectedFingerprint, ok: false, reason: 'SLICE_NOT_FOUND' });
      continue;
    }

    const approvalKey = `${t.id}::${itemKey.siteId}::${itemKey.workAreaId ?? ''}::${itemKey.weekStart}`;
    const approvalItemRows = itemsByKey.get(approvalKey) ?? [];
    const match = matchApproval(slice, approvalItemRows);
    const existingCurrentRow = approvalItemRows.find((i) => i.approvalState === 'CURRENT') ?? null;

    const isDraftSourced = usesDraftSource(t.status);
    const submissionSource = !isDraftSourced ? ((t.currentVersion?.submissionSource ?? null) as 'MANUAL' | 'AUTO' | null) : null;
    const sourceId = canonicalBatch.sourceIdByTimesheetId.get(t.id)!;

    const issue = classifyIssues(t, slice, submissionSource, match.supersededFingerprintMatch, isDraftSourced, sourceId, {
      actor,
      openExceptionsByTimesheetId,
      openCorrectionTimesheetIds,
      editWindowPolicy,
      openShiftByEmployee,
      planActualMismatchByScope
    });

    const canonicalSource: WeeklyApprovalCanonicalSource = {
      dataSource: isDraftSourced ? 'DRAFT' : 'CURRENT_VERSION',
      sourceId,
      sourceKind: isDraftSourced ? 'DRAFT' : 'VERSION',
      sourceRevision: isDraftSourced && t.draft ? String(t.draft.contentRevision) : null,
      versionNumber: !isDraftSourced ? (t.currentVersion?.versionNumber ?? null) : null,
      submissionSource
    };

    results.push({
      itemKey,
      expectedFingerprint,
      ok: true,
      matchesExpectedFingerprint: slice.fingerprint === expectedFingerprint,
      employeeId: t.employeeId,
      employeeName: `${t.employee.lastName} ${t.employee.firstName}`.trim(),
      employeeNumber: t.employee.employeeNumber,
      siteName: siteNameById.get(itemKey.siteId) ?? '',
      workAreaName: itemKey.workAreaId ? (workAreaNameById.get(itemKey.workAreaId) ?? null) : null,
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
    });
  }

  return results;
}

// =================================================================================================
// UT6-B-fixup #2 — the ONE place a single prepared item is judged "cannot proceed": a genuinely
// technical failure (`!ok`), a stale fingerprint, or a real blocker (`blockers.length > 0`). Both
// the mass preview route (per item: outcome/technicalBlocker/token eligibility) and the mass commit
// route (finding the first item that must abort the whole transaction) call this SAME function —
// UT6-B-fixup #1's bug (preview issuing a token and outcome=WILL_APPROVE for an item commit would
// have rejected) was exactly the failure mode of duplicating this three-condition check in two
// places and only updating one of them. Pure — no I/O.
// =================================================================================================

export type MassApprovalItemProblem = { kind: 'NOT_OK' } | { kind: 'STALE' } | { kind: 'BLOCKED'; blocker: LedgerIssue };

export function classifyMassApprovalItemProblem(r: WeeklyApprovalBatchItemResult): MassApprovalItemProblem | null {
  if (!r.ok) return { kind: 'NOT_OK' };
  if (!r.matchesExpectedFingerprint) return { kind: 'STALE' };
  if (r.blockers.length > 0) return { kind: 'BLOCKED', blocker: r.blockers[0] };
  return null;
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
  mode: 'SINGLE' | 'MASS';
  itemKeys: ConfirmationItemKey[];
}

/** `mode` defaults to 'SINGLE' so the already-shipped single-item commit route's existing call site
 *  (buildSelectionSnapshotV1([itemKey])) keeps working unchanged — UT6-B's mass commit route passes
 *  'MASS' explicitly with the full original (pre-sort) selection, per UT6-A-R1 §14's requirement
 *  that selectionSnapshot record the complete explicit selection, including any already-approved
 *  no-op items. */
export function buildSelectionSnapshotV1(itemKeys: ConfirmationItemKey[], mode: 'SINGLE' | 'MASS' = 'SINGLE'): SelectionSnapshotV1 {
  return { schemaVersion: 1, mode, itemKeys };
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
  /** UT6-A-R1 §1/§14 — the exact warnings shown to the admin at the moment of approval (e.g.
   *  SELF_APPROVAL_FORBIDDEN or OPEN_SHIFT, accepted via "Всё равно подтвердить"), so a
   *  warning-based decision stays reproducible from history rather than only from the live,
   *  possibly-since-changed state. Always present going forward (an empty array for a clean
   *  approval, never omitted) — absent only on approval items created before this field existed,
   *  never backfilled. Applies identically to single- and mass-item commits, since both build this
   *  snapshot through this one function. */
  warningsAtApproval: LedgerIssue[];
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
    displayMetadata: { employeeName: prepared.employeeName, employeeNumber: prepared.employeeNumber, siteName: prepared.siteName, workAreaName: prepared.workAreaName },
    warningsAtApproval: prepared.warnings
  };
}
