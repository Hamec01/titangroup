import { computeDayWorkedMs, msToMinutes, DEFAULT_AUTO_UNPAID_BREAK_THRESHOLD_MINUTES, type WorkedTimeBreakInput } from './worked-time';

export { DEFAULT_AUTO_UNPAID_BREAK_THRESHOLD_MINUTES };

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4B" §BD — the single reusable
// (employeeId, siteId, date) grouping + rounding step shared by T8.3 (lib/period-time-report.ts)
// and CSV_V1 (lib/csv-export.ts), so the group-by-Map mechanics that were previously copied inline
// stop drifting relative to each other. Zero Prisma/HTTP/UI dependencies — callers already resolved
// which segments (draft or version) belong to which employee/site/date.

export interface CanonicalDailyBucketSegmentInput {
  employeeId: string;
  /** null for draft-sourced segments (no TimesheetVersion exists yet) — CSV_V1 always has a real value (§BA: FULL/CORRECTION only ever read FINAL_APPROVED/CURRENT_VERSION). */
  timesheetVersionId: string | null;
  siteId: string;
  date: Date;
  startAt: Date;
  endAt: Date;
  breaks: WorkedTimeBreakInput[];
  /** T10-D — the planned UNPAID break for this (employee, site, date), in minutes. 0 (the default)
   *  when the plan marks the break paid or there is no plan. Redundant across a bucket's segments —
   *  the builder takes the max within the bucket. */
  plannedUnpaidBreakMinutes?: number;
}

export interface CanonicalDailyBucket {
  employeeId: string;
  timesheetVersionId: string | null;
  siteId: string;
  /** YYYY-MM-DD */
  date: string;
  grossMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  workedMinutes: number;
  /** T10-D — the part of unpaidBreakMinutes that was auto-deducted (no break logged, day long
   *  enough, plan carries an unpaid break). 0 otherwise. Already inside unpaidBreakMinutes. */
  autoUnpaidBreakMinutes: number;
  segmentCount: number;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Groups segments by (employeeId, siteId, date), computes DAY-level worked time within each bucket
 * via computeDayWorkedMs() (lib/reporting/worked-time.ts — no formula copy) — including the T10-D
 * automatic unpaid-lunch deduction — and rounds to minutes exactly once per bucket via
 * msToMinutes(). Callers must never re-round a sum of these already-rounded bucket numbers at a
 * higher grouping level (T8_REPORTS_DESIGN.md §2 п.2-3).
 *
 * `grossThresholdMinutes` is CompanyAttendancePolicy.autoUnpaidBreakThresholdMinutes — a caller
 * that has the policy loaded should pass it; the default matches the column default.
 */
export function buildCanonicalDailyBuckets(
  segments: CanonicalDailyBucketSegmentInput[],
  opts: { grossThresholdMinutes?: number } = {}
): CanonicalDailyBucket[] {
  const grossThresholdMinutes = opts.grossThresholdMinutes ?? DEFAULT_AUTO_UNPAID_BREAK_THRESHOLD_MINUTES;
  const bucketMap = new Map<
    string,
    { employeeId: string; timesheetVersionId: string | null; siteId: string; date: string; segments: CanonicalDailyBucketSegmentInput[] }
  >();

  for (const seg of segments) {
    const dateKey = formatDate(seg.date);
    const key = `${seg.employeeId}:${seg.siteId}:${dateKey}`;
    const bucket = bucketMap.get(key);
    if (bucket) {
      bucket.segments.push(seg);
    } else {
      bucketMap.set(key, { employeeId: seg.employeeId, timesheetVersionId: seg.timesheetVersionId, siteId: seg.siteId, date: dateKey, segments: [seg] });
    }
  }

  const buckets: CanonicalDailyBucket[] = [];
  for (const bucket of bucketMap.values()) {
    const plannedUnpaidBreakMinutes = bucket.segments.reduce((max, s) => Math.max(max, s.plannedUnpaidBreakMinutes ?? 0), 0);
    const ms = computeDayWorkedMs(bucket.segments, { plannedUnpaidBreakMinutes, grossThresholdMinutes });
    buckets.push({
      employeeId: bucket.employeeId,
      timesheetVersionId: bucket.timesheetVersionId,
      siteId: bucket.siteId,
      date: bucket.date,
      grossMinutes: msToMinutes(ms.grossMs),
      paidBreakMinutes: msToMinutes(ms.paidBreakMs),
      unpaidBreakMinutes: msToMinutes(ms.unpaidBreakMs),
      workedMinutes: msToMinutes(ms.workedMs),
      autoUnpaidBreakMinutes: msToMinutes(ms.autoUnpaidBreakMs),
      segmentCount: bucket.segments.length
    });
  }
  return buckets;
}
