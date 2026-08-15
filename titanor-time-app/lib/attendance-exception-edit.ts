import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { resolveOverlapsForAffectedShifts, overlapExists } from '@/lib/attendance-reported-projection';
import { actorDisplayName, UUID_PATTERN } from '@/lib/attendance-exceptions';
import { parseStrictIsoInstant } from '@/lib/attendance-exception-resolution';
import { isSegmentOverlapViolation } from '@/lib/worker-timesheets';
import { applyClockShiftFragmentReasonEdit, type ClockShiftFragmentEditValues } from '@/lib/clock-shift-fragment-edit';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §10.1-§10.3/§12.4 — REASON_EDIT, T7A.8B.4B,
// the sixth and last action of the §11 resolution-action matrix. Deliberately a SEPARATE endpoint
// (`POST .../exceptions/:exceptionId/edit`), not folded into the existing `.../resolve` endpoint
// (§12.4: "не переиспользует worker-PATCH", and by the same reasoning not `/resolve` either — this
// action's request/response shape and target-resolution algorithm are materially different from
// all six `/resolve` outcomes). ADMIN/SUPER_ADMIN only (`timesheet.draft.edit.exception`, seeded by
// prisma/migrations/20260818000000_seed_timesheet_draft_edit_exception_permission) — FOREMAN is
// not granted this permission at all in v1 (§12.4), so the foreman route fails closed
// unconditionally, before this module is ever reached.
//
// Architecture clarification adopted for this slice (T7A.8B.4B task brief §1) — `
// clockShiftFragmentId` is a REQUIRED request body field, not implicitly derived from
// `exception.clockShiftFragmentId` alone (§12.4's own pseudocode assumes that field is always
// populated, which is not true for OVERLAPPING_SHIFT — its exception carries
// clockShiftId/relatedClockShiftId instead — nor guaranteed in general). See
// `resolveTargetFragmentId` below for the exact provable-link algorithm.

const REASON_EDIT_APPLICABLE_TYPES = new Set(['SITE_MISMATCH_CHECKOUT', 'EXCESSIVE_CLOCK_SKEW', 'CHECKOUT_CHRONOLOGY_ANOMALY', 'EXCESSIVE_SHIFT_DURATION', 'OVERLAPPING_SHIFT']);

function isReasonEditApplicable(type: string): boolean {
  return REASON_EDIT_APPLICABLE_TYPES.has(type);
}

const MAX_REASON_LENGTH = 2000;

// ---------------------------------------------------------------------------------------------
// Request body validation — pure, no DB access.
// ---------------------------------------------------------------------------------------------

export interface EditRequestValues {
  clockShiftFragmentId: string;
  startAt?: Date;
  endAt?: Date;
  siteId?: string;
  workAreaId?: string | null;
  reason: string;
}

export type ParsedEditRequest = { ok: true; value: EditRequestValues } | { ok: false; fieldErrors: Record<string, string[]> };

const KNOWN_EDIT_FIELDS = new Set(['clockShiftFragmentId', 'startAt', 'endAt', 'siteId', 'workAreaId', 'reason']);

export function validateEditRequestBody(raw: unknown): ParsedEditRequest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, fieldErrors: { '': ['must be a JSON object'] } };
  }
  const body = raw as Record<string, unknown>;
  const fieldErrors: Record<string, string[]> = {};

  for (const key of Object.keys(body)) {
    if (!KNOWN_EDIT_FIELDS.has(key)) {
      fieldErrors[key] = ['unknown field'];
    }
  }

  let clockShiftFragmentId: string | null = null;
  if (typeof body.clockShiftFragmentId !== 'string' || !UUID_PATTERN.test(body.clockShiftFragmentId)) {
    fieldErrors.clockShiftFragmentId = ['required, must be a UUID'];
  } else {
    clockShiftFragmentId = body.clockShiftFragmentId;
  }

  let reason: string | null = null;
  if (typeof body.reason !== 'string') {
    fieldErrors.reason = ['required'];
  } else {
    const trimmed = body.reason.trim();
    if (trimmed.length === 0) {
      fieldErrors.reason = ['required'];
    } else if (trimmed.length > MAX_REASON_LENGTH) {
      fieldErrors.reason = [`must be at most ${MAX_REASON_LENGTH} characters`];
    } else {
      reason = trimmed;
    }
  }

  let startAt: Date | undefined;
  if (body.startAt !== undefined) {
    const parsed = parseStrictIsoInstant(body.startAt);
    if (!parsed) {
      fieldErrors.startAt = ['must be a strict ISO-8601 timestamp with an explicit UTC offset (Z or +HH:MM/-HH:MM)'];
    } else {
      startAt = parsed;
    }
  }

  let endAt: Date | undefined;
  if (body.endAt !== undefined) {
    const parsed = parseStrictIsoInstant(body.endAt);
    if (!parsed) {
      fieldErrors.endAt = ['must be a strict ISO-8601 timestamp with an explicit UTC offset (Z or +HH:MM/-HH:MM)'];
    } else {
      endAt = parsed;
    }
  }

  if (startAt && endAt && !(endAt.getTime() > startAt.getTime())) {
    fieldErrors.endAt = ['must be strictly after startAt'];
  }

  let siteId: string | undefined;
  if (body.siteId !== undefined) {
    if (typeof body.siteId !== 'string' || !UUID_PATTERN.test(body.siteId)) {
      fieldErrors.siteId = ['must be a UUID'];
    } else {
      siteId = body.siteId;
    }
  }

  let workAreaIdProvided = false;
  let workAreaId: string | null = null;
  if (body.workAreaId !== undefined) {
    workAreaIdProvided = true;
    if (body.workAreaId === null) {
      workAreaId = null;
    } else if (typeof body.workAreaId === 'string' && UUID_PATTERN.test(body.workAreaId)) {
      workAreaId = body.workAreaId;
    } else {
      fieldErrors.workAreaId = ['must be a UUID or null'];
    }
  }

  const hasAnyFieldEdit = startAt !== undefined || endAt !== undefined || siteId !== undefined || workAreaIdProvided;
  if (!hasAnyFieldEdit) {
    fieldErrors[''] = ['at least one of startAt, endAt, siteId, workAreaId must be provided'];
  }

  if (Object.keys(fieldErrors).length > 0 || !clockShiftFragmentId || !reason) {
    return { ok: false, fieldErrors };
  }

  const value: EditRequestValues = { clockShiftFragmentId, reason };
  if (startAt !== undefined) {
    value.startAt = startAt;
  }
  if (endAt !== undefined) {
    value.endAt = endAt;
  }
  if (siteId !== undefined) {
    value.siteId = siteId;
  }
  if (workAreaIdProvided) {
    value.workAreaId = workAreaId;
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------------------------
// Target identity resolution (task brief §1 — the accepted clarification of §12.4's ambiguity).
// ---------------------------------------------------------------------------------------------

interface ExceptionForTarget {
  employeeId: string;
  type: string;
  clockShiftId: string | null;
  relatedClockShiftId: string | null;
  clockShiftFragmentId: string | null;
  clockEventId: string | null;
  timesheetId: string | null;
  payrollPeriodId: string | null;
}

/**
 * Returns the confirmed target fragment id, or null if the requested `clockShiftFragmentId` is
 * not a provable target for this exception — the caller maps `null` to `TARGET_NOT_APPLICABLE`
 * (rendered as `409 ACTION_NOT_APPLICABLE` at the route, without `allowedActions`, since the
 * ACTION itself is applicable to this exception TYPE — only the requested fragment isn't a valid
 * target for THIS specific exception instance).
 */
async function resolveTargetFragmentId(tx: Prisma.TransactionClient, exception: ExceptionForTarget, requestedFragmentId: string): Promise<boolean> {
  const fragment = await tx.clockShiftFragment.findUnique({
    where: { id: requestedFragmentId },
    select: { clockShiftId: true, employeeId: true, timesheetId: true, payrollPeriodId: true }
  });
  if (!fragment || fragment.employeeId !== exception.employeeId) {
    return false;
  }

  if (exception.type === 'OVERLAPPING_SHIFT') {
    // §1 "Для OVERLAPPING_SHIFT: fragment.clockShiftId обязан быть одним из exception.clockShiftId
    // или exception.relatedClockShiftId" — never gated on exception.clockShiftFragmentId (which
    // OVERLAPPING_SHIFT exceptions never carry) or on timesheetId/payrollPeriodId (a canonical
    // overlap pair can legitimately span two different periods, §9.10).
    return fragment.clockShiftId === exception.clockShiftId || fragment.clockShiftId === exception.relatedClockShiftId;
  }

  if (exception.timesheetId && fragment.timesheetId !== exception.timesheetId) {
    return false;
  }
  if (exception.payrollPeriodId && fragment.payrollPeriodId !== exception.payrollPeriodId) {
    return false;
  }

  if (exception.clockShiftFragmentId) {
    // §1 rule 1 — an exception that already carries a direct fragment link requires an EXACT match.
    return exception.clockShiftFragmentId === requestedFragmentId;
  }

  // §1 rule 2 — no direct link on the exception: a provable connection is required, either via
  // clockShiftId directly, or transitively via clockEventId -> the ClockShift it checked
  // in/out on -> that shift's own fragment.
  if (exception.clockShiftId && fragment.clockShiftId === exception.clockShiftId) {
    return true;
  }
  if (exception.clockEventId) {
    const shift = await tx.clockShift.findFirst({
      where: { OR: [{ checkInEventId: exception.clockEventId }, { checkOutEventId: exception.clockEventId }] },
      select: { id: true }
    });
    if (shift && shift.id === fragment.clockShiftId) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// The mutation.
// ---------------------------------------------------------------------------------------------

const EDIT_PRE_READ_SELECT = {
  employeeId: true,
  type: true,
  status: true,
  clockShiftId: true,
  relatedClockShiftId: true,
  clockShiftFragmentId: true,
  clockEventId: true,
  timesheetId: true,
  payrollPeriodId: true
} satisfies Prisma.AttendanceExceptionSelect;

type EditPreRead = Prisma.AttendanceExceptionGetPayload<{ select: typeof EDIT_PRE_READ_SELECT }>;

export interface ExceptionEditResult {
  resolutionAction: 'REASON_EDIT';
  exception: { id: string; type: string; status: 'RESOLVED'; resolvedAt: string; resolvedBy: { id: string; name: string }; resolutionNote: string };
  fragment: { id: string; clockShiftId: string; timesheetId: string; date: string; reportedProjectionState: 'SETTLED' };
  segment: { id: string; startAt: string; endAt: string; siteId: string; workAreaId: string | null; sourceAssignmentId: string };
  adjustment: { id: string; changeType: 'EDITED' | 'RESTORED_TO_RECORDED'; reason: string; changedByUserId: string; changedAt: string };
}

export type ExceptionEditOutcome =
  | { kind: 'OK'; result: ExceptionEditResult }
  | { kind: 'NOT_FOUND' }
  | { kind: 'ALREADY_RESOLVED' }
  | { kind: 'ACTION_NOT_APPLICABLE'; allowedActions: string[] }
  | { kind: 'TARGET_NOT_APPLICABLE' }
  | { kind: 'TARGET_NOT_EDITABLE' }
  | { kind: 'DRAFT_NOT_EDITABLE' }
  | { kind: 'OVERLAP_STILL_PRESENT' }
  | { kind: 'BREAK_OUTSIDE_SEGMENT' }
  | { kind: 'WORK_SEGMENT_OVERLAP' }
  | { kind: 'SITE_NOT_ASSIGNED'; siteId: string }
  | { kind: 'VALIDATION_ERROR'; fieldErrors: Record<string, string[]> };

/** Full §11 domain matrix — used only to answer ACTION_NOT_APPLICABLE's informational
 * `allowedActions` when the exception's TYPE doesn't support REASON_EDIT at all. */
const DOMAIN_ALLOWED_ACTIONS: Record<string, string[]> = {
  GPS_NOT_VERIFIED: ['ACKNOWLEDGE_AS_VALID', 'DISMISS'],
  OUTSIDE_GEOFENCE_CHECKOUT: ['ACKNOWLEDGE_AS_VALID', 'DISMISS'],
  SITE_MISMATCH_CHECKOUT: ['ACKNOWLEDGE_AS_VALID', 'DISMISS', 'REASON_EDIT'],
  DOUBLE_CHECK_IN: ['PAIR_ORPHAN_EVENTS', 'DISMISS'],
  CHECKOUT_WITHOUT_OPEN_SHIFT: ['PAIR_ORPHAN_EVENTS', 'DISMISS'],
  STALE_ASSIGNMENT: ['CONFIRM_SOURCE_ASSIGNMENT'],
  GEOFENCE_VERSION_MISMATCH: ['ACKNOWLEDGE_AS_VALID', 'DISMISS'],
  LATE_SYNC_AFTER_SUBMIT: [],
  MISSING_CHECKOUT_AT_CUTOFF: ['FORCE_CLOSE_OPEN_SHIFT', 'DISMISS'],
  EXCESSIVE_CLOCK_SKEW: ['ACKNOWLEDGE_AS_VALID', 'DISMISS', 'REASON_EDIT'],
  CHECKOUT_CHRONOLOGY_ANOMALY: ['REASON_EDIT', 'DISMISS'],
  EXCESSIVE_SHIFT_DURATION: ['ACKNOWLEDGE_AS_VALID', 'DISMISS', 'REASON_EDIT'],
  PERIOD_BOUNDARY_SPAN: ['ACKNOWLEDGE_AS_VALID', 'DISMISS'],
  OVERLAPPING_SHIFT: ['DISMISS', 'REASON_EDIT']
};

function allowedActionsFor(type: string): string[] {
  return DOMAIN_ALLOWED_ACTIONS[type] ?? [];
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Thrown to force a genuine transaction rollback when, after applying the edit, the NAMED
 * OVERLAPPING_SHIFT pair still physically overlaps — caught by the outer wrapper and mapped to
 * `409 OVERLAP_STILL_PRESENT`. */
class OverlapStillPresentSignal extends Error {}

/**
 * docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §12.4, literally, per the task brief's own
 * numbered transaction steps:
 *   Read-only: exceptionId -> employeeId, no lock.
 *   Transaction: Employee FOR UPDATE -> AttendanceException FOR UPDATE -> re-check status/type ->
 *   resolve+re-verify target fragment identity -> Timesheet FOR UPDATE -> TimesheetDraft FOR
 *   UPDATE -> re-check fragment SETTLED/Timesheet DRAFT-or-RETURNED -> applyClockShiftFragmentReasonEdit
 *   (shared core) -> if OVERLAPPING_SHIFT, verify the NAMED pair no longer overlaps (else rollback
 *   with OVERLAP_STILL_PRESENT) -> RESOLVE the named exception via the REAL admin actor (never
 *   SYSTEM) -> only THEN call resolveOverlapsForAffectedShifts for the remaining candidate pairs —
 *   this ordering is what stops the general SYSTEM-attributed auto-resolution hook from ever
 *   touching the named pair itself: by the time the hook re-examines that exact (clockShiftId,
 *   relatedClockShiftId) key, `resolveOverlapTransition`'s own idempotent `latestRow.status ===
 *   'OPEN'` guard already sees `RESOLVED` and no-ops (lib/attendance-reported-projection.ts is
 *   NOT modified by this slice — this ordering alone is sufficient, proven by that existing
 *   guard) -> one AuditEvent(CLOCK_SHIFT_FRAGMENT_ADMIN_EDIT) -> COMMIT.
 */
export async function editAttendanceExceptionReason(exceptionId: string, values: EditRequestValues, actorUserId: string, requestId: string): Promise<ExceptionEditOutcome> {
  const pre = await prisma.attendanceException.findUnique({ where: { id: exceptionId }, select: EDIT_PRE_READ_SELECT });
  if (!pre) {
    return { kind: 'NOT_FOUND' };
  }
  if (pre.status !== 'OPEN') {
    return { kind: 'ALREADY_RESOLVED' };
  }
  if (!isReasonEditApplicable(pre.type)) {
    return { kind: 'ACTION_NOT_APPLICABLE', allowedActions: allowedActionsFor(pre.type) };
  }
  if (pre.type === 'CHECKOUT_CHRONOLOGY_ANOMALY' && values.endAt === undefined) {
    return { kind: 'VALIDATION_ERROR', fieldErrors: { endAt: ['required when editing a CHECKOUT_CHRONOLOGY_ANOMALY exception'] } };
  }

  try {
    return await prisma.$transaction(async (tx): Promise<ExceptionEditOutcome> => {
      // Canonical order (§8.1): Employee(1) before AttendanceException(7) — never the reverse.
      await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${pre.employeeId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "AttendanceException" WHERE id = ${exceptionId}::uuid FOR UPDATE`;

      const fresh: EditPreRead | null = await tx.attendanceException.findUnique({ where: { id: exceptionId }, select: EDIT_PRE_READ_SELECT });
      if (!fresh) {
        return { kind: 'NOT_FOUND' as const };
      }
      if (fresh.status !== 'OPEN') {
        return { kind: 'ALREADY_RESOLVED' as const };
      }
      if (!isReasonEditApplicable(fresh.type)) {
        return { kind: 'ACTION_NOT_APPLICABLE' as const, allowedActions: allowedActionsFor(fresh.type) };
      }
      if (fresh.type === 'CHECKOUT_CHRONOLOGY_ANOMALY' && values.endAt === undefined) {
        return { kind: 'VALIDATION_ERROR' as const, fieldErrors: { endAt: ['required when editing a CHECKOUT_CHRONOLOGY_ANOMALY exception'] } };
      }

      const targetOk = await resolveTargetFragmentId(tx, fresh, values.clockShiftFragmentId);
      if (!targetOk) {
        return { kind: 'TARGET_NOT_APPLICABLE' as const };
      }

      const fragmentInfo = await tx.clockShiftFragment.findUniqueOrThrow({
        where: { id: values.clockShiftFragmentId },
        select: { id: true, clockShiftId: true, timesheetId: true, date: true, reportedProjectionState: true }
      });
      if (fragmentInfo.reportedProjectionState !== 'SETTLED') {
        // PENDING — no live segment can possibly exist yet (§9.4/§9.1a "authoritative empty" is a
        // SETTLED-only concept); this is the exception-type-domain gate, distinct from the
        // segment-level NO_LIVE_SEGMENT check the shared core performs below.
        return { kind: 'ACTION_NOT_APPLICABLE' as const, allowedActions: allowedActionsFor(fresh.type) };
      }

      // Canonical order continues: Timesheet(5) FOR UPDATE -> TimesheetDraft(6) FOR UPDATE.
      await tx.$queryRaw`SELECT id FROM "Timesheet" WHERE id = ${fragmentInfo.timesheetId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "TimesheetDraft" WHERE "timesheetId" = ${fragmentInfo.timesheetId}::uuid FOR UPDATE`;

      const timesheet = await tx.timesheet.findUniqueOrThrow({ where: { id: fragmentInfo.timesheetId }, select: { status: true } });
      if (timesheet.status !== 'DRAFT' && timesheet.status !== 'RETURNED') {
        return { kind: 'DRAFT_NOT_EDITABLE' as const };
      }

      const newValues: ClockShiftFragmentEditValues = {};
      if (values.startAt !== undefined) {
        newValues.startAt = values.startAt;
      }
      if (values.endAt !== undefined) {
        newValues.endAt = values.endAt;
      }
      if (values.siteId !== undefined) {
        newValues.siteId = values.siteId;
      }
      if ('workAreaId' in values) {
        newValues.workAreaId = values.workAreaId ?? null;
      }

      const editOutcome = await applyClockShiftFragmentReasonEdit(tx, actorUserId, fresh.employeeId, values.clockShiftFragmentId, newValues, values.reason, requestId);
      switch (editOutcome.kind) {
        case 'NO_LIVE_SEGMENT':
          return { kind: 'TARGET_NOT_EDITABLE' as const };
        case 'NO_CHANGE':
          return { kind: 'VALIDATION_ERROR' as const, fieldErrors: { '': ['request does not change any reported value'] } };
        case 'SITE_CHANGE_REQUIRES_WORK_AREA':
          return { kind: 'VALIDATION_ERROR' as const, fieldErrors: { workAreaId: ['required (may be null) when siteId changes'] } };
        case 'INVALID_CHRONOLOGY':
          return { kind: 'VALIDATION_ERROR' as const, fieldErrors: { endAt: ['must be strictly after startAt'] } };
        case 'SITE_NOT_ASSIGNED':
          return { kind: 'SITE_NOT_ASSIGNED' as const, siteId: editOutcome.siteId };
        case 'BREAK_OUTSIDE_SEGMENT':
          return { kind: 'BREAK_OUTSIDE_SEGMENT' as const };
        case 'APPLIED':
          break;
      }

      const applied = editOutcome.result;

      if (fresh.type === 'OVERLAPPING_SHIFT' && fresh.clockShiftId && fresh.relatedClockShiftId) {
        const stillOverlaps = await overlapExists(tx, fresh.clockShiftId, fresh.relatedClockShiftId);
        if (stillOverlaps) {
          throw new OverlapStillPresentSignal();
        }
      }

      const resolvedAt = new Date();
      await tx.attendanceException.update({
        where: { id: exceptionId },
        data: { status: 'RESOLVED', resolvedByUserId: actorUserId, resolvedAt, resolutionNote: values.reason }
      });

      // Only AFTER the named exception is durably RESOLVED via the real admin actor — see the
      // ordering rationale in this function's own doc comment above.
      await resolveOverlapsForAffectedShifts(tx, applied.affectedShiftIds, applied.beforeRangesByShift, requestId);

      await createAuditEvent(tx, {
        actorUserId,
        eventType: 'CLOCK_SHIFT_FRAGMENT_ADMIN_EDIT',
        entityType: 'ATTENDANCE_EXCEPTION',
        entityId: exceptionId,
        requestId,
        beforeValue: { status: 'OPEN', type: fresh.type, fragmentId: applied.fragment.id, clockShiftId: applied.fragment.clockShiftId },
        afterValue: {
          status: 'RESOLVED',
          resolutionAction: 'REASON_EDIT',
          fragmentId: applied.fragment.id,
          clockShiftId: applied.fragment.clockShiftId,
          changeType: applied.adjustment.changeType,
          segmentId: applied.segment.id,
          startAt: applied.segment.startAt.toISOString(),
          endAt: applied.segment.endAt.toISOString(),
          siteId: applied.segment.siteId,
          workAreaId: applied.segment.workAreaId
        },
        reason: values.reason
      });

      const actor = await tx.user.findUniqueOrThrow({ where: { id: actorUserId }, select: { username: true, employee: { select: { firstName: true, lastName: true } } } });

      return {
        kind: 'OK' as const,
        result: {
          resolutionAction: 'REASON_EDIT' as const,
          exception: {
            id: exceptionId,
            type: fresh.type,
            status: 'RESOLVED' as const,
            resolvedAt: resolvedAt.toISOString(),
            resolvedBy: { id: actorUserId, name: actorDisplayName(actor) },
            resolutionNote: values.reason
          },
          fragment: {
            id: applied.fragment.id,
            clockShiftId: applied.fragment.clockShiftId,
            timesheetId: applied.fragment.timesheetId,
            date: formatDate(applied.fragment.date),
            reportedProjectionState: 'SETTLED' as const
          },
          segment: {
            id: applied.segment.id,
            startAt: applied.segment.startAt.toISOString(),
            endAt: applied.segment.endAt.toISOString(),
            siteId: applied.segment.siteId,
            workAreaId: applied.segment.workAreaId,
            sourceAssignmentId: applied.segment.sourceAssignmentId
          },
          adjustment: {
            id: applied.adjustment.id,
            changeType: applied.adjustment.changeType,
            reason: applied.adjustment.reason,
            changedByUserId: applied.adjustment.changedByUserId,
            changedAt: applied.adjustment.changedAt.toISOString()
          }
        }
      };
    });
  } catch (error) {
    if (error instanceof OverlapStillPresentSignal) {
      return { kind: 'OVERLAP_STILL_PRESENT' };
    }
    if (isSegmentOverlapViolation(error)) {
      return { kind: 'WORK_SEGMENT_OVERLAP' };
    }
    throw error;
  }
}
