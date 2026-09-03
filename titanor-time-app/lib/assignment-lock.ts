import type { Prisma } from '@prisma/client';

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §2.4 / §3.13 — ONE per-employee advisory
// lock key shared by every writer of a worker's assignments (removeFromSite / changeWorkplace /
// promoteToPrimary in lib/assignment-lifecycle-service.ts, createAssignment in lib/assignments.ts,
// the Deploy-D manual double-primary fix). Two admins acting on the same worker serialise on it,
// which — together with SiteAssignment.version and the ex_site_assignment_one_primary_per_period
// EXCLUDE constraint — keeps "≤1 primary per overlapping period" true under concurrency.
//
// Standalone (zero imports beyond the Prisma type) so both lib/assignments.ts and
// lib/assignment-lifecycle-service.ts can use it without an import cycle.

export function assignmentLifecycleLockKey(employeeId: string): string {
  return `titanor_time:assignment_lifecycle:${employeeId}`;
}

/** Prisma's tagged template parameterises the interpolated id — this is not string-built SQL. */
export async function acquireEmployeeLifecycleLock(tx: Prisma.TransactionClient, employeeId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${assignmentLifecycleLockKey(employeeId)})::bigint)`;
}

export interface AssignmentPeriod {
  validFrom: Date;
  /** null = open-ended. */
  validTo: Date | null;
}

/**
 * Where-fragment for "another NON-REMOVED primary of this employee whose date range OVERLAPS
 * `period`". This is the ex_site_assignment_one_primary_per_period predicate expressed as plain
 * interval comparisons (Prisma has no daterange operator):
 *   isPrimary AND clockInDisabledAt IS NULL
 *   AND thisRow.validFrom <= period.validTo   (period open-ended -> no upper bound)
 *   AND (thisRow.validTo IS NULL OR thisRow.validTo >= period.validFrom)
 * A current primary and a scheduled FUTURE primary with disjoint periods do NOT match — both stay
 * primary; the EXCLUDE constraint and this fragment only forbid overlapping primary periods.
 */
export function overlappingPrimaryWhere(period: AssignmentPeriod): Prisma.SiteAssignmentWhereInput {
  return {
    isPrimary: true,
    clockInDisabledAt: null,
    ...(period.validTo ? { validFrom: { lte: period.validTo } } : {}),
    OR: [{ validTo: null }, { validTo: { gte: period.validFrom } }]
  };
}

/**
 * Thrown from createAssignmentInTx / promoteToPrimary when making an assignment primary would
 * OVERLAP a SCHEDULED FUTURE primary (validFrom > today) and the caller did not pass an explicit
 * resolution. The route turns it into 409 SCHEDULED_PRIMARY_CONFLICT so the admin chooses
 * "keep the scheduled transfer" or "replace it" — never a silent cancel (§P4).
 */
export class ScheduledPrimaryConflictError extends Error {
  constructor(
    public scheduledAssignmentId: string,
    public scheduledValidFrom: Date
  ) {
    super('SCHEDULED_PRIMARY_CONFLICT');
    this.name = 'ScheduledPrimaryConflictError';
  }
}

/**
 * R15-D7 Deploy C (§3.13 L) — thrown from createAssignmentInTx when the target site is finished
 * (`finishedAt` set / `active=false`) or the target customer is disabled (`active=false`). The
 * route maps it to 409 SITE_FINISHED / CUSTOMER_DISABLED. Enforced in the tx, not only the picker.
 */
export class SiteOrCustomerUnavailableError extends Error {
  constructor(public code: 'SITE_FINISHED' | 'CUSTOMER_DISABLED') {
    super(code);
    this.name = 'SiteOrCustomerUnavailableError';
  }
}

/** ex_site_assignment_one_primary_per_period is a Postgres EXCLUDE constraint (SQLSTATE 23P01);
 *  Prisma has no typed code for it — match SQLSTATE + the constraint name in the raw message. */
export function isPrimaryPeriodConflict(error: unknown): boolean {
  const e = error as { code?: string; message?: string; meta?: { constraint?: unknown } };
  const msg = typeof e?.message === 'string' ? e.message : '';
  return (
    (msg.includes('23P01') || e?.code === 'P2002' || e?.meta?.constraint === 'ex_site_assignment_one_primary_per_period') &&
    msg.includes('ex_site_assignment_one_primary_per_period')
  );
}
