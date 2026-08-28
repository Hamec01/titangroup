import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

// T12 §1a — Admin Notification Center: "нужно утвердить" alerts, one per timesheet.
//
// Same shape as lib/qualification-notifications.ts: idempotent, transaction-safe, cheap
// (one bounded pass over the pending-timesheet set), and called immediately before every read of
// the notification center — never on a schedule of its own.
//
// Dedup: at most one active (resolvedAt IS NULL) AdminNotification per timesheetId, enforced by
// the partial unique index ux_admin_notification_active_timesheet (raw SQL in
// prisma/migrations/20260828130000_add_timesheet_approval_notifications). This function only
// creates a row when none exists and resolves any active row whose timesheet has since left the
// awaiting-approval state (approved / returned to the worker / period closed) — so a timesheet
// that is returned and later resubmitted starts a fresh notification.

function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('23505') || message.includes('ux_admin_notification_active_timesheet');
}

/** Idempotent. Call before reading the notification center — never on every unrelated request. */
export async function ensureTimesheetApprovalNotifications(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const awaiting = await tx.timesheet.findMany({
      where: { status: { in: ['SUBMITTED', 'FOREMAN_APPROVED'] }, period: { status: 'OPEN' } },
      select: { id: true, employeeId: true }
    });
    const awaitingIds = new Set(awaiting.map((t) => t.id));

    const active = await tx.adminNotification.findMany({
      where: { resolvedAt: null, type: 'TIMESHEET_AWAITING_APPROVAL' },
      select: { id: true, timesheetId: true }
    });

    // Resolve every active notification whose timesheet is no longer awaiting approval.
    const staleIds = active.filter((n) => !n.timesheetId || !awaitingIds.has(n.timesheetId)).map((n) => n.id);
    if (staleIds.length > 0) {
      await tx.adminNotification.updateMany({ where: { id: { in: staleIds } }, data: { resolvedAt: new Date() } });
    }

    const haveActive = new Set(active.filter((n) => n.timesheetId && !staleIds.includes(n.id)).map((n) => n.timesheetId as string));

    for (const t of awaiting) {
      if (haveActive.has(t.id)) continue;
      try {
        await tx.adminNotification.create({
          data: { type: 'TIMESHEET_AWAITING_APPROVAL', severity: 'WARNING', employeeId: t.employeeId, timesheetId: t.id }
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
  });
}
