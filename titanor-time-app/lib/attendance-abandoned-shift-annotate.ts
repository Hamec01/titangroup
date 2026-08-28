import type { Prisma } from '@prisma/client';

// Dependency-light half of the abandoned-shift feature (see lib/attendance-abandoned-shift.ts for
// the scheduler pass). Kept separate so the Check Out paths (lib/attendance-clock.ts /
// lib/attendance-sync.ts) can call it without an import cycle back into attendance-clock.

export const AUTO_CLOSE_REASON =
  'Автоматически закрыто: смена оставалась открытой дольше допустимого без ухода. Время окончания — плановое из графика (или расчётное).';

const LATE_CHECKOUT_NOTE = 'real check-out arrived after the shift was auto-closed';

/**
 * A real Check Out that arrives AFTER the scheduler already auto-closed a shift lands as an orphan
 * (CHECKOUT_WITHOUT_OPEN_SHIFT). This stamps the true time onto a still-OPEN
 * SHIFT_AUTO_CLOSED_MAX_DURATION for this employee whose opening event this check-out plausibly
 * belongs to (opened within the last 48 h) so the admin reconciles the provisional (template) end
 * against it. The ClockShift itself is immutable (fn_clock_shift_immutable) — the correction is
 * made on the timesheet, not on the shift.
 */
export async function annotateAutoClosedShiftWithLateCheckOut(
  tx: Prisma.TransactionClient,
  employeeId: string,
  realCheckOutAt: Date,
  realCheckOutClockEventId: string
): Promise<void> {
  const windowStart = new Date(realCheckOutAt.getTime() - 48 * 3_600_000);
  const open = await tx.attendanceException.findFirst({
    where: { type: 'SHIFT_AUTO_CLOSED_MAX_DURATION', employeeId, status: 'OPEN', occurredAt: { gte: windowStart, lte: realCheckOutAt } },
    orderBy: { occurredAt: 'desc' },
    select: { id: true, detail: true }
  });
  if (!open) return;
  const detail = (open.detail && typeof open.detail === 'object' ? (open.detail as Record<string, unknown>) : {}) as Prisma.JsonObject;
  await tx.attendanceException.update({
    where: { id: open.id },
    data: { detail: { ...detail, realCheckOutAt: realCheckOutAt.toISOString(), realCheckOutClockEventId, note: LATE_CHECKOUT_NOTE } }
  });
}
