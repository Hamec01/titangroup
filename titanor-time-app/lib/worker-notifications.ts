import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { computeTimesheetEditCutoff } from '@/lib/timesheet-edit-window';

// T15.3 — the Worker Notification Center. Same "ensure before every read" pattern as
// lib/timesheet-approval-notifications.ts: GET /api/worker/notifications first calls
// syncWorkerDeadlineNotifications (idempotent), then listWorkerNotifications. No scheduler
// dependency — a notice appears the next time the worker's bell polls.
//
// First (only) type: TIMESHEET_DEADLINE_APPROACHING — the current OPEN period's timesheet is still
// a draft (DRAFT / RETURNED) and its cutoff is within WORKER_DEADLINE_NOTICE_DAYS or already past.
// `deadlineAt` is the cutoff instant; the client renders a live "N days left" / "overdue". Missing
// the cutoff is not catastrophic (attendance-auto-submit submits it as-is) — the notice says so.

export const WORKER_DEADLINE_NOTICE_DAYS = 3;
const DAY_MS = 86_400_000;

async function loadCutoffPolicy(): Promise<{ cutoffDaysAfterPeriodEnd: number; cutoffTime: Date }> {
  const p = await prisma.companyAttendancePolicy.findFirst({ select: { cutoffDaysAfterPeriodEnd: true, cutoffTime: true } });
  return { cutoffDaysAfterPeriodEnd: p?.cutoffDaysAfterPeriodEnd ?? 1, cutoffTime: p?.cutoffTime ?? new Date('1970-01-01T23:59:00.000Z') };
}

/** Idempotent. Creates one active TIMESHEET_DEADLINE_APPROACHING row per (employee, OPEN period
 *  with a still-draft timesheet whose cutoff is close/passed); resolves rows that no longer apply
 *  (submitted, period closed, cutoff pushed out); when a notice escalates INFO -> WARNING (the
 *  cutoff passed) its dismissals are cleared so it resurfaces once. */
export async function syncWorkerDeadlineNotifications(employeeId: string, now: Date = new Date()): Promise<void> {
  const policy = await loadCutoffPolicy();

  const timesheets = await prisma.timesheet.findMany({
    where: { employeeId, status: { in: ['DRAFT', 'RETURNED'] }, period: { status: 'OPEN' } },
    select: { id: true, periodId: true, period: { select: { endDate: true } } }
  });

  const want = new Map<string, { timesheetId: string; deadlineAt: Date; severity: 'INFO' | 'WARNING' }>();
  for (const ts of timesheets) {
    const deadlineAt = computeTimesheetEditCutoff(ts.period.endDate, policy);
    if ((deadlineAt.getTime() - now.getTime()) / DAY_MS <= WORKER_DEADLINE_NOTICE_DAYS) {
      want.set(ts.periodId, { timesheetId: ts.id, deadlineAt, severity: deadlineAt.getTime() < now.getTime() ? 'WARNING' : 'INFO' });
    }
  }

  const active = await prisma.workerNotification.findMany({
    where: { employeeId, type: 'TIMESHEET_DEADLINE_APPROACHING', resolvedAt: null },
    select: { id: true, payrollPeriodId: true, deadlineAt: true, severity: true }
  });

  const staleIds = active.filter((n) => !n.payrollPeriodId || !want.has(n.payrollPeriodId)).map((n) => n.id);
  if (staleIds.length > 0) {
    await prisma.workerNotification.updateMany({ where: { id: { in: staleIds } }, data: { resolvedAt: now } });
  }

  for (const [periodId, w] of want) {
    const existing = active.find((n) => n.payrollPeriodId === periodId && !staleIds.includes(n.id));
    if (existing) {
      const escalating = existing.severity === 'INFO' && w.severity === 'WARNING';
      const changed = escalating || existing.severity !== w.severity || existing.deadlineAt?.getTime() !== w.deadlineAt.getTime();
      if (changed) {
        await prisma.$transaction(async (tx) => {
          await tx.workerNotification.update({ where: { id: existing.id }, data: { severity: w.severity, deadlineAt: w.deadlineAt, timesheetId: w.timesheetId } });
          if (escalating) {
            await tx.workerNotificationDismissal.deleteMany({ where: { notificationId: existing.id } });
          }
        });
      }
      continue;
    }
    try {
      await prisma.workerNotification.create({
        data: { type: 'TIMESHEET_DEADLINE_APPROACHING', severity: w.severity, employeeId, payrollPeriodId: periodId, timesheetId: w.timesheetId, deadlineAt: w.deadlineAt }
      });
    } catch (error) {
      // ux_worker_notification_active_period — a concurrent create won the race; nothing to do.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
    }
  }
}

export interface WorkerNotificationView {
  id: string;
  type: 'TIMESHEET_DEADLINE_APPROACHING';
  severity: 'INFO' | 'WARNING';
  deadlineAt: string | null;
  periodStartDate: string | null;
  periodEndDate: string | null;
  createdAt: string;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Active (unresolved) notifications for this employee that THIS user has not dismissed. */
export async function listWorkerNotifications(employeeId: string, userId: string): Promise<WorkerNotificationView[]> {
  const rows = await prisma.workerNotification.findMany({
    where: { employeeId, resolvedAt: null, dismissals: { none: { userId } } },
    orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      type: true,
      severity: true,
      deadlineAt: true,
      createdAt: true,
      payrollPeriod: { select: { startDate: true, endDate: true } }
    }
  });
  return rows.map((r) => ({
    id: r.id,
    type: r.type as 'TIMESHEET_DEADLINE_APPROACHING',
    severity: r.severity as 'INFO' | 'WARNING',
    deadlineAt: r.deadlineAt ? r.deadlineAt.toISOString() : null,
    periodStartDate: r.payrollPeriod ? formatDate(r.payrollPeriod.startDate) : null,
    periodEndDate: r.payrollPeriod ? formatDate(r.payrollPeriod.endDate) : null,
    createdAt: r.createdAt.toISOString()
  }));
}

/** Records a per-user dismissal. Idempotent. `false` when the notification does not belong to this
 *  employee (a guessed id) or does not exist. */
export async function dismissWorkerNotification(notificationId: string, employeeId: string, userId: string): Promise<boolean> {
  const notification = await prisma.workerNotification.findUnique({ where: { id: notificationId }, select: { employeeId: true } });
  if (!notification || notification.employeeId !== employeeId) {
    return false;
  }
  await prisma.workerNotificationDismissal.upsert({
    where: { notificationId_userId: { notificationId, userId } },
    create: { notificationId, userId },
    update: {}
  });
  return true;
}
