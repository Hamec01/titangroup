import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/prisma';

// R06-A — a leased single-writer lock for the attendance scheduler. Catches "two scheduler
// containers running at once": each iteration the process acquires-or-renews the lease; if a
// different, still-live holder has it, the process skips that iteration's work (records an overlap
// in its heartbeat) instead of double-running the ticks.

export const SCHEDULER_LEASE_NAME = 'attendance-scheduler';

/** Lease TTL — a lease not renewed within this window is up for grabs. Must comfortably exceed the
 *  scheduler interval (max 3600s) so a slow-but-healthy tick never loses its own lease. */
export const SCHEDULER_LEASE_TTL_MS = 90 * 60 * 1000;

/** A per-process holder id — hostname:pid plus randomness so a restarted process that happens to
 *  reuse a pid does not look like the previous holder. */
export function newHolderId(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
}

export type LeaseResult = 'acquired' | 'renewed' | 'held_by_another';

/**
 * Insert the lease (first ever), renew it (we already hold it), or take it over (previous holder's
 * lease has expired). Returns `held_by_another` when a different, non-expired holder has it.
 */
export async function acquireOrRenewLease(
  holderId: string,
  now: Date = new Date(),
  ttlMs: number = SCHEDULER_LEASE_TTL_MS
): Promise<LeaseResult> {
  const expiryCutoff = new Date(now.getTime() - ttlMs);

  const rows = await prisma.$queryRaw<{ holderId: string; acquiredAt: Date }[]>`
    INSERT INTO "SchedulerLease" ("name", "holderId", "acquiredAt", "renewedAt")
    VALUES (${SCHEDULER_LEASE_NAME}, ${holderId}, ${now}, ${now})
    ON CONFLICT ("name") DO UPDATE
      SET "holderId"   = ${holderId},
          "acquiredAt" = CASE WHEN "SchedulerLease"."holderId" = ${holderId}
                              THEN "SchedulerLease"."acquiredAt" ELSE ${now} END,
          "renewedAt"  = ${now}
      WHERE "SchedulerLease"."holderId" = ${holderId}
         OR "SchedulerLease"."renewedAt" < ${expiryCutoff}
    RETURNING "holderId", "acquiredAt"`;

  if (rows.length === 0 || rows[0].holderId !== holderId) {
    return 'held_by_another';
  }
  return rows[0].acquiredAt.getTime() === now.getTime() ? 'acquired' : 'renewed';
}

/** Release on graceful shutdown so a restart can take over immediately (best effort). */
export async function releaseLease(holderId: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "SchedulerLease" WHERE "name" = ${SCHEDULER_LEASE_NAME} AND "holderId" = ${holderId}`;
}
