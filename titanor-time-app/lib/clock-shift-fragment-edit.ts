import { Prisma } from '@prisma/client';
import { provenanceValuesEqual, effectiveReportedRangesBatch, type ProvenanceValues, type ReportedRange } from '@/lib/attendance-reported-projection';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §10.2 step 2(c)/(d), §12.4 — the shared
// "edit one clock-origin reported segment, with a reason" core, used by BOTH the worker's own
// PATCH /api/worker/timesheets/:timesheetId/days/:date (lib/worker-timesheets.ts, via the two
// narrow formula helpers below) and the new admin-only REASON_EDIT path (lib/
// attendance-exception-edit.ts, via applyClockShiftFragmentReasonEdit). Deliberately a SEPARATE
// module from both — worker-timesheets.ts's PATCH operates on a whole day's FULL segment list at
// once (replace-all semantics, day-type/absence handling, multiple fragments per call) and
// attendance-exception-edit.ts's REASON_EDIT operates on exactly one already-identified fragment;
// neither should import the other.
//
// Scope of "shared core" here, deliberately narrow (not a full control-flow unification of the
// two very differently-shaped callers): the two pure formula helpers (`computeChangeType`,
// `buildClockShiftAdjustmentData`) are reused VERBATIM by both worker-timesheets.ts's existing,
// already-tested multi-segment loop and this module's own single-fragment
// `applyClockShiftFragmentReasonEdit` — eliminating the one real duplication risk (the
// EDITED-vs-RESTORED_TO_RECORDED decision and the ClockShiftAdjustment field mapping) without
// restructuring worker PATCH's proven delete-all/recreate flow, which has a materially different
// shape (day-type transitions, multiple segments/fragments per call, WORK_SEGMENT_OVERLAP via one
// whole-day DB constraint) that a forced single-fragment-at-a-time refactor would put at needless
// regression risk for zero behavioral benefit.

export type ClockShiftAdjustmentChangeType = 'EDITED' | 'RESTORED_TO_RECORDED';

/** Pure — reused by both callers so the EDITED-vs-RESTORED_TO_RECORDED decision is never
 * duplicated. RESTORED_TO_RECORDED iff the final reported values are byte-identical to the
 * fragment's own immutable recorded values (a genuine "back to what the clock actually recorded"). */
export function computeChangeType(after: ProvenanceValues, recorded: ProvenanceValues): ClockShiftAdjustmentChangeType {
  return provenanceValuesEqual(after, recorded) ? 'RESTORED_TO_RECORDED' : 'EDITED';
}

export interface BuildAdjustmentDataInput {
  clockShiftFragmentId: string;
  clockShiftId: string;
  employeeId: string;
  changeType: ClockShiftAdjustmentChangeType | 'REMOVED';
  before: ProvenanceValues;
  after: ProvenanceValues | null;
  reason: string;
  changedByUserId: string;
  requestId: string;
}

/** Pure — the one authoritative mapping from a decided change to the append-only
 * ClockShiftAdjustment row shape (§2.1 п.8), reused by both callers. `after: null` only ever
 * applies to REMOVED, which this module's own `applyClockShiftFragmentReasonEdit` never produces
 * (§12.4: "REMOVED этим endpoint не создаётся") — worker PATCH's own REMOVED path (unchanged,
 * outside this shared core) is the only caller that ever passes it. */
export function buildClockShiftAdjustmentData(input: BuildAdjustmentDataInput): Prisma.ClockShiftAdjustmentUncheckedCreateInput {
  return {
    clockShiftFragmentId: input.clockShiftFragmentId,
    clockShiftId: input.clockShiftId,
    employeeId: input.employeeId,
    changeType: input.changeType,
    changedByUserId: input.changedByUserId,
    beforeStartAt: input.before.startAt,
    beforeEndAt: input.before.endAt,
    beforeSiteId: input.before.siteId,
    beforeWorkAreaId: input.before.workAreaId,
    beforeSourceAssignmentId: input.before.sourceAssignmentId,
    afterStartAt: input.after?.startAt ?? null,
    afterEndAt: input.after?.endAt ?? null,
    afterSiteId: input.after?.siteId ?? null,
    afterWorkAreaId: input.after?.workAreaId ?? null,
    afterSourceAssignmentId: input.after?.sourceAssignmentId ?? null,
    reason: input.reason,
    requestId: input.requestId
  };
}

// ---------------------------------------------------------------------------------------------
// applyClockShiftFragmentReasonEdit (§12.4) — single-fragment edit, used only by the admin
// REASON_EDIT path. Never called by worker PATCH (whose own multi-segment flow has its own
// reasons for staying as-is — see module doc comment above).
// ---------------------------------------------------------------------------------------------

export interface ClockShiftFragmentEditValues {
  startAt?: Date;
  endAt?: Date;
  siteId?: string;
  /** Presence of this KEY (not just a non-undefined value — `null` is a legitimate explicit
   * value meaning "clear the work area") is what distinguishes "explicitly provided" from
   * "omitted, keep current reported value" — callers must only set this property when the
   * request body actually included `workAreaId`, never set it to `undefined` to mean absent. */
  workAreaId?: string | null;
}

export interface LockedFragmentForEdit {
  id: string;
  clockShiftId: string;
  employeeId: string;
  timesheetId: string;
  payrollPeriodId: string;
  date: Date;
  recordedStartAt: Date;
  recordedEndAt: Date;
  siteId: string;
  workAreaId: string | null;
  sourceAssignmentId: string | null;
}

export interface AppliedFragmentEdit {
  fragment: LockedFragmentForEdit;
  segment: { id: string; startAt: Date; endAt: Date; siteId: string; workAreaId: string | null; sourceAssignmentId: string };
  adjustment: { id: string; changeType: ClockShiftAdjustmentChangeType; reason: string; changedByUserId: string; changedAt: Date };
  affectedShiftIds: string[];
  beforeRangesByShift: Map<string, ReportedRange[]>;
}

export type ClockShiftFragmentEditOutcome =
  | { kind: 'APPLIED'; result: AppliedFragmentEdit }
  | { kind: 'NO_LIVE_SEGMENT' }
  | { kind: 'NO_CHANGE' }
  | { kind: 'SITE_CHANGE_REQUIRES_WORK_AREA' }
  | { kind: 'INVALID_CHRONOLOGY' }
  | { kind: 'SITE_NOT_ASSIGNED'; siteId: string }
  | { kind: 'BREAK_OUTSIDE_SEGMENT' };

/**
 * §12.4 "общее ядро §10.2, шаг 2(d)/(c)" — applies a reason-backed edit to the ONE live
 * TimesheetDraftSegment originating from `clockShiftFragmentId`, for a caller that has ALREADY
 * locked Employee → AttendanceException → Timesheet → TimesheetDraft in canonical order and
 * already verified the fragment belongs to `employeeId` and is a legitimate target — this
 * function trusts that precondition (documented, not re-derived) and does not itself re-check
 * exception-level applicability, which is exception-type-specific and lives in the caller
 * (lib/attendance-exception-edit.ts).
 *
 * Does NOT call `resolveOverlapsForAffectedShifts` itself (unlike the more general description in
 * §6 of the T7A.8B.4B task brief) — deliberately left to the caller, which for a named
 * OVERLAPPING_SHIFT exception must resolve that SPECIFIC pair via the real admin actor BEFORE the
 * general SYSTEM-attributed auto-resolution hook ever looks at it (task §7 step 14 before step
 * 15) — folding the hook call in here would make that ordering impossible to guarantee from the
 * caller's side. `affectedShiftIds`/`beforeRangesByShift` are returned precisely so the caller can
 * invoke the existing hook itself, at the right moment, without recomputing the snapshot.
 */
export async function applyClockShiftFragmentReasonEdit(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  employeeId: string,
  clockShiftFragmentId: string,
  newValues: ClockShiftFragmentEditValues,
  reason: string,
  requestId: string
): Promise<ClockShiftFragmentEditOutcome> {
  const fragment = await tx.clockShiftFragment.findUniqueOrThrow({
    where: { id: clockShiftFragmentId },
    select: {
      id: true,
      clockShiftId: true,
      employeeId: true,
      timesheetId: true,
      payrollPeriodId: true,
      date: true,
      recordedStartAt: true,
      recordedEndAt: true,
      siteId: true,
      workAreaId: true,
      sourceAssignmentId: true
    }
  });
  if (fragment.employeeId !== employeeId) {
    // Caller precondition violation, not a user-facing outcome — the caller is responsible for
    // proving this fragment belongs to this employee BEFORE calling this function.
    throw new Error('applyClockShiftFragmentReasonEdit: fragment does not belong to employeeId');
  }

  const segment = await tx.timesheetDraftSegment.findFirst({
    where: { originClockShiftFragmentId: clockShiftFragmentId, employeeId },
    select: { id: true, startAt: true, endAt: true, siteId: true, workAreaId: true, sourceAssignmentId: true }
  });
  if (!segment) {
    return { kind: 'NO_LIVE_SEGMENT' };
  }

  const breaks = await tx.timesheetDraftBreakSegment.findMany({
    where: { draftSegmentId: segment.id },
    select: { id: true, startAt: true, endAt: true, paid: true }
  });

  // lastKnown — the same "most recent ClockShiftAdjustment.after*, else fragment.recorded*"
  // formula lib/worker-timesheets.ts already uses, reused as the single source of truth rather
  // than trusting the live segment's own current row (which should always agree, but the
  // adjustment-chain IS the documented provenance ledger — §2.1 п.8).
  const lastAdjustment = await tx.clockShiftAdjustment.findFirst({
    where: { clockShiftFragmentId },
    orderBy: { changedAt: 'desc' },
    select: { afterStartAt: true, afterEndAt: true, afterSiteId: true, afterWorkAreaId: true, afterSourceAssignmentId: true }
  });
  const recorded: ProvenanceValues = {
    startAt: fragment.recordedStartAt,
    endAt: fragment.recordedEndAt,
    siteId: fragment.siteId,
    workAreaId: fragment.workAreaId,
    sourceAssignmentId: fragment.sourceAssignmentId
  };
  const lastKnown: ProvenanceValues =
    lastAdjustment && lastAdjustment.afterStartAt && lastAdjustment.afterEndAt && lastAdjustment.afterSiteId
      ? {
          startAt: lastAdjustment.afterStartAt,
          endAt: lastAdjustment.afterEndAt,
          siteId: lastAdjustment.afterSiteId,
          workAreaId: lastAdjustment.afterWorkAreaId,
          sourceAssignmentId: lastAdjustment.afterSourceAssignmentId
        }
      : recorded;

  const finalSiteId = newValues.siteId ?? lastKnown.siteId;
  const siteChanged = finalSiteId !== lastKnown.siteId;
  const workAreaExplicit = 'workAreaId' in newValues;
  if (siteChanged && !workAreaExplicit) {
    return { kind: 'SITE_CHANGE_REQUIRES_WORK_AREA' };
  }
  const finalWorkAreaId = workAreaExplicit ? (newValues.workAreaId ?? null) : lastKnown.workAreaId;
  const finalStartAt = newValues.startAt ?? lastKnown.startAt;
  const finalEndAt = newValues.endAt ?? lastKnown.endAt;

  if (!(finalEndAt.getTime() > finalStartAt.getTime())) {
    return { kind: 'INVALID_CHRONOLOGY' };
  }

  const assignment = await tx.siteAssignment.findFirst({
    where: {
      employeeId,
      siteId: finalSiteId,
      workAreaId: finalWorkAreaId,
      validFrom: { lte: fragment.date },
      OR: [{ validTo: null }, { validTo: { gte: fragment.date } }]
    },
    select: { id: true }
  });
  if (!assignment) {
    return { kind: 'SITE_NOT_ASSIGNED', siteId: finalSiteId };
  }

  const after: ProvenanceValues = { startAt: finalStartAt, endAt: finalEndAt, siteId: finalSiteId, workAreaId: finalWorkAreaId, sourceAssignmentId: assignment.id };
  if (provenanceValuesEqual(after, lastKnown)) {
    return { kind: 'NO_CHANGE' };
  }

  for (const b of breaks) {
    if (b.startAt.getTime() < finalStartAt.getTime() || b.endAt.getTime() > finalEndAt.getTime()) {
      return { kind: 'BREAK_OUTSIDE_SEGMENT' };
    }
  }

  const affectedShiftIds = [fragment.clockShiftId];
  const beforeRangesByShift = await effectiveReportedRangesBatch(tx, affectedShiftIds);

  const changeType = computeChangeType(after, recorded);
  const adjustment = await tx.clockShiftAdjustment.create({
    data: buildClockShiftAdjustmentData({
      clockShiftFragmentId: fragment.id,
      clockShiftId: fragment.clockShiftId,
      employeeId,
      changeType,
      before: lastKnown,
      after,
      reason,
      changedByUserId: actorUserId,
      requestId
    })
  });

  const updatedSegment = await tx.timesheetDraftSegment.update({
    where: { id: segment.id },
    data: { startAt: finalStartAt, endAt: finalEndAt, siteId: finalSiteId, workAreaId: finalWorkAreaId, sourceAssignmentId: assignment.id },
    select: { id: true, startAt: true, endAt: true, siteId: true, workAreaId: true, sourceAssignmentId: true }
  });

  await tx.timesheetDraft.update({ where: { timesheetId: fragment.timesheetId }, data: { contentRevision: { increment: 1 } } });

  return {
    kind: 'APPLIED',
    result: {
      fragment,
      segment: updatedSegment,
      adjustment: { id: adjustment.id, changeType, reason, changedByUserId: actorUserId, changedAt: adjustment.changedAt },
      affectedShiftIds,
      beforeRangesByShift
    }
  };
}
