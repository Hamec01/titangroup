// UT7-B (Titanor Time — единый табель, reconciliation после изменения часов) — the ONE place a
// freshly-frozen TimesheetVersion is checked against every CustomerHoursApprovalItem this Timesheet
// currently has CURRENT. Called from the very end of lib/worker-timesheets.ts's
// submitWorkerTimesheetCore, inside the SAME transaction that created the version — never a
// separate post-commit step (UT7-A-R1's rejected "await submit(); await reconcile().catch(logOnly)"
// design: not durable, audit depends on a second step actually running, DB can be left with a stale
// CURRENT forever). Manual submit, auto-submit, and correction/direct-edit approval all funnel
// through submitWorkerTimesheetCore already, so this one call site covers all three automatically —
// none of lib/attendance-auto-submit.ts, lib/corrections.ts, or the manual submit route need to know
// this exists.
//
// Fast path (UT7-A-R1 §2): the overwhelming majority of submits belong to a Timesheet that has never
// had a customer-hours approval — one cheap indexed read (`@@index([timesheetId, employeeId])`,
// leading column timesheetId) and this function returns without building a single weekly slice,
// without any extra lock, without any audit write. Safe without a lock: the caller already holds
// Employee + Timesheet FOR UPDATE for this transaction's entire duration, and every writer of
// CustomerHoursApprovalItem for this timesheetId (single approval, mass approval, this function
// itself) must also acquire that same Timesheet lock first — so the CURRENT set cannot change under
// this read mid-transaction.
//
// Reuses, never re-derives: TIMESHEET_SELECT/loadCanonicalBatch (lib/reporting/time-ledger.ts, the
// exact same canonical-source + planned-unpaid-break loading the batch ledger read and the single/
// mass approval preparation service already use) and buildWeeklyCustomerSlices (the only fingerprint/
// hours/break-allocation formula, lib/reporting/weekly-customer-slice.ts).

import type { Prisma } from '@prisma/client';
import { createAuditEvent } from '@/lib/audit';
import { TIMESHEET_SELECT, loadCanonicalBatch } from '@/lib/reporting/time-ledger';
import { buildWeeklyCustomerSlices, WEEKLY_CUSTOMER_SLICE_AUTO_BREAK_ALLOCATION_INVARIANT_FAILURE, type WeeklyCustomerSlice } from '@/lib/reporting/weekly-customer-slice';

export interface ReconcileCustomerHoursApprovalsInput {
  tx: Prisma.TransactionClient;
  employeeId: string;
  timesheetId: string;
  /** The version submitWorkerTimesheetCore just finished writing in THIS transaction — always the
   *  new canonical source, since reconciliation only ever runs once a version has been frozen (never
   *  against a DRAFT-sourced timesheet). */
  versionId: string;
  actorUserId: string;
  requestId: string;
}

function logicalKeyString(siteId: string, workAreaId: string | null, weekStartIso: string): string {
  return `${siteId}::${workAreaId ?? ''}::${weekStartIso}`;
}

function formatDateIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface ReconciliationCurrentItemInput {
  id: string;
  siteId: string;
  workAreaId: string | null;
  /** YYYY-MM-DD, Monday — the caller converts CustomerHoursApprovalItem.weekStart (a Date column)
   *  before calling, keeping this function Date-free and trivially unit-testable. */
  weekStart: string;
  fingerprint: string;
}

export type ReconciliationDecision =
  | { itemId: string; action: 'KEEP' }
  | {
      itemId: string;
      action: 'SUPERSEDE';
      reason: 'FINGERPRINT_CHANGED' | 'SLICE_REMOVED';
      freshFingerprint: string | null;
      freshWorkedMinutes: number | null;
      freshGrossMinutes: number | null;
      freshBreakMinutes: number | null;
    };

/**
 * UT7-B-fixup #1/#3 — a technical failure to read the canonical source must never be mistaken for
 * "the customer/week's hours were genuinely removed". loadCanonicalBatch reports a per-timesheet
 * sourceError when resolveCanonicalSource() itself threw (Timesheet row missing its expected
 * draft/version relation, etc.) — in that case rawDaysByTimesheetId simply has no entry for this
 * timesheetId, and treating a missing map entry the same as "zero days" would make
 * decideReconciliationActions classify EVERY existing CURRENT item as SLICE_REMOVED, a mass,
 * incorrect supersede triggered by a read failure that has nothing to do with the worker's actual
 * hours. The second check (resolvedSourceId === the version this reconciliation run is FOR) is the
 * same TOCTOU-style defensive check used elsewhere in this codebase: by construction it can only ever
 * be true in normal operation (submitWorkerTimesheetCore has just set Timesheet.currentVersionId to
 * exactly this versionId, in this same transaction, before calling here), so a mismatch always
 * indicates something already went wrong resolving the source, not a legitimate scenario to model.
 * Pure and exported so it is directly unit-testable without a database, mirroring
 * classifyReconciliationBuildFailure below.
 */
export function classifyReconciliationSourceUnreadable(sourceError: string | undefined, resolvedSourceId: string | undefined, expectedVersionId: string): boolean {
  return sourceError !== undefined || resolvedSourceId !== expectedVersionId;
}

/**
 * UT7-B-fixup #3 — the one KNOWN, deferrable domain error out of buildWeeklyCustomerSlices itself
 * (WEEKLY_CUSTOMER_SLICE_AUTO_BREAK_ALLOCATION_INVARIANT_FAILURE), extracted to its own pure,
 * exported predicate so it can be unit-tested directly instead of only "verified by reading the
 * code" — the owner's explicit objection to how UT7-B originally covered this path.
 */
export function classifyReconciliationBuildFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.startsWith(WEEKLY_CUSTOMER_SLICE_AUTO_BREAK_ALLOCATION_INVARIANT_FAILURE);
}

/**
 * The ONE pure decision: for each CURRENT item, KEEP (fingerprint still matches its fresh slice) or
 * SUPERSEDE (fingerprint changed, or the logical key has no fresh slice at all anymore). No I/O, no
 * Date objects — directly unit-testable against hand-built inputs, mirroring UT6-B's
 * classifyMassApprovalItemProblem/findFirstMassApprovalProblem precedent. This is the single place
 * "changed vs unchanged" is decided; reconcileCustomerHoursApprovalsForTimesheet below only executes
 * whatever this function decides, never re-derives the comparison itself.
 */
export function decideReconciliationActions(currentItems: ReconciliationCurrentItemInput[], freshSlices: WeeklyCustomerSlice[]): ReconciliationDecision[] {
  const freshByKey = new Map(freshSlices.map((s) => [logicalKeyString(s.logicalKey.siteId, s.logicalKey.workAreaId, s.logicalKey.weekStart), s]));
  return currentItems.map((item) => {
    const fresh = freshByKey.get(logicalKeyString(item.siteId, item.workAreaId, item.weekStart));
    if (fresh && fresh.fingerprint === item.fingerprint) {
      return { itemId: item.id, action: 'KEEP' };
    }
    return {
      itemId: item.id,
      action: 'SUPERSEDE',
      reason: fresh ? 'FINGERPRINT_CHANGED' : 'SLICE_REMOVED',
      freshFingerprint: fresh ? fresh.fingerprint : null,
      freshWorkedMinutes: fresh ? fresh.workedMinutes : null,
      freshGrossMinutes: fresh ? fresh.grossMinutes : null,
      freshBreakMinutes: fresh ? fresh.breakMinutes : null
    };
  });
}

/**
 * Compares every CURRENT CustomerHoursApprovalItem of this Timesheet against the just-frozen
 * version's fresh weekly slices, by (siteId, workAreaId, weekStart) logical key only:
 *  - fingerprint unchanged -> untouched, no write, no audit (owner decision, UT7-A-R1 §2/UT7-B §2);
 *  - fingerprint changed, or the logical key's slice no longer exists at all -> CURRENT -> SUPERSEDED,
 *    one CUSTOMER_HOURS_APPROVAL_SUPERSEDED audit event;
 *  - a logical key with no prior CURRENT item is never touched (no automatic approval of new hours).
 *
 * A genuinely unexpected error (DB failure, etc.) propagates and rolls back the WHOLE submit
 * transaction, same as any other failure inside submitWorkerTimesheetCore. The one KNOWN, deferrable
 * domain error — buildWeeklyCustomerSlices's own
 * WEEKLY_CUSTOMER_SLICE_AUTO_BREAK_ALLOCATION_INVARIANT_FAILURE — is caught before any
 * CustomerHoursApprovalItem write, leaves every CURRENT row exactly as it was, records one
 * CUSTOMER_HOURS_RECONCILIATION_DEFERRED audit event (no sensitive payload, just a stable reason
 * code), and lets the submit succeed normally: a worker's ability to submit their own timesheet must
 * never depend on this reporting subsystem's health. The next submit that touches this Timesheet
 * retries reconciliation from scratch.
 */
export async function reconcileCustomerHoursApprovalsForTimesheet(input: ReconcileCustomerHoursApprovalsInput): Promise<void> {
  const { tx, employeeId, timesheetId, versionId, actorUserId, requestId } = input;

  const anyCurrent = await tx.customerHoursApprovalItem.findFirst({
    where: { timesheetId, approvalState: 'CURRENT' },
    select: { id: true }
  });
  if (!anyCurrent) return;

  // Tier 4 lock (Employee -> Timesheet -> TimesheetDraft already held by the caller before
  // submitWorkerTimesheetCore started) — one multi-row statement, ORDER BY id, same convention as
  // single/mass approval. Result discarded on purpose: the typed read below (already under this
  // lock, same transaction) is what the rest of this function actually uses.
  await tx.$queryRaw`
    SELECT id FROM "CustomerHoursApprovalItem"
    WHERE "timesheetId" = ${timesheetId}::uuid AND "approvalState" = 'CURRENT'
    ORDER BY id
    FOR UPDATE
  `;

  const currentItems = await tx.customerHoursApprovalItem.findMany({
    where: { timesheetId, approvalState: 'CURRENT' },
    select: { id: true, siteId: true, workAreaId: true, weekStart: true, fingerprint: true, workedMinutes: true, grossMinutes: true, breakMinutes: true }
  });
  if (currentItems.length === 0) return; // defensive — the Timesheet lock already makes this unreachable

  const freshTimesheet = await tx.timesheet.findUniqueOrThrow({ where: { id: timesheetId }, select: TIMESHEET_SELECT });
  const canonicalBatch = await loadCanonicalBatch([freshTimesheet], tx);

  // Fixup #1 — check BEFORE trusting rawDaysByTimesheetId's `?? []` fallback: a source that failed to
  // read is not the same thing as a source that legitimately has zero days. No ApprovalItem has been
  // touched yet (only locked above), so returning here leaves every CURRENT row exactly as it was.
  const sourceError = canonicalBatch.sourceErrorByTimesheetId.get(timesheetId);
  const resolvedSourceId = canonicalBatch.sourceIdByTimesheetId.get(timesheetId);
  if (classifyReconciliationSourceUnreadable(sourceError, resolvedSourceId, versionId)) {
    await createAuditEvent(tx, {
      actorUserId,
      requestId,
      eventType: 'CUSTOMER_HOURS_RECONCILIATION_DEFERRED',
      entityType: 'TIMESHEET',
      entityId: timesheetId,
      afterValue: { timesheetId, versionId, requestId, reasonCode: 'SOURCE_UNREADABLE' }
    });
    return;
  }
  const rawDays = canonicalBatch.rawDaysByTimesheetId.get(timesheetId) ?? [];

  let freshSlices: WeeklyCustomerSlice[];
  try {
    freshSlices = buildWeeklyCustomerSlices({
      employeeId,
      timesheetId,
      sourceId: versionId,
      days: rawDays,
      plannedUnpaidBreakBySourceAndDate: canonicalBatch.plannedUnpaidBreakBySourceAndDate,
      autoBreakThresholdMinutes: canonicalBatch.autoBreakThresholdMinutes
    });
  } catch (err) {
    if (classifyReconciliationBuildFailure(err)) {
      // Deferred — no CustomerHoursApprovalItem has been touched above (only locked, never written).
      await createAuditEvent(tx, {
        actorUserId,
        requestId,
        eventType: 'CUSTOMER_HOURS_RECONCILIATION_DEFERRED',
        entityType: 'TIMESHEET',
        entityId: timesheetId,
        afterValue: { timesheetId, versionId, requestId, reasonCode: 'WEEKLY_SLICE_BUILD_FAILED' }
      });
      return;
    }
    throw err; // unknown error — never swallowed, rolls back the whole submit transaction
  }

  const itemById = new Map(currentItems.map((item) => [item.id, item]));
  const decisions = decideReconciliationActions(
    currentItems.map((item) => ({ id: item.id, siteId: item.siteId, workAreaId: item.workAreaId, weekStart: formatDateIso(item.weekStart), fingerprint: item.fingerprint })),
    freshSlices
  );

  for (const decision of decisions) {
    if (decision.action === 'KEEP') continue; // unchanged — never write ApprovalItem, never write AuditEvent (owner decision)
    const item = itemById.get(decision.itemId)!;

    await tx.customerHoursApprovalItem.update({
      where: { id: item.id },
      data: { approvalState: 'SUPERSEDED', supersededAt: new Date(), supersededBySourceId: versionId }
    });
    await createAuditEvent(tx, {
      actorUserId,
      requestId,
      eventType: 'CUSTOMER_HOURS_APPROVAL_SUPERSEDED',
      entityType: 'CUSTOMER_HOURS_APPROVAL_ITEM',
      entityId: item.id,
      beforeValue: { approvalState: 'CURRENT', fingerprint: item.fingerprint, workedMinutes: item.workedMinutes, grossMinutes: item.grossMinutes, breakMinutes: item.breakMinutes },
      afterValue: {
        approvalState: 'SUPERSEDED',
        trigger: 'RECONCILIATION',
        reason: decision.reason,
        newFingerprint: decision.freshFingerprint,
        newWorkedMinutes: decision.freshWorkedMinutes,
        newGrossMinutes: decision.freshGrossMinutes,
        newBreakMinutes: decision.freshBreakMinutes,
        newSourceId: versionId
      }
    });
  }
}
