-- Titanor Time — T15.3: Worker Notification Center.
--
-- Same shape as AdminNotification (2026-08-24) / the TIMESHEET_AWAITING_APPROVAL addition
-- (2026-08-28), but for the worker's own PWA. First type: TIMESHEET_DEADLINE_APPROACHING — the
-- current OPEN period's timesheet is still a draft and its cutoff is close (or passed). Rows are
-- created + resolved by lib/worker-notifications.ts on every GET /api/worker/notifications
-- ("ensure before every read", same pattern as lib/timesheet-approval-notifications.ts). Dismissal
-- is per User (a shared device with two workers), normalised into WorkerNotificationDismissal.

CREATE TYPE "WorkerNotificationType" AS ENUM ('TIMESHEET_DEADLINE_APPROACHING');
CREATE TYPE "WorkerNotificationSeverity" AS ENUM ('INFO', 'WARNING');

CREATE TABLE "WorkerNotification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "WorkerNotificationType" NOT NULL,
    "severity" "WorkerNotificationSeverity" NOT NULL,
    "employeeId" UUID NOT NULL,
    "payrollPeriodId" UUID,
    "timesheetId" UUID,
    "deadlineAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(6),

    CONSTRAINT "WorkerNotification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkerNotificationDismissal" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "notificationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "dismissedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerNotificationDismissal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkerNotification_employeeId_resolvedAt_createdAt_idx" ON "WorkerNotification"("employeeId", "resolvedAt", "createdAt" DESC);
CREATE INDEX "WorkerNotification_payrollPeriodId_idx" ON "WorkerNotification"("payrollPeriodId");
CREATE INDEX "WorkerNotification_timesheetId_idx" ON "WorkerNotification"("timesheetId");
CREATE UNIQUE INDEX "WorkerNotificationDismissal_notificationId_userId_key" ON "WorkerNotificationDismissal"("notificationId", "userId");
CREATE INDEX "WorkerNotificationDismissal_userId_idx" ON "WorkerNotificationDismissal"("userId");

ALTER TABLE "WorkerNotification" ADD CONSTRAINT "WorkerNotification_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkerNotification" ADD CONSTRAINT "WorkerNotification_payrollPeriodId_fkey" FOREIGN KEY ("payrollPeriodId") REFERENCES "PayrollPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkerNotification" ADD CONSTRAINT "WorkerNotification_timesheetId_fkey" FOREIGN KEY ("timesheetId") REFERENCES "Timesheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkerNotificationDismissal" ADD CONSTRAINT "WorkerNotificationDismissal_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "WorkerNotification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkerNotificationDismissal" ADD CONSTRAINT "WorkerNotificationDismissal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-added (not Prisma-generated), mirroring ux_admin_notification_active_timesheet: at most one
-- active (resolvedAt IS NULL) notification per (employee, period). The generator's create() relies
-- on catching this 23505 as the "already have one" signal. Registered in
-- docs/titanor-time/05_RAW_SQL_REGISTER.md.
CREATE UNIQUE INDEX "ux_worker_notification_active_period"
  ON "WorkerNotification" ("employeeId", "payrollPeriodId")
  WHERE "resolvedAt" IS NULL AND "payrollPeriodId" IS NOT NULL;
