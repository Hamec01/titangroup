-- Titanor Time — T12 §1a: "нужно утвердить" notifications, one per pending timesheet
-- (docs/titanor-time/T12_ADMIN_TOOLS_DESIGN.md §1a).
--
-- The Admin Notification Center gains a TIMESHEET_AWAITING_APPROVAL type: one active row per
-- SUBMITTED / FOREMAN_APPROVED timesheet whose PayrollPeriod is still OPEN, created + resolved by
-- lib/timesheet-approval-notifications.ts (same "ensure before every read" pattern as the
-- qualification notifications). Additive: the new column is nullable, the enum label is unused
-- until the generator runs.

ALTER TYPE "AdminNotificationType" ADD VALUE IF NOT EXISTS 'TIMESHEET_AWAITING_APPROVAL';

ALTER TABLE "AdminNotification" ADD COLUMN "timesheetId" UUID;

-- AddForeignKey
ALTER TABLE "AdminNotification"
  ADD CONSTRAINT "AdminNotification_timesheetId_fkey"
  FOREIGN KEY ("timesheetId") REFERENCES "Timesheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "AdminNotification_timesheetId_idx" ON "AdminNotification"("timesheetId");

-- Hand-added (not Prisma-generated): active-notification dedup guard, mirroring
-- ux_admin_notification_active_dedup. At most one active (resolvedAt IS NULL) row per timesheet —
-- the generator's create() relies on catching this as the "already have one" signal.
-- Registered in docs/titanor-time/05_RAW_SQL_REGISTER.md.
CREATE UNIQUE INDEX "ux_admin_notification_active_timesheet"
  ON "AdminNotification" ("timesheetId")
  WHERE "resolvedAt" IS NULL AND "timesheetId" IS NOT NULL;
