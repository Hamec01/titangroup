// UT9-B (Titanor Time — единый путь принятия часов) — the ONE place a just-committed
// customer-hours confirmation (single item, mass, or whole-week) is checked against the OLD
// Timesheet.status FINAL_APPROVED state machine, and — only on full coverage — moves it. Called
// from INSIDE the caller's own already-open, already-locked transaction (the commit routes already
// hold Employee + Timesheet FOR UPDATE for every timesheetId they touch), never a separate
// transaction — "confirm the customer's hours" and "finalize the timesheet" are therefore atomic:
// a crash/rollback between the two is structurally impossible, and a concurrent reader can never
// observe a Timesheet whose status implies full coverage while some slice's CURRENT approval is
// actually stale or missing.
//
// UT9-A owner sign-off, reflected directly here:
//  - full coverage of EVERY weekly-customer-slice this Timesheet's current canonical source
//    produces (buildWeeklyCustomerSlices — the same builder the ledger/summary/approval flows
//    already use, never a second formula) by a CURRENT CustomerHoursApprovalItem whose fingerprint
//    still matches -> eligible to finalize. Anything less -> Timesheet.status is left exactly as
//    it was; there is no partial/best-effort finalization, ever (UT9-A point 6).
//  - the OLD one-click "Утвердить табель" button's two extra gates (self-approval refused,
//    foreman-pending blocks) are BOTH bypassed here (UT9-A points 5/6) — reused via
//    finalizeLockedTimesheet's own bypass flags, never a second copy of the FOREMAN_APPROVED/
//    SUBMITTED state-machine logic.
//  - an ineligible status, missing `timesheet.final_approve` permission, or genuine partial
//    coverage (some OTHER customer on this timesheet still unconfirmed) never surfaces as an error
//    to the caller — the customer-hours confirmation itself has ALREADY succeeded by the time this
//    runs; finalization is purely a bonus consequence, never a condition for the confirmation to
//    succeed (UT9-A point 7: business/eligibility reasons never block the confirm half).
//  - UT9-B-fixup #2 — a genuinely TECHNICAL failure while rebuilding this Timesheet's slices (an
//    unreadable canonical source, a builder/invariant failure, or any other contradiction with the
//    confirmation that just succeeded moments earlier in this same locked transaction) is NOT
//    treated as "nothing to finalize" — it throws CustomerHoursFinalizationInvariantError, which
//    rolls back the WHOLE commit (the customer-hours confirmation included). See that class's own
//    doc comment.
//  - no new approval entity: this reads CustomerHoursApprovalItem (already the single source of
//    truth for "confirmed for the customer") and writes only via the EXISTING Timesheet.status
//    transition (UT9-A point 8/UT9-B decision 8).

import type { Prisma } from '@prisma/client';
import { TIMESHEET_SELECT, loadCanonicalBatch, loadApprovalItems } from '@/lib/reporting/time-ledger';
import { buildWeeklyCustomerSlices, type WeeklyCustomerSlice } from '@/lib/reporting/weekly-customer-slice';
import { finalizeLockedTimesheet, type LockedTimesheetForFinalize } from '@/lib/admin-timesheets';
import { hasPermission } from '@/lib/permissions';

export interface TimesheetCoverageResult {
  fullyCovered: boolean;
  /** Every weekly-customer-slice this Timesheet's current canonical source produces right now —
   *  zero counts as NOT fully covered (never vacuously true for an empty/unreadable timesheet). */
  sliceCount: number;
}

/**
 * UT9-B-fixup #2 — thrown (never a soft `{fullyCovered:false}`) whenever the canonical source or
 * slice-builder fails while computing coverage. This function only ever runs AFTER a customer-hours
 * confirmation for THIS SAME timesheet has already succeeded moments earlier in THIS SAME
 * transaction (the caller's own Employee+Timesheet FOR UPDATE locks are still held, so the
 * canonical source cannot have changed) — so a source-read/slice-build failure here is not a normal
 * "not ready yet" outcome, it is a genuinely impossible/corrupted state. Swallowing it into
 * `fullyCovered: false` would silently turn a technical bug into "nothing to finalize this time",
 * exactly the failure mode the owner ruled out. Letting it propagate out of the (uncaught) tx
 * callback rolls back the WHOLE commit — including the customer-hours confirmation that just
 * happened — never a partial write, mirroring lib/reporting/customer-hours-reconciliation.ts's own
 * "a genuinely unrelated DB error still propagates and rolls back rather than being swallowed"
 * precedent. The route layer does not catch this specially either — same convention.
 */
export class CustomerHoursFinalizationInvariantError extends Error {
  constructor(message: string) {
    super(`CUSTOMER_HOURS_FINALIZATION_INVARIANT_FAILURE: ${message}`);
    this.name = 'CustomerHoursFinalizationInvariantError';
  }
}

/**
 * Pure read (given an already-open tx) — never writes. Rebuilds this Timesheet's slices fresh
 * (never trusts a caller-supplied list — a stale in-memory slice list from before the commit would
 * be wrong regardless) and checks each one against the CURRENT CustomerHoursApprovalItem for that
 * exact logical key — the SAME key shape (timesheetId::siteId::workAreaId::weekStart)
 * lib/reporting/time-ledger.ts's own loadApprovalItems already uses, never a diverging format.
 *
 * Returns `fullyCovered: false` ONLY for a genuine, expected mismatch (a real slice exists but has
 * no matching CURRENT approval, or its fingerprint has since changed) — the normal "some other
 * customer on this timesheet is not yet confirmed" case, which must never block the confirmation
 * that just succeeded. Throws CustomerHoursFinalizationInvariantError for every other case — see
 * that class's own doc comment.
 */
export async function computeTimesheetCustomerHoursCoverage(tx: Prisma.TransactionClient, timesheetId: string): Promise<TimesheetCoverageResult> {
  const timesheet = await tx.timesheet.findUnique({ where: { id: timesheetId }, select: TIMESHEET_SELECT });
  if (!timesheet) {
    throw new CustomerHoursFinalizationInvariantError(`Timesheet ${timesheetId} not found while computing coverage, despite its own customer-hours confirmation having just succeeded in this same locked transaction.`);
  }

  const canonicalBatch = await loadCanonicalBatch([timesheet], tx);
  const sourceError = canonicalBatch.sourceErrorByTimesheetId.get(timesheet.id);
  if (sourceError) {
    throw new CustomerHoursFinalizationInvariantError(`Timesheet ${timesheetId}'s canonical source became unreadable while computing coverage: ${sourceError}`);
  }
  const sourceId = canonicalBatch.sourceIdByTimesheetId.get(timesheet.id);
  const rawDays = canonicalBatch.rawDaysByTimesheetId.get(timesheet.id) ?? [];
  if (!sourceId || rawDays.length === 0) {
    throw new CustomerHoursFinalizationInvariantError(`Timesheet ${timesheetId} has no canonical days while computing coverage, despite its own customer-hours confirmation having just succeeded in this same locked transaction.`);
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
    throw new CustomerHoursFinalizationInvariantError(`buildWeeklyCustomerSlices failed for Timesheet ${timesheetId} while computing coverage: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (slices.length === 0) {
    throw new CustomerHoursFinalizationInvariantError(`Timesheet ${timesheetId} produced zero weekly-customer-slices while computing coverage, despite its own customer-hours confirmation having just succeeded in this same locked transaction.`);
  }

  const weekStarts = [...new Set(slices.map((s) => s.logicalKey.weekStart))].map((w) => new Date(`${w}T00:00:00.000Z`));
  const itemsByKey = await loadApprovalItems([timesheetId], weekStarts, tx);

  for (const slice of slices) {
    const key = `${timesheetId}::${slice.logicalKey.siteId}::${slice.logicalKey.workAreaId ?? ''}::${slice.logicalKey.weekStart}`;
    const items = itemsByKey.get(key) ?? [];
    const current = items.find((i) => i.approvalState === 'CURRENT');
    if (!current || current.fingerprint !== slice.fingerprint) {
      // Genuine, expected partial coverage — some other customer on this timesheet is not yet
      // confirmed (or was but its fingerprint has since changed). Never an error.
      return { fullyCovered: false, sliceCount: slices.length };
    }
  }
  return { fullyCovered: true, sliceCount: slices.length };
}

export type FinalizationAttemptResult =
  | { finalized: true }
  | { finalized: false; reason: 'NOT_FOUND' | 'ALREADY_FINAL' | 'NOT_ELIGIBLE_STATUS' | 'MISSING_PERMISSION' | 'PARTIAL_COVERAGE' };

/**
 * Call inside an already-open transaction that already holds Employee + Timesheet FOR UPDATE for
 * `timesheetId` (every customer-hours commit route already does, for every timesheet its selection
 * touches) — right after that commit has finished writing. `actorRoles` is the caller's own
 * session.user.roles (permission is role-based, never re-derived from a per-row check).
 */
export async function attemptTimesheetFinalization(tx: Prisma.TransactionClient, timesheetId: string, actorUserId: string, actorRoles: string[], requestId: string): Promise<FinalizationAttemptResult> {
  const ts = await tx.timesheet.findUnique({ where: { id: timesheetId }, select: { id: true, status: true, employeeId: true, currentVersionId: true } });
  if (!ts) return { finalized: false, reason: 'NOT_FOUND' };
  if (ts.status === 'FINAL_APPROVED') return { finalized: false, reason: 'ALREADY_FINAL' };
  if (ts.status !== 'FOREMAN_APPROVED' && (ts.status !== 'SUBMITTED' || !ts.currentVersionId)) {
    return { finalized: false, reason: 'NOT_ELIGIBLE_STATUS' };
  }

  const canFinalize = await hasPermission(actorRoles, 'timesheet.final_approve');
  if (!canFinalize) return { finalized: false, reason: 'MISSING_PERMISSION' };

  const coverage = await computeTimesheetCustomerHoursCoverage(tx, timesheetId);
  if (!coverage.fullyCovered) return { finalized: false, reason: 'PARTIAL_COVERAGE' };

  const locked: LockedTimesheetForFinalize = ts;
  const outcome = await finalizeLockedTimesheet(tx, locked, actorUserId, null, requestId, { bypassSelfApproval: true, bypassForemanCheck: true });
  if ('code' in outcome) {
    // Defensively unreachable given the checks above (self-approval/foreman are both bypassed, and
    // status was already verified eligible) — never surfaced as an error to the confirm caller.
    return { finalized: false, reason: 'NOT_ELIGIBLE_STATUS' };
  }
  return { finalized: true };
}
