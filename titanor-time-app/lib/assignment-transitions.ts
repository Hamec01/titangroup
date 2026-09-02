import type { Prisma } from '@prisma/client';
import type {
  AssignmentTransitionKind,
  AssignmentTransitionOpenShift,
  AssignmentTransitionReason
} from '@prisma/client';

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §4 — the structured, append-only history
// of every lifecycle operation (change / remove / site-finish / customer-disable / group-change).
// Written IN ADDITION to the AuditEvent (never instead), in the same transaction as the mutation,
// by the lib/assignment-lifecycle.ts service — nothing else writes this table. The DB has an
// immutability trigger (fn_assignment_transition_immutable, BEFORE UPDATE OR DELETE).

export interface RecordAssignmentTransitionInput {
  employeeId: string;
  kind: AssignmentTransitionKind;
  fromAssignmentId?: string | null;
  toAssignmentId?: string | null;
  /** The exact instant the admin performed the action. */
  actedAt: Date;
  /** The calendar date (UTC-midnight Date) the new arrangement takes effect. */
  effectiveFrom: Date;
  openShiftHandling?: AssignmentTransitionOpenShift | null;
  actorUserId: string;
  /** Set only for a group transfer (§M); NULL for a single action. */
  groupId?: string | null;
  reasonCode: AssignmentTransitionReason;
  /** Persisted only when reasonCode = OTHER. */
  reasonText?: string | null;
}

/** The legacy free-text `reason` field on /end and /change maps to reasonCode=OTHER + reasonText.
 *  Deploy B replaces the worker-card UI with explicit reason presets. */
export function reasonFromFreeText(text: string | null | undefined): {
  reasonCode: AssignmentTransitionReason;
  reasonText: string | null;
} {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  return { reasonCode: 'OTHER', reasonText: trimmed.length > 0 ? trimmed : null };
}

export async function recordAssignmentTransition(
  tx: Prisma.TransactionClient,
  input: RecordAssignmentTransitionInput
): Promise<{ id: string }> {
  return tx.assignmentTransition.create({
    data: {
      employeeId: input.employeeId,
      kind: input.kind,
      fromAssignmentId: input.fromAssignmentId ?? null,
      toAssignmentId: input.toAssignmentId ?? null,
      actedAt: input.actedAt,
      effectiveFrom: input.effectiveFrom,
      openShiftHandling: input.openShiftHandling ?? null,
      actorUserId: input.actorUserId,
      groupId: input.groupId ?? null,
      reasonCode: input.reasonCode,
      reasonText: input.reasonCode === 'OTHER' ? (input.reasonText ?? null) : null
    },
    select: { id: true }
  });
}
