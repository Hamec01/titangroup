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

// ---------------------------------------------------------------------------------------------
// T10-D — automatic unpaid lunch (docs/titanor-time/T10_DEF_PLAN.md §D)
// ---------------------------------------------------------------------------------------------

// Finnish 6 h norm — the default for the "long enough to have taken a lunch" threshold, kept in
// sync with CompanyAttendancePolicy.autoUnpaidBreakThresholdMinutes's column default. Callers that
// have the policy loaded should pass the real value.
export const DEFAULT_AUTO_UNPAID_BREAK_THRESHOLD_MINUTES = 360;

export interface DayAutoBreakConfig {
  /** The day's PLANNED break in minutes, counting ONLY the unpaid part — the caller passes 0 when
   *  the planned break is marked paid (plannedBreakPaid) or there is no plan for that day. */
  plannedUnpaidBreakMinutes: number;
  /** Auto-deduct only when the day's GROSS duration is at least this many minutes. 0 = always. */
  grossThresholdMinutes: number;
}

export interface WorkedDayMs extends WorkedTimeMs {
  /** The part of unpaidBreakMs that was auto-added because no break was logged on a long-enough
   *  day. 0 when a break was logged, the day is under threshold, or there is no unpaid planned
   *  break. Purely informational — already included in unpaidBreakMs / subtracted from workedMs. */
  autoUnpaidBreakMs: number;
}

const ZERO_DAY_MS: WorkedDayMs = { ...ZERO_MS, autoUnpaidBreakMs: 0 };

/**
 * DAY-level worked time. Sums the day's segments exactly like computeSegmentMs/sumWorkedTimeMs, then
 * — if the worker logged NO break at all (paid or unpaid), the day's gross is at least the
 * threshold, and the plan carries an unpaid break — deducts that planned break once as an
 * "auto unpaid break". Never deducts more than the gross. If the worker logged their own break,
 * that is used as-is and nothing is auto-added (no double deduction, §D).
 */
export function computeDayWorkedMs(segments: WorkedTimeSegmentInput[], config: DayAutoBreakConfig): WorkedDayMs {
  const base = sumWorkedTimeMs(segments.map((s) => computeSegmentMs(s)));
  const hasLoggedBreak = segments.some((s) => s.breaks.length > 0);
  const plannedUnpaidBreakMs = Math.max(0, Math.round(config.plannedUnpaidBreakMinutes)) * 60_000;
  const grossThresholdMs = Math.max(0, Math.round(config.grossThresholdMinutes)) * 60_000;

  const eligible = !hasLoggedBreak && plannedUnpaidBreakMs > 0 && base.grossMs >= grossThresholdMs;
  const autoUnpaidBreakMs = eligible ? Math.min(plannedUnpaidBreakMs, base.grossMs) : 0;

  return {
    grossMs: base.grossMs,
    paidBreakMs: base.paidBreakMs,
    unpaidBreakMs: base.unpaidBreakMs + autoUnpaidBreakMs,
    workedMs: base.grossMs - base.unpaidBreakMs - autoUnpaidBreakMs,
    autoUnpaidBreakMs
  };
}

export function sumWorkedDayMs(items: WorkedDayMs[]): WorkedDayMs {
  return items.reduce(
    (acc, x) => ({
      grossMs: acc.grossMs + x.grossMs,
      paidBreakMs: acc.paidBreakMs + x.paidBreakMs,
      unpaidBreakMs: acc.unpaidBreakMs + x.unpaidBreakMs,
      workedMs: acc.workedMs + x.workedMs,
      autoUnpaidBreakMs: acc.autoUnpaidBreakMs + x.autoUnpaidBreakMs
    }),
    ZERO_DAY_MS
  );
}
