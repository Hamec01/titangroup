import { Prisma } from '@prisma/client';
import type { SiteAssignment } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import { createAssignmentInTx, isExclusionViolation } from '@/lib/assignments';
import { recordAssignmentTransition, reasonFromFreeText } from '@/lib/assignment-transitions';
import { isAssignmentLiveNow, liveAssignmentWhere } from '@/lib/assignment-lifecycle';
import { helsinkiToday, earliestAssignmentEndDate } from '@/lib/workers';

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §2.4 / §3 — the ONE writer of
// SiteAssignment + AssignmentTransition for lifecycle operations (change / remove; site-finish,
// customer-disable and group-change land in Deploy C/E). Routes do HTTP/auth/CSRF/validation and
// call in here; the mutation, the draft-shift cleanup, the EmployeeOpenShift re-point, the
// AssignmentTransition row and the AuditEvent all commit in ONE transaction under a per-employee
// advisory lock (§3.13). Kept OUT of lib/assignment-lifecycle.ts (the pure gate imported by the
// hot clock path) to avoid an import cycle through lib/assignments.ts.

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** One shared advisory-lock name for every per-employee lifecycle operation (remove / change /
 *  promote / …) so two admins acting on the same worker serialise. Prisma's tagged template
 *  parameterises the interpolated id — not string-built SQL. */
export function assignmentLifecycleLockKey(employeeId: string): string {
  return `titanor_time:assignment_lifecycle:${employeeId}`;
}

export async function acquireEmployeeLifecycleLock(tx: Prisma.TransactionClient, employeeId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${assignmentLifecycleLockKey(employeeId)})::bigint)`;
}

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
  /** Free-text reason from the current worker-card UI (Deploy B swaps in presets). */
  reasonText: string | null;
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
  const { reasonCode, reasonText } = reasonFromFreeText(input.reasonText);

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
          // Match the legacy /end: only overwrite endedReason when a reason was actually given
          // (it is required whenever ending earlier than planned).
          ...(reasonText !== null ? { endedReason: reasonText } : {}),
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
}

export type ChangeWorkplaceError =
  | { code: 'ASSIGNMENT_OVERLAP' }
  | { code: 'ASSIGNMENT_HAS_RECORDED_TIME' };

export interface ChangeWorkplaceResult {
  closedAssignmentId: string;
  closedValidTo: Date;
  effectiveFrom: Date;
  openShiftHandling: 'MOVE_TO_NEW' | 'KEEP_ON_OLD' | null;
  newAssignment: Awaited<ReturnType<typeof createAssignmentInTx>>;
  transitionId: string;
}

/**
 * §3.5 — close the current assignment the day before `effectiveFrom` and open a fully-materialised
 * replacement for the rest of the open window. The old row also gets `clockInDisabledAt` when the
 * change is immediate (effectiveFrom <= today) so it drops out of the Check-In options at once;
 * for a future change the calendar boundary (validTo = effectiveFrom − 1) already hands over
 * cleanly, so clockInDisabledAt is left for the effective day. Writes an AssignmentTransition
 * (kind = CHANGE) + AuditEvent in the same transaction, under the per-employee advisory lock.
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

      const closedValidTo = new Date(effectiveFrom.getTime() - ONE_DAY_MS);

      await tx.timesheetDraftPlannedShift.deleteMany({
        where: { sourceAssignmentId: existing.id, date: { gte: effectiveFrom } }
      });

      await tx.siteAssignment.update({
        where: { id: existing.id },
        data: {
          validTo: closedValidTo,
          ...(isImmediate ? { clockInDisabledAt: now } : {}),
          endedReason: reasonText ?? 'Изменение объекта / заказчика',
          version: { increment: 1 }
        }
      });

      const newAssignment = await createAssignmentInTx(tx, {
        employeeId: existing.employeeId,
        siteId: input.siteId,
        workAreaId: input.workAreaId,
        templateVersionId: input.templateVersionId,
        validFrom: effectiveFrom,
        validTo: input.newValidTo,
        isPrimary: input.isPrimary,
        assignedByUserId: actorUserId
      });

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
    if (isExclusionViolation(error)) {
      return { code: 'ASSIGNMENT_OVERLAP' };
    }
    if (isAssignmentDependentsConflict(error)) {
      return { code: 'ASSIGNMENT_HAS_RECORDED_TIME' };
    }
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// promoteToPrimary — "сделать основным" (§3.6 — ≤1 live primary per worker)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface PromoteToPrimaryInput {
  existing: SiteAssignment;
  actorUserId: string;
  requestId: string;
}

export type PromoteToPrimaryError = { code: 'ASSIGNMENT_NOT_ACTIVE' };

export interface PromoteToPrimaryResult {
  demotedAssignmentIds: string[];
}

/**
 * §3.6 — make this the one primary assignment. Demotes every other operationally-live primary of
 * the same worker in the same transaction (the app-level half of the "≤1 live primary" invariant;
 * Deploy D adds the partial unique index as the DB backstop). "Live" here is the unified gate —
 * a removed / future-disabled assignment is neither promoted nor demoted.
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

  return prisma.$transaction(async (tx) => {
    await acquireEmployeeLifecycleLock(tx, existing.employeeId);

    const demoted = await tx.siteAssignment.findMany({
      where: {
        employeeId: existing.employeeId,
        id: { not: existing.id },
        isPrimary: true,
        ...liveAssignmentWhere(now, today)
      },
      select: { id: true }
    });

    if (demoted.length > 0) {
      await tx.siteAssignment.updateMany({
        where: { id: { in: demoted.map((a) => a.id) } },
        data: { isPrimary: false, version: { increment: 1 } }
      });
    }

    await tx.siteAssignment.update({
      where: { id: existing.id },
      data: { isPrimary: true, version: { increment: 1 } }
    });

    await recordAssignmentTransition(tx, {
      employeeId: existing.employeeId,
      kind: 'CHANGE',
      fromAssignmentId: demoted[0]?.id ?? null,
      toAssignmentId: existing.id,
      actedAt: now,
      effectiveFrom: today,
      openShiftHandling: 'NONE',
      actorUserId,
      reasonCode: 'OTHER',
      reasonText: 'promoted to primary'
    });

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
        demotedAssignmentIds: demoted.map((a) => a.id)
      }
    });

    return { demotedAssignmentIds: demoted.map((a) => a.id) };
  });
}
