import { computeSegmentMs, sumWorkedTimeMs, msToMinutes, type WorkedTimeBreakInput } from './worked-time';

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
  segmentCount: number;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Groups segments by (employeeId, siteId, date), sums milliseconds within each bucket via
 * computeSegmentMs()/sumWorkedTimeMs() (lib/reporting/worked-time.ts — no formula copy), and rounds
 * to minutes exactly once per bucket via msToMinutes(). Callers must never re-round a sum of these
 * already-rounded bucket numbers at a higher grouping level (T8_REPORTS_DESIGN.md §2 п.2-3).
 */
export function buildCanonicalDailyBuckets(segments: CanonicalDailyBucketSegmentInput[]): CanonicalDailyBucket[] {
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
    const ms = sumWorkedTimeMs(bucket.segments.map((s) => computeSegmentMs(s)));
    buckets.push({
      employeeId: bucket.employeeId,
      timesheetVersionId: bucket.timesheetVersionId,
      siteId: bucket.siteId,
      date: bucket.date,
      grossMinutes: msToMinutes(ms.grossMs),
      paidBreakMinutes: msToMinutes(ms.paidBreakMs),
      unpaidBreakMinutes: msToMinutes(ms.unpaidBreakMs),
      workedMinutes: msToMinutes(ms.workedMs),
      segmentCount: bucket.segments.length
    });
  }
  return buckets;
}
