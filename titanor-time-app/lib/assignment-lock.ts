import type { Prisma } from '@prisma/client';

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §2.4 / §3.13 — ONE per-employee advisory
// lock key shared by every writer of a worker's assignments (removeFromSite / changeWorkplace /
// promoteToPrimary in lib/assignment-lifecycle-service.ts, createAssignment in lib/assignments.ts,
// the Deploy-D manual double-primary fix). Two admins acting on the same worker serialise on it,
// which — together with SiteAssignment.version and the ux_site_assignment_one_live_primary index —
// keeps "≤1 operationally-live primary" true under concurrency.
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

/** Where-fragment for the ux_site_assignment_one_live_primary partial-unique-index predicate
 *  EXACTLY (primary AND clockInDisabledAt IS NULL). Use only for asserting/checking the index
 *  constraint itself — NOT for the demote query (see livePrimaryDemoteWhere). */
export const LIVE_PRIMARY_INDEX_PREDICATE = { isPrimary: true, clockInDisabledAt: null } as const;

/** Where-fragment for "this row is a primary that is STILL operationally live" — i.e. primary AND
 *  (clockInDisabledAt IS NULL OR clockInDisabledAt > now). Broader than the index predicate: it
 *  also catches a primary whose removal/transfer is scheduled for a FUTURE instant (clockInDisabledAt
 *  set but not yet passed), which is still check-in-able right now. The demote-before-new-primary
 *  step uses THIS so that after any primary change there is ≤1 primary among genuinely-live rows,
 *  not just ≤1 in the index predicate. */
export function livePrimaryDemoteWhere(now: Date = new Date()) {
  return { isPrimary: true as const, OR: [{ clockInDisabledAt: null }, { clockInDisabledAt: { gt: now } }] };
}

/** SiteAssignment_employeeId's ux_site_assignment_one_live_primary — SQLSTATE 23505, but Prisma's
 *  P2002 message carries only a generic hint, so match the index name in the raw message text. */
export function isLivePrimaryConflict(error: unknown): boolean {
  const e = error as { code?: string; message?: string; meta?: { target?: unknown } };
  const msg = typeof e?.message === 'string' ? e.message : '';
  const target = e?.meta?.target;
  return (
    (e?.code === 'P2002' || msg.includes('23505')) &&
    (msg.includes('ux_site_assignment_one_live_primary') ||
      (Array.isArray(target) ? target.includes('ux_site_assignment_one_live_primary') : target === 'ux_site_assignment_one_live_primary'))
  );
}
