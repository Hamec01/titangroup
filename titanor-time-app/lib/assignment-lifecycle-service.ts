import { Prisma } from '@prisma/client';
import type { SiteAssignment, AssignmentTransitionReason } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { createAssignmentInTx, isExclusionViolation } from '@/lib/assignments';
import { recordAssignmentTransition, reasonFromFreeText, reasonFromPreset } from '@/lib/assignment-transitions';
import { isAssignmentLiveNow } from '@/lib/assignment-lifecycle';
import {
  acquireEmployeeLifecycleLock,
  overlappingPrimaryWhere,
  isPrimaryPeriodConflict,
  ScheduledPrimaryConflictError
} from '@/lib/assignment-lock';
import { helsinkiToday, earliestAssignmentEndDate } from '@/lib/workers';

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §2.4 / §3 — the ONE writer of
// SiteAssignment + AssignmentTransition for lifecycle operations (change / remove; site-finish,
// customer-disable and group-change land in Deploy C/E). Routes do HTTP/auth/CSRF/validation and
// call in here; the mutation, the draft-shift cleanup, the EmployeeOpenShift re-point, the
// AssignmentTransition row and the AuditEvent all commit in ONE transaction under a per-employee
// advisory lock (§3.13). Kept OUT of lib/assignment-lifecycle.ts (the pure gate imported by the
// hot clock path) to avoid an import cycle through lib/assignments.ts.

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// The per-employee advisory lock + the ex_site_assignment_one_primary_per_period predicate/conflict
// helpers live in lib/assignment-lock.ts (standalone, no import cycle) — re-exported here so
// callers of this service keep one import.
export { acquireEmployeeLifecycleLock, assignmentLifecycleLockKey } from '@/lib/assignment-lock';

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// fn_site_assignment_dependents_guard (05_RAW_SQL_REGISTER.md, TRG-11) raises a plain P0001 when a
// validTo shrink would strand a WorkSegment / TimesheetPlannedShift / TimesheetDraftSegment /
// TimesheetDraftPlannedShift row outside the assignment's own window.
function isAssignmentDependentsConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientUnknownRequestError &&
    error.message.includes('P0001') &&
    error.message.includes('ASSIGNMENT_DEPENDENTS_CONFLICT')
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// removeFromSite — "Снять с объекта" (§3.1 immediate / §3.2 after-check-out)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface RemoveFromSiteInput {
  /** Already loaded + shape-validated by the route. */
  existing: SiteAssignment;
  /** UTC-midnight calendar date the payroll window closes on. Route guarantees
   *  validFrom <= validTo <= existing.validTo (when set). §3.1: normally today. */
  validTo: Date;
  /** Free-text reason from the legacy /end UI. */
  reasonText: string | null;
  /** R15-D7 Deploy B — the worker card's structured reason preset. When set it wins over
   *  `reasonText` (which is only kept for OTHER). */
  reasonCode?: AssignmentTransitionReason | null;
  actorUserId: string;
  requestId: string;
}

export type RemoveFromSiteError =
  | { code: 'ASSIGNMENT_HAS_RECORDED_TIME'; earliestValidTo: string | null }
  | { code: 'ASSIGNMENT_HAS_DEPENDENTS'; earliestValidTo: string | null };

export interface RemoveFromSiteResult {
  assignment: SiteAssignment;
  /** null when this call was an idempotent no-op (row already removed). */
  transitionId: string | null;
  /** true when the worker was on an open shift — the row stays visible as "shift in progress" and
   *  its validTo is extended at Check Out (§3.12) if the shift runs past `validTo`. */
  hadOpenShift: boolean;
}

/**
 * §3.1/§3.2 — stop the worker clocking in on this assignment right now. `clockInDisabledAt = now()`
 * is the single operational gate (every "current assignment" consumer already honours it via
 * liveAssignmentWhere); `validTo` is set as the calendar/payroll boundary but does NOT gate
 * Check In. An open shift is never interrupted — Check Out stays available and, if it lands on a
 * later calendar day, extends validTo (§3.12, Deploy A A4). The assignment's own future draft
 * planned shifts are deleted so "снять сегодня" actually lands on today.
 */
export async function removeFromSite(input: RemoveFromSiteInput): Promise<RemoveFromSiteResult | RemoveFromSiteError> {
  const { existing, validTo, actorUserId, requestId } = input;
  const now = new Date();
  const { reasonCode, reasonText, endedReason } = reasonFromPreset(input.reasonCode ?? null, input.reasonText);

  // Recorded / submitted time on a day AFTER the new end date can't be dropped — surface it as an
  // actionable 409 (same contract as the old /end). Draft *planned* shifts (the auto-materialised
  // schedule) carry no information once the worker is removed and are deleted in the tx below.
  const [recordedSegments, submittedShifts, recordedDraftSegments, recordedFragments] = await Promise.all([
    prisma.workSegment.count({ where: { sourceAssignmentId: existing.id, date: { gt: validTo } } }),
    prisma.timesheetPlannedShift.count({ where: { sourceAssignmentId: existing.id, date: { gt: validTo } } }),
    prisma.timesheetDraftSegment.count({ where: { sourceAssignmentId: existing.id, date: { gt: validTo } } }),
    prisma.clockShiftFragment.count({ where: { sourceAssignmentId: existing.id, date: { gt: validTo } } })
  ]);
  if (recordedSegments > 0 || submittedShifts > 0 || recordedDraftSegments > 0 || recordedFragments > 0) {
    return { code: 'ASSIGNMENT_HAS_RECORDED_TIME', earliestValidTo: await earliestAssignmentEndDate(existing.id) };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await acquireEmployeeLifecycleLock(tx, existing.employeeId);

      // §9.1 — a repeated click / concurrent request must not write a second transition. Under the
      // lock, re-read: if the row is already operationally removed and this call would not move the
      // payroll boundary earlier, it is a no-op.
      const locked = await tx.siteAssignment.findUnique({
        where: { id: existing.id },
        select: { clockInDisabledAt: true, validTo: true }
      });
      if (
        locked?.clockInDisabledAt != null &&
        locked.validTo != null &&
        validTo.getTime() >= locked.validTo.getTime()
      ) {
        const current = await tx.siteAssignment.findUniqueOrThrow({ where: { id: existing.id } });
        return { assignment: current, transitionId: null, hadOpenShift: false };
      }

      const openShift = await tx.employeeOpenShift.findUnique({
        where: { employeeId: existing.employeeId },
        select: { sourceAssignmentId: true }
      });
      const hadOpenShift = openShift?.sourceAssignmentId === existing.id;

      await tx.timesheetDraftPlannedShift.deleteMany({
        where: { sourceAssignmentId: existing.id, date: { gt: validTo } }
      });

      const assignment = await tx.siteAssignment.update({
        where: { id: existing.id },
        data: {
          validTo,
          clockInDisabledAt: now,
          // Only overwrite endedReason when a reason was actually given (a preset code or free
          // text) — it is required whenever ending earlier than planned.
          ...(endedReason !== null ? { endedReason } : {}),
          version: { increment: 1 }
        }
      });

      const transition = await recordAssignmentTransition(tx, {
        employeeId: existing.employeeId,
        kind: 'REMOVE',
        fromAssignmentId: existing.id,
        toAssignmentId: null,
        actedAt: now,
        effectiveFrom: validTo,
        openShiftHandling: hadOpenShift ? 'AFTER_CHECK_OUT' : 'NONE',
        actorUserId,
        reasonCode,
        reasonText
      });

      await createAuditEvent(tx, {
        actorUserId,
        eventType: 'ASSIGNMENT_ENDED',
        entityType: 'SITE_ASSIGNMENT',
        entityId: assignment.id,
        requestId,
        beforeValue: { validTo: existing.validTo ? formatDate(existing.validTo) : null, clockInDisabledAt: null },
        afterValue: {
          validTo: formatDate(assignment.validTo!),
          clockInDisabledAt: now.toISOString(),
          openShiftHandling: hadOpenShift ? 'AFTER_CHECK_OUT' : 'NONE',
          transitionId: transition.id
        },
        reason: reasonText
      });

      return { assignment, transitionId: transition.id, hadOpenShift };
    });
  } catch (error) {
    if (isAssignmentDependentsConflict(error)) {
      return { code: 'ASSIGNMENT_HAS_DEPENDENTS', earliestValidTo: await earliestAssignmentEndDate(existing.id) };
    }
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// changeWorkplace — "Изменить место работы" (§3.3 future / §3.4 same-day fix / §3.5 one form)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ChangeWorkplaceInput {
  /** Already loaded + validated by the route. */
  existing: SiteAssignment;
  /** UTC-midnight, already adjusted for the KEEP_ON_OLD open-shift bump. Route guarantees
   *  effectiveFrom > existing.validFrom and (when set) <= existing.validTo. */
  effectiveFrom: Date;
  siteId: string;
  workAreaId: string | null;
  templateVersionId: string | null;
  isPrimary: boolean;
  /** The remaining window end carried over to the replacement — = existing.validTo. */
  newValidTo: Date | null;
  /** true → the worker's current open shift is re-pointed to the new assignment (§3.2 MOVED_TO_NEW). */
  movesOpenShift: boolean;
  /** true when there is an open shift at all (for the AssignmentTransition.openShiftHandling value). */
  openShiftPresent: boolean;
  reasonText: string | null;
  actorUserId: string;
  requestId: string;
  /** §P4 — 'REPLACE_SCHEDULED' demotes an overlapping scheduled future primary; absent → such an
   *  overlap returns SCHEDULED_PRIMARY_CONFLICT so the admin decides. */
  primaryConflictResolution?: 'KEEP_SCHEDULED' | 'REPLACE_SCHEDULED';
}

export type ChangeWorkplaceError =
  | { code: 'ASSIGNMENT_OVERLAP' }
  | { code: 'ASSIGNMENT_HAS_RECORDED_TIME' }
  | { code: 'PRIMARY_PERIOD_CONFLICT' }
  | { code: 'SCHEDULED_PRIMARY_CONFLICT'; scheduledAssignmentId: string; scheduledValidFrom: string };

export interface ChangeWorkplaceResult {
  closedAssignmentId: string;
  closedValidTo: Date;
  effectiveFrom: Date;
  openShiftHandling: 'MOVE_TO_NEW' | 'KEEP_ON_OLD' | null;
  newAssignment: Awaited<ReturnType<typeof createAssignmentInTx>>['assignment'];
  transitionId: string;
}

/**
 * §3.5 / §P1–P2 / §P5–P6 — close the current assignment and open a fully-materialised replacement
 * from `effectiveFrom`, one transaction, per-employee advisory lock, AssignmentTransition
 * (kind = CHANGE) + AuditEvent.
 *
 * FUTURE change (`effectiveFrom > today`): old row → validTo = effectiveFrom − 1, KEEPS isPrimary.
 * The two primary periods are disjoint ([.., effectiveFrom−1] and [effectiveFrom, ..]) so both
 * rows stay primary and the handover is purely by date — before `effectiveFrom` the worker /
 * timesheet / Check-In resolve the old assignment as "the primary now" (its range covers today),
 * from `effectiveFrom` the new one, with no cron and no manual step (§P1/§P2).
 *
 * IMMEDIATE change (`effectiveFrom <= today`): old row → clockInDisabledAt = now + isPrimary =
 * false (demoted now, out of Check-In and out of the one-primary-per-period constraint). validTo =
 * effectiveFrom − 1 normally, but = `today` when the worker already has recorded / submitted /
 * planned time on the old assignment dated `today` (§P5) — that day's completed interval stays
 * attributed to the old site, the transfer still succeeds, and the next Check In goes to the new
 * one. Open shift: KEEP_ON_OLD bumps `effectiveFrom` to tomorrow (route) so the shift finishes on
 * the old assignment; MOVE_TO_NEW re-points the open shift so the whole shift lands on the new one
 * (§P6). Check Out is never blocked by either.
 */
export async function changeWorkplace(input: ChangeWorkplaceInput): Promise<ChangeWorkplaceResult | ChangeWorkplaceError> {
  const { existing, effectiveFrom, actorUserId, requestId } = input;
  const now = new Date();
  const today = helsinkiToday();
  const { reasonCode, reasonText } = reasonFromFreeText(input.reasonText);
  const openShiftHandling: 'MOVE_TO_NEW' | 'KEEP_ON_OLD' | null = input.openShiftPresent
    ? input.movesOpenShift
      ? 'MOVE_TO_NEW'
      : 'KEEP_ON_OLD'
    : null;
  const isImmediate = effectiveFrom.getTime() <= today.getTime();

  try {
    return await prisma.$transaction(async (tx) => {
      await acquireEmployeeLifecycleLock(tx, existing.employeeId);

      // §P5 — an immediate transfer normally closes the old assignment the day BEFORE the switch
      // so the two periods stay disjoint. But if the worker already has recorded / submitted /
      // planned time on the OLD assignment dated the transfer day itself, that day MUST stay on the
      // old assignment (validTo = today) — otherwise TRG-11 (fn_site_assignment_dependents_guard)
      // strands it and the whole transfer 409s. The old row still gets clockInDisabledAt = now +
      // isPrimary = false below, so it leaves Check-In and the one-primary-per-period constraint
      // even though its now-shortened period shares `today` with the replacement.
      let closedValidTo = new Date(effectiveFrom.getTime() - ONE_DAY_MS);
      if (isImmediate) {
        const [dseg, frag, wseg, pshift] = await Promise.all([
          tx.timesheetDraftSegment.count({ where: { sourceAssignmentId: existing.id, date: effectiveFrom } }),
          tx.clockShiftFragment.count({ where: { sourceAssignmentId: existing.id, date: effectiveFrom } }),
          tx.workSegment.count({ where: { sourceAssignmentId: existing.id, date: effectiveFrom } }),
          tx.timesheetPlannedShift.count({ where: { sourceAssignmentId: existing.id, date: effectiveFrom } })
        ]);
        if (dseg + frag + wseg + pshift > 0) {
          closedValidTo = new Date(effectiveFrom.getTime());
        }
      }

      // Keep the transfer day's draft planned shift on the old assignment when that day stays with
      // it (a TimesheetDraftSegment for that day FK-references it with onDelete: Restrict anyway).
      await tx.timesheetDraftPlannedShift.deleteMany({
        where: { sourceAssignmentId: existing.id, date: { gt: closedValidTo } }
      });

      await tx.siteAssignment.update({
        where: { id: existing.id },
        data: {
          validTo: closedValidTo,
          // Immediate change (§3.3): the old row is demoted now and operationally removed — it
          // leaves the Check-In options and drops out of the one-primary-per-period constraint
          // predicate. A FUTURE change leaves it primary over its now-shortened past period, which
          // is disjoint from the replacement's period (both stay primary; the handover is by date).
          ...(isImmediate ? { clockInDisabledAt: now, isPrimary: false } : {}),
          endedReason: reasonText ?? 'Изменение объекта / заказчика',
          version: { increment: 1 }
        }
      });

      // §P4 — 'KEEP_SCHEDULED' means the admin already saw a SCHEDULED_PRIMARY_CONFLICT and wants
      // to keep the planned transfer; make the replacement non-primary in that case.
      const newIsPrimary = input.isPrimary && input.primaryConflictResolution !== 'KEEP_SCHEDULED';

      const { assignment: newAssignment, demotedPrimaryIds, demotedScheduledPrimaryIds } = await createAssignmentInTx(tx, {
        employeeId: existing.employeeId,
        siteId: input.siteId,
        workAreaId: input.workAreaId,
        templateVersionId: input.templateVersionId,
        validFrom: effectiveFrom,
        validTo: input.newValidTo,
        isPrimary: newIsPrimary,
        assignedByUserId: actorUserId,
        replaceScheduledPrimary: input.primaryConflictResolution === 'REPLACE_SCHEDULED'
      });

      // §3.6 — a demoted prior primary OTHER than the one being replaced here gets its own
      // transition (the replaced one is already recorded by the from→to transition below). A
      // scheduled future primary is flagged distinctly — its assignment is not cancelled.
      const scheduledSet = new Set(demotedScheduledPrimaryIds);
      for (const demotedId of demotedPrimaryIds.filter((id) => id !== existing.id)) {
        await recordAssignmentTransition(tx, {
          employeeId: existing.employeeId,
          kind: 'CHANGE',
          fromAssignmentId: demotedId,
          toAssignmentId: newAssignment.id,
          actedAt: now,
          effectiveFrom,
          openShiftHandling: 'NONE',
          actorUserId,
          reasonCode: 'OTHER',
          reasonText: scheduledSet.has(demotedId)
            ? 'primary superseded — this assignment was scheduled to become the worker’s primary; the assignment itself is unchanged'
            : 'auto-demoted: another assignment became the primary'
        });
      }

      if (input.movesOpenShift) {
        await tx.employeeOpenShift.update({
          where: { employeeId: existing.employeeId },
          data: { siteId: input.siteId, workAreaId: input.workAreaId, sourceAssignmentId: newAssignment.id }
        });
      }

      const transition = await recordAssignmentTransition(tx, {
        employeeId: existing.employeeId,
        kind: 'CHANGE',
        fromAssignmentId: existing.id,
        toAssignmentId: newAssignment.id,
        actedAt: now,
        effectiveFrom,
        openShiftHandling:
          openShiftHandling === 'MOVE_TO_NEW' ? 'MOVED_TO_NEW' : openShiftHandling === 'KEEP_ON_OLD' ? 'AFTER_CHECK_OUT' : 'NONE',
        actorUserId,
        reasonCode,
        reasonText
      });

      await createAuditEvent(tx, {
        actorUserId,
        eventType: 'ASSIGNMENT_CHANGED',
        entityType: 'SITE_ASSIGNMENT',
        entityId: existing.id,
        requestId,
        beforeValue: {
          id: existing.id,
          siteId: existing.siteId,
          workAreaId: existing.workAreaId,
          templateVersionId: existing.templateVersionId,
          isPrimary: existing.isPrimary,
          validFrom: formatDate(existing.validFrom),
          validTo: existing.validTo ? formatDate(existing.validTo) : null
        },
        afterValue: {
          closedAssignmentId: existing.id,
          closedValidTo: formatDate(closedValidTo),
          effectiveFrom: formatDate(effectiveFrom),
          newAssignmentId: newAssignment.id,
          newSiteId: newAssignment.siteId,
          newWorkAreaId: newAssignment.workAreaId,
          newTemplateVersionId: newAssignment.templateVersionId,
          newIsPrimary: newAssignment.isPrimary,
          demotedPrimaryAssignmentIds: demotedPrimaryIds,
          demotedScheduledPrimaryAssignmentIds: demotedScheduledPrimaryIds,
          openShiftHandling,
          transitionId: transition.id
        },
        reason: reasonText
      });

      return {
        closedAssignmentId: existing.id,
        closedValidTo,
        effectiveFrom,
        openShiftHandling,
        newAssignment,
        transitionId: transition.id
      };
    });
  } catch (error) {
    if (error instanceof ScheduledPrimaryConflictError) {
      return {
        code: 'SCHEDULED_PRIMARY_CONFLICT',
        scheduledAssignmentId: error.scheduledAssignmentId,
        scheduledValidFrom: error.scheduledValidFrom.toISOString().slice(0, 10)
      };
    }
    if (isExclusionViolation(error)) {
      return { code: 'ASSIGNMENT_OVERLAP' };
    }
    if (isAssignmentDependentsConflict(error)) {
      return { code: 'ASSIGNMENT_HAS_RECORDED_TIME' };
    }
    if (isPrimaryPeriodConflict(error)) {
      return { code: 'PRIMARY_PERIOD_CONFLICT' };
    }
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// promoteToPrimary — "сделать основным" (§3.6 — ≤1 primary per overlapping period)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface PromoteToPrimaryInput {
  existing: SiteAssignment;
  actorUserId: string;
  requestId: string;
  /** When set, the promote is rejected with VERSION_CONFLICT unless the row is still at this
   *  version (the PATCH toggle carries the version the admin saw). */
  expectedVersion?: number;
  /** §P4 — 'REPLACE_SCHEDULED' demotes an overlapping scheduled future primary; anything else
   *  (incl. absent / 'KEEP_SCHEDULED') → SCHEDULED_PRIMARY_CONFLICT (the promote cannot keep both). */
  primaryConflictResolution?: 'KEEP_SCHEDULED' | 'REPLACE_SCHEDULED';
}

export type PromoteToPrimaryError =
  | { code: 'ASSIGNMENT_NOT_ACTIVE' }
  | { code: 'PRIMARY_PERIOD_CONFLICT' }
  | { code: 'VERSION_CONFLICT' }
  | { code: 'SCHEDULED_PRIMARY_CONFLICT'; scheduledAssignmentId: string; scheduledValidFrom: string };

export interface PromoteToPrimaryResult {
  demotedAssignmentIds: string[];
}

/**
 * §3.6 / §P4 — make this THE primary for its own period. Demotes every other primary of the same
 * worker whose date range OVERLAPS this one's, in the same transaction under the per-employee
 * advisory lock — the app-level half of "≤1 primary per overlapping period"; the EXCLUDE
 * constraint is the DB backstop. A non-overlapping scheduled future primary is left alone. If an
 * OVERLAPPING primary is a scheduled future transfer, the promote returns SCHEDULED_PRIMARY_CONFLICT
 * unless the caller passed 'REPLACE_SCHEDULED'. A removed / already-disabled assignment is neither
 * promoted nor demoted.
 */
export async function promoteToPrimary(
  input: PromoteToPrimaryInput
): Promise<PromoteToPrimaryResult | PromoteToPrimaryError> {
  const { existing, actorUserId, requestId } = input;
  const now = new Date();
  const today = helsinkiToday();

  if (
    !isAssignmentLiveNow(
      { validFrom: existing.validFrom, validTo: existing.validTo, clockInDisabledAt: existing.clockInDisabledAt },
      now,
      today
    )
  ) {
    return { code: 'ASSIGNMENT_NOT_ACTIVE' };
  }
  if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
    return { code: 'VERSION_CONFLICT' };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await acquireEmployeeLifecycleLock(tx, existing.employeeId);

      // Re-read under the lock so a concurrent change since `existing` was loaded is caught.
      const locked = await tx.siteAssignment.findUnique({
        where: { id: existing.id },
        select: { version: true, clockInDisabledAt: true, validFrom: true, validTo: true }
      });
      if (!locked) {
        return { code: 'ASSIGNMENT_NOT_ACTIVE' as const };
      }
      if (input.expectedVersion !== undefined && locked.version !== input.expectedVersion) {
        return { code: 'VERSION_CONFLICT' as const };
      }
      if (!isAssignmentLiveNow(locked, now, today)) {
        return { code: 'ASSIGNMENT_NOT_ACTIVE' as const };
      }

      // Demote every OTHER non-removed primary of this worker whose date range OVERLAPS this
      // assignment's (§3.6). A disjoint scheduled future primary is left alone.
      const demoted = await tx.siteAssignment.findMany({
        where: {
          employeeId: existing.employeeId,
          id: { not: existing.id },
          ...overlappingPrimaryWhere({ validFrom: locked.validFrom, validTo: locked.validTo })
        },
        select: { id: true, validFrom: true }
      });
      const scheduled = demoted.filter((a) => a.validFrom > today);
      if (scheduled.length > 0 && input.primaryConflictResolution !== 'REPLACE_SCHEDULED') {
        // §P4 — cannot promote past a scheduled transfer without an explicit decision.
        return {
          code: 'SCHEDULED_PRIMARY_CONFLICT' as const,
          scheduledAssignmentId: scheduled[0].id,
          scheduledValidFrom: formatDate(scheduled[0].validFrom)
        };
      }

      const demotedIds = demoted.map((a) => a.id);
      const scheduledSet = new Set(scheduled.map((a) => a.id));
      if (demotedIds.length > 0) {
        await tx.siteAssignment.updateMany({
          where: { id: { in: demotedIds } },
          data: { isPrimary: false, version: { increment: 1 } }
        });
      }

      await tx.siteAssignment.update({
        where: { id: existing.id },
        data: { isPrimary: true, version: { increment: 1 } }
      });

      // One transition per demoted prior primary (never a hidden change, §3.6) — plus a bare
      // "promoted" marker when nothing had to be demoted.
      if (demotedIds.length === 0) {
        await recordAssignmentTransition(tx, {
          employeeId: existing.employeeId,
          kind: 'CHANGE',
          fromAssignmentId: null,
          toAssignmentId: existing.id,
          actedAt: now,
          effectiveFrom: today,
          openShiftHandling: 'NONE',
          actorUserId,
          reasonCode: 'OTHER',
          reasonText: 'promoted to primary'
        });
      }
      for (const demotedId of demotedIds) {
        await recordAssignmentTransition(tx, {
          employeeId: existing.employeeId,
          kind: 'CHANGE',
          fromAssignmentId: demotedId,
          toAssignmentId: existing.id,
          actedAt: now,
          effectiveFrom: today,
          openShiftHandling: 'NONE',
          actorUserId,
          reasonCode: 'OTHER',
          reasonText: scheduledSet.has(demotedId)
            ? 'scheduled primary transfer replaced by an explicit promote — the assignment itself is unchanged, only its primary status'
            : 'promoted to primary — prior primary demoted'
        });
      }

      await createAuditEvent(tx, {
        actorUserId,
        eventType: 'ASSIGNMENT_PROMOTED',
        entityType: 'SITE_ASSIGNMENT',
        entityId: existing.id,
        requestId,
        beforeValue: null,
        afterValue: {
          assignmentId: existing.id,
          employeeId: existing.employeeId,
          demotedAssignmentIds: demotedIds,
          demotedScheduledPrimaryAssignmentIds: [...scheduledSet]
        }
      });

      return { demotedAssignmentIds: demotedIds };
    });
  } catch (error) {
    if (isPrimaryPeriodConflict(error)) {
      return { code: 'PRIMARY_PERIOD_CONFLICT' };
    }
    throw error;
  }
}
