import { prisma } from '@/lib/prisma';
import { computeQualificationExpiryStatus, type QualificationExpiryStatus } from '@/lib/qualification-expiry';

// R09.5 — the admin task-center's "documents needing attention" figure. Counts *workers* (not
// individual certificates) whose qualifications need action, reusing lib/qualification-expiry.ts
// for the exact status boundaries. Lean read: no matrix rows, no pagination. Foreman overview is
// untouched — this is only wired into the /admin overview page.

const NEEDS_ACTION: ReadonlySet<QualificationExpiryStatus> = new Set(['EXPIRED', 'CRITICAL', 'MISSING_EXPIRY']);

export interface DocumentAttentionSummary {
  /** active workers with >= 1 qualification EXPIRED / CRITICAL / MISSING required expiry date */
  workersNeedingAttention: number;
  /** active workers whose worst qualification is EXPIRING_SOON (and none is worse) */
  workersExpiringSoon: number;
}

/** True for an Employment that is active AND whose [startDate, endDate] window covers `today`.
 *  Same rule as lib/qualification-matrix.ts's isActiveEmployee. */
function isActiveEmployee(
  employments: { active: boolean; startDate: Date; endDate: Date | null }[],
  today: Date
): boolean {
  return employments.some((e) => e.active && e.startDate <= today && (e.endDate === null || e.endDate >= today));
}

export async function getDocumentAttentionSummary(today: Date): Promise<DocumentAttentionSummary> {
  const rows = await prisma.employeeQualification.findMany({
    where: { employee: { employments: { some: { active: true } } } },
    select: {
      employeeId: true,
      expiresOn: true,
      definition: { select: { expiryMode: true } },
      employee: { select: { employments: { select: { active: true, startDate: true, endDate: true } } } }
    }
  });

  const attention = new Set<string>();
  const soon = new Set<string>();

  for (const row of rows) {
    if (!isActiveEmployee(row.employee.employments, today)) continue;
    const expiryMode = row.definition?.expiryMode ?? (row.expiresOn ? 'OPTIONAL' : 'NONE');
    const { status } = computeQualificationExpiryStatus(expiryMode, row.expiresOn, today);
    if (NEEDS_ACTION.has(status)) attention.add(row.employeeId);
    else if (status === 'EXPIRING_SOON') soon.add(row.employeeId);
  }
  // A worker who is already in "needs attention" is not also counted as "expiring soon".
  for (const id of attention) soon.delete(id);

  return { workersNeedingAttention: attention.size, workersExpiringSoon: soon.size };
}
