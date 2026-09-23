// UT7-B — read-only "было / стало" diff for one weekly-customer-hours approval logical key. Reuses
// prepareWeeklyCustomerApproval (lib/reporting/weekly-approval.ts, mode:'READ', no locks) for the
// live/"after" side — never a second copy of canonical-source resolution or the fingerprint formula
// — and reads the most recent CustomerHoursApprovalItem (CURRENT or SUPERSEDED, whichever is
// newest) for the "before" side, the same ordering convention lib/reporting/time-ledger.ts's own
// matchApproval() already uses (batch.approvedAt desc, createdAt desc, id desc). Never writes
// anything — this module exists specifically to be safe to call from a plain GET.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { prepareWeeklyCustomerApproval, type ApprovalItemSnapshotV1 } from '@/lib/reporting/weekly-approval';
import { approverName, type LedgerActor } from '@/lib/reporting/time-ledger';
import type { ConfirmationItemKey } from '@/lib/customer-hours-confirmation-token';
import type { CanonicalSliceDay } from '@/lib/reporting/weekly-customer-slice';

type Db = Prisma.TransactionClient | typeof prisma;

export type CustomerHoursApprovalDiffState = 'UNCHANGED' | 'FINGERPRINT_CHANGED' | 'SLICE_REMOVED' | 'SOURCE_UNREADABLE';

export interface CustomerHoursApprovalDiffResult {
  ok: true;
  logicalKey: { timesheetId: string; siteId: string; workAreaId: string | null; weekStart: string; weekEnd: string; employeeId: string };
  state: CustomerHoursApprovalDiffState;
  before: {
    fingerprint: string;
    approvalState: 'CURRENT' | 'SUPERSEDED';
    approvedAt: string;
    approvedByUserName: string;
    workedMinutes: number;
    grossMinutes: number;
    breakMinutes: number;
  };
  /** null when the slice disappeared (SLICE_REMOVED) or the source is technically unreadable
   *  (SOURCE_UNREADABLE) — never a fabricated/zeroed value standing in for "unknown". */
  after: { fingerprint: string; workedMinutes: number; grossMinutes: number; breakMinutes: number } | null;
  changedDates: string[];
  deltaWorkedMinutes: number | null;
}

export type CustomerHoursApprovalDiffOutcome = CustomerHoursApprovalDiffResult | { ok: false; reason: 'NO_APPROVAL_HISTORY' };

function canonicalJsonStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** A date is "changed" if it's present on only one side, or present on both but its canonical
 *  content (segments/breaks/dayType/confirmedZero) differs structurally — never a minutes-based
 *  comparison, since the OLD side's per-day minutes are not stored (only the week-level totals are;
 *  dayTotals is explicitly a live-only display convenience, see weekly-customer-slice.ts). */
export function computeChangedDates(beforeDays: CanonicalSliceDay[], afterDays: CanonicalSliceDay[] | null): string[] {
  const beforeByDate = new Map(beforeDays.map((d) => [d.date, d]));
  const afterByDate = new Map((afterDays ?? []).map((d) => [d.date, d]));
  const allDates = new Set<string>([...beforeByDate.keys(), ...afterByDate.keys()]);
  const changed: string[] = [];
  for (const date of allDates) {
    const b = beforeByDate.get(date);
    const a = afterByDate.get(date);
    if (!b || !a || canonicalJsonStringify(b) !== canonicalJsonStringify(a)) {
      changed.push(date);
    }
  }
  return changed.sort();
}

export async function buildCustomerHoursApprovalDiff(input: { itemKey: ConfirmationItemKey; actor: LedgerActor; db: Db }): Promise<CustomerHoursApprovalDiffOutcome> {
  const { itemKey, actor, db } = input;

  const lastItem = await db.customerHoursApprovalItem.findFirst({
    where: { timesheetId: itemKey.timesheetId, siteId: itemKey.siteId, workAreaId: itemKey.workAreaId, weekStart: new Date(`${itemKey.weekStart}T00:00:00.000Z`) },
    orderBy: [{ batch: { approvedAt: 'desc' } }, { createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      fingerprint: true,
      approvalState: true,
      workedMinutes: true,
      grossMinutes: true,
      breakMinutes: true,
      snapshot: true,
      employeeId: true,
      batch: { select: { approvedAt: true, approvedByUser: { select: { username: true, employee: { select: { firstName: true, lastName: true } } } } } }
    }
  });
  if (!lastItem) {
    return { ok: false, reason: 'NO_APPROVAL_HISTORY' };
  }

  const snapshot = lastItem.snapshot as unknown as ApprovalItemSnapshotV1;

  const prepared = await prepareWeeklyCustomerApproval({ itemKey, actor, mode: 'READ', db });

  let state: CustomerHoursApprovalDiffState;
  let after: CustomerHoursApprovalDiffResult['after'] = null;
  let afterDays: CanonicalSliceDay[] | null = null;

  if (!prepared.ok) {
    // SLICE_NOT_FOUND is the one genuinely expected case (the customer/week's hours were removed
    // entirely). Every other !ok reason (INVALID_WORK_AREA_SITE, TIMESHEET_NOT_FOUND, SOURCE_ERROR,
    // INVARIANT_FAILURE) is a technical read failure from this diff's point of view — the first two
    // are structurally near-impossible here (this logical key already has real approval history,
    // and Timesheet/WorkArea rows are never deleted or reassigned), so folding them into the same
    // SOURCE_UNREADABLE bucket keeps the state vocabulary to exactly the four the UI needs.
    state = prepared.reason === 'SLICE_NOT_FOUND' ? 'SLICE_REMOVED' : 'SOURCE_UNREADABLE';
  } else {
    after = { fingerprint: prepared.slice.fingerprint, workedMinutes: prepared.slice.workedMinutes, grossMinutes: prepared.slice.grossMinutes, breakMinutes: prepared.slice.breakMinutes };
    afterDays = prepared.slice.payload.days;
    state = prepared.slice.fingerprint === lastItem.fingerprint ? 'UNCHANGED' : 'FINGERPRINT_CHANGED';
  }

  return {
    ok: true,
    logicalKey: { timesheetId: itemKey.timesheetId, siteId: itemKey.siteId, workAreaId: itemKey.workAreaId, weekStart: itemKey.weekStart, weekEnd: snapshot.logicalKey.weekEnd, employeeId: lastItem.employeeId },
    state,
    before: {
      fingerprint: lastItem.fingerprint,
      approvalState: lastItem.approvalState as 'CURRENT' | 'SUPERSEDED',
      approvedAt: lastItem.batch.approvedAt.toISOString(),
      approvedByUserName: approverName(lastItem.batch),
      workedMinutes: lastItem.workedMinutes,
      grossMinutes: lastItem.grossMinutes,
      breakMinutes: lastItem.breakMinutes
    },
    after,
    changedDates: computeChangedDates(snapshot.canonicalPayload.days, afterDays),
    deltaWorkedMinutes: after ? after.workedMinutes - lastItem.workedMinutes : null
  };
}
