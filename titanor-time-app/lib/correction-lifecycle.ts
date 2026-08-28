// T12 — correction-request lifecycle bits shared by callers that would otherwise create an import
// cycle with lib/corrections.ts (which pulls in lib/worker-timesheets.ts). Zero deps beyond
// Prisma + the audit helper.

import type { Prisma } from '@prisma/client';
import { createAuditEvent } from '@/lib/audit';

/**
 * Auto-close every still-open (PENDING / DRAFT_OPEN) CorrectionRequest for a timesheet. Called
 * when the timesheet moves underneath an open admin edit — a late clock sync reopen, an admin
 * return, or the worker reopening it to keep editing. Such an edit is built against a version that
 * is no longer current; leaving it open shows the admin a stale snapshot (the "missing Friday"
 * bug). The admin starts a fresh edit against the new version if still needed. Runs inside the
 * caller's transaction. Returns the ids it closed.
 */
export async function autoCloseOpenCorrectionsForTimesheet(
  tx: Prisma.TransactionClient,
  timesheetId: string,
  requestId: string,
  actorUserId: string | null,
  reason: 'TIMESHEET_REOPENED' | 'TIMESHEET_RETURNED' | 'WORKER_REOPENED'
): Promise<string[]> {
  const open = await tx.correctionRequest.findMany({
    where: { timesheetId, status: { in: ['PENDING', 'DRAFT_OPEN'] } },
    select: { id: true, status: true }
  });
  for (const cr of open) {
    await tx.correctionRequest.update({
      where: { id: cr.id },
      data: { status: 'REJECTED', decidedByUserId: actorUserId, decidedAt: new Date() }
    });
    await createAuditEvent(tx, {
      actorUserId,
      eventType: 'CORRECTION_AUTO_CLOSED',
      entityType: 'CORRECTION_REQUEST',
      entityId: cr.id,
      requestId,
      beforeValue: { status: cr.status },
      afterValue: { status: 'REJECTED', autoClosed: true, reason }
    });
  }
  return open.map((cr) => cr.id);
}
