// docs/titanor-time/T8_REPORTS_DESIGN.md §2 — the single reusable worked-time formula core. Zero
// Prisma/HTTP/UI dependencies so lib/attendance-overview.ts (existing) and the T8.1 worker time
// report (new) share the exact same arithmetic instead of two copies that could quietly drift.
// T8.2/T8.3/T8.4 must reuse this module rather than reimplementing the formula.

export interface WorkedTimeBreakInput {
  startAt: Date;
  endAt: Date;
  paid: boolean;
}

export interface WorkedTimeSegmentInput {
  startAt: Date;
  endAt: Date;
  breaks: WorkedTimeBreakInput[];
}

export interface WorkedTimeMs {
  grossMs: number;
  paidBreakMs: number;
  unpaidBreakMs: number;
  workedMs: number;
}

const ZERO_MS: WorkedTimeMs = { grossMs: 0, paidBreakMs: 0, unpaidBreakMs: 0, workedMs: 0 };

/**
 * gross = endAt - startAt; paid breaks are counted separately but stay inside workedMs; each
 * unpaid break is subtracted exactly once. All-in-milliseconds — callers round with
 * msToMinutes() at whatever grouping level they need (never here).
 */
export function computeSegmentMs(segment: WorkedTimeSegmentInput): WorkedTimeMs {
  const grossMs = segment.endAt.getTime() - segment.startAt.getTime();
  let paidBreakMs = 0;
  let unpaidBreakMs = 0;
  for (const b of segment.breaks) {
    const breakMs = b.endAt.getTime() - b.startAt.getTime();
    if (b.paid) {
      paidBreakMs += breakMs;
    } else {
      unpaidBreakMs += breakMs;
    }
  }
  return { grossMs, paidBreakMs, unpaidBreakMs, workedMs: grossMs - unpaidBreakMs };
}

export function sumWorkedTimeMs(items: WorkedTimeMs[]): WorkedTimeMs {
  return items.reduce(
    (acc, x) => ({
      grossMs: acc.grossMs + x.grossMs,
      paidBreakMs: acc.paidBreakMs + x.paidBreakMs,
      unpaidBreakMs: acc.unpaidBreakMs + x.unpaidBreakMs,
      workedMs: acc.workedMs + x.workedMs
    }),
    ZERO_MS
  );
}

export function msToMinutes(ms: number): number {
  return Math.round(ms / 60000);
}
