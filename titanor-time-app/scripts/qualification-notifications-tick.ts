// Optional CLI entry point for a future scheduler (task spec §26) — the admin notification
// center UI never depends on this running; it calls the same ensure* passes itself on every read.
// This script exists only so a cron/scheduler can be wired up later without any code changes,
// mirroring scripts/attendance-auto-submit-tick.ts's shape.
import { prisma } from '../lib/prisma';
import { ensureQualificationNotifications } from '../lib/qualification-notifications';
import { ensureTimesheetApprovalNotifications } from '../lib/timesheet-approval-notifications';

async function main(): Promise<void> {
  await ensureQualificationNotifications();
  await ensureTimesheetApprovalNotifications();
  console.log('qualification-notifications-tick: done');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
