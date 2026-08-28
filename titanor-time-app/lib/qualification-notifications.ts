import { Prisma } from '@prisma/client';
import type { AdminNotificationType, AdminNotificationSeverity } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { helsinkiCalendarDateAsUtcMidnight } from '@/lib/attendance-clock';
import { computeQualificationExpiryStatus, type QualificationExpiryStatus } from '@/lib/qualification-expiry';
import { ensureTimesheetApprovalNotifications } from '@/lib/timesheet-approval-notifications';

// Admin Notification Center — generation service (task spec §22-26). Called before every read
// of the notification center (badge/drawer), never on a schedule of its own in this slice — see
// scripts/qualification-notifications-tick.ts for the optional future-cron entry point that
// calls the exact same function.
//
// Dedup: one active (resolvedAt IS NULL) AdminNotification per
// (employeeQualificationId, type, threshold) — enforced by a partial unique index added by raw
// SQL in prisma/migrations/20260824220000_add_qualification_catalog_and_admin_notifications
// (Prisma's schema DSL can't express a WHERE clause on an index). This function only ever
// creates a row when none matching already exists, and resolves any active row that no longer
// matches the qualification's current status — that resolve-then-recreate-on-next-breach is
// what lets "expiry extended past a threshold, then breaches it again later" start a fresh
// notification cycle instead of being permanently silenced.

interface DesiredNotification {
  type: AdminNotificationType;
  threshold: number | null;
  severity: AdminNotificationSeverity;
}

// Worker Dossier feature (2026-08-26, task spec §23-26): a fourth checkpoint at 7 days, between
// the pre-existing 14-day CRITICAL and the expiry itself. Deliberately does NOT change
// qualification-expiry.ts's status/color (days 0-14 stay one CRITICAL/ORANGE-or-RED UI bucket —
// "Expires today" vs "Critical" is still the only visible distinction, unchanged) — only the
// notification threshold splits 8-14 vs 0-7 using the daysUntilExpiry the status computation
// already returns. Day 0 ("expires today") is intentionally grouped into the more urgent
// 7-day bucket, not the 0/expired one: it hasn't actually expired yet, and QUALIFICATION_EXPIRED
// text ("expired N days ago") would misdescribe it.
function desiredNotificationFor(status: QualificationExpiryStatus, daysUntilExpiry: number | null): DesiredNotification | null {
  switch (status) {
    case 'EXPIRING_SOON':
      return { type: 'QUALIFICATION_EXPIRING_SOON', threshold: 60, severity: 'WARNING' };
    case 'CRITICAL': {
      const threshold = daysUntilExpiry !== null && daysUntilExpiry <= 7 ? 7 : 14;
      return { type: 'QUALIFICATION_CRITICAL', threshold, severity: 'CRITICAL' };
    }
    case 'EXPIRED':
      return { type: 'QUALIFICATION_EXPIRED', threshold: 0, severity: 'CRITICAL' };
    case 'MISSING_EXPIRY':
      return { type: 'QUALIFICATION_MISSING_EXPIRY', threshold: null, severity: 'CRITICAL' };
    case 'VALID':
      return null;
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('23505') || message.includes('ux_admin_notification_active_dedup');
}

/** Idempotent, transaction-safe. Cheap: one bounded pass over EmployeeQualification rows. Call
 * this before reading the notification center — never on every unrelated request. */
export async function ensureQualificationNotifications(): Promise<void> {
  const today = helsinkiCalendarDateAsUtcMidnight(new Date());

  await prisma.$transaction(async (tx) => {
    const qualifications = await tx.employeeQualification.findMany({
      select: { id: true, employeeId: true, expiresOn: true, definition: { select: { expiryMode: true } } }
    });

    const activeNotifications = await tx.adminNotification.findMany({
      where: {
        resolvedAt: null,
        type: { in: ['QUALIFICATION_EXPIRING_SOON', 'QUALIFICATION_CRITICAL', 'QUALIFICATION_EXPIRED', 'QUALIFICATION_MISSING_EXPIRY'] },
        employeeQualificationId: { not: null }
      },
      select: { id: true, employeeQualificationId: true, type: true, threshold: true }
    });

    const activeByQualification = new Map<string, typeof activeNotifications>();
    for (const notification of activeNotifications) {
      const key = notification.employeeQualificationId as string;
      const bucket = activeByQualification.get(key);
      if (bucket) {
        bucket.push(notification);
      } else {
        activeByQualification.set(key, [notification]);
      }
    }

    const idsToResolve: string[] = [];
    const rowsToCreate: { type: AdminNotificationType; severity: AdminNotificationSeverity; employeeId: string; employeeQualificationId: string; threshold: number | null }[] = [];

    for (const qualification of qualifications) {
      const expiryMode = qualification.definition?.expiryMode ?? (qualification.expiresOn ? 'OPTIONAL' : 'NONE');
      const { status, daysUntilExpiry } = computeQualificationExpiryStatus(expiryMode, qualification.expiresOn, today);
      const desired = desiredNotificationFor(status, daysUntilExpiry);
      const existingForQualification = activeByQualification.get(qualification.id) ?? [];

      for (const existing of existingForQualification) {
        const stillMatches = desired !== null && existing.type === desired.type && existing.threshold === desired.threshold;
        if (!stillMatches) {
          idsToResolve.push(existing.id);
        }
      }

      if (desired) {
        const alreadyActive = existingForQualification.some((n) => n.type === desired.type && n.threshold === desired.threshold);
        if (!alreadyActive) {
          rowsToCreate.push({
            type: desired.type,
            severity: desired.severity,
            employeeId: qualification.employeeId,
            employeeQualificationId: qualification.id,
            threshold: desired.threshold
          });
        }
      }
    }

    if (idsToResolve.length > 0) {
      await tx.adminNotification.updateMany({ where: { id: { in: idsToResolve } }, data: { resolvedAt: new Date() } });
    }

    for (const row of rowsToCreate) {
      try {
        await tx.adminNotification.create({ data: row });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
  });
}

export interface AdminNotificationView {
  id: string;
  type: AdminNotificationType;
  severity: AdminNotificationSeverity;
  employeeId: string | null;
  employeeName: string | null;
  employeeNumber: string | null;
  qualificationName: string | null;
  qualificationNameRu: string | null;
  expiresOn: string | null;
  threshold: number | null;
  createdAt: string;
  // T12 §1a — set for TIMESHEET_AWAITING_APPROVAL: link target + the week it covers.
  timesheetId: string | null;
  periodStartDate: string | null;
  periodEndDate: string | null;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Active notifications not yet dismissed by this admin. Runs the two "ensure" passes first so the
 * list is always current — see module docblock. */
export async function listActiveNotificationsForAdmin(userId: string): Promise<AdminNotificationView[]> {
  await ensureQualificationNotifications();
  await ensureTimesheetApprovalNotifications();

  const rows = await prisma.adminNotification.findMany({
    where: { resolvedAt: null, dismissals: { none: { userId } } },
    orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      type: true,
      severity: true,
      threshold: true,
      createdAt: true,
      employeeId: true,
      timesheetId: true,
      employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
      employeeQualification: { select: { name: true, expiresOn: true, definition: { select: { nameRu: true } } } },
      timesheet: { select: { period: { select: { startDate: true, endDate: true } } } }
    }
  });

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    severity: row.severity,
    employeeId: row.employeeId,
    employeeName: row.employee ? `${row.employee.firstName} ${row.employee.lastName}` : null,
    employeeNumber: row.employee?.employeeNumber ?? null,
    qualificationName: row.employeeQualification?.name ?? null,
    qualificationNameRu: row.employeeQualification?.definition?.nameRu ?? null,
    expiresOn: row.employeeQualification?.expiresOn ? formatDate(row.employeeQualification.expiresOn) : null,
    threshold: row.threshold,
    createdAt: row.createdAt.toISOString(),
    timesheetId: row.timesheetId,
    periodStartDate: row.timesheet?.period.startDate ? formatDate(row.timesheet.period.startDate) : null,
    periodEndDate: row.timesheet?.period.endDate ? formatDate(row.timesheet.period.endDate) : null
  }));
}

export type DismissNotificationResult = { ok: true } | { ok: false; code: 'NOT_FOUND' };

/** Per-admin dismissal only — never mutates AdminNotification.resolvedAt (that's the system-
 * level "condition cleared" state, see ensureQualificationNotifications). `userId` must always
 * come from the session, never from request input (task spec §31). */
export async function dismissAdminNotification(notificationId: string, userId: string): Promise<DismissNotificationResult> {
  const notification = await prisma.adminNotification.findUnique({ where: { id: notificationId }, select: { id: true } });
  if (!notification) {
    return { ok: false, code: 'NOT_FOUND' };
  }
  await prisma.adminNotificationDismissal.upsert({
    where: { notificationId_userId: { notificationId, userId } },
    create: { notificationId, userId },
    update: {}
  });
  return { ok: true };
}
