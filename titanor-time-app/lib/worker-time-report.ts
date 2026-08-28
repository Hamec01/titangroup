import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { computeDayWorkedMs, msToMinutes, type WorkedTimeSegmentInput } from '@/lib/reporting/worked-time';
import { loadVersionPlannedUnpaidBreakByDate, loadDraftPlannedUnpaidBreakByDate, loadAutoUnpaidBreakThresholdMinutes } from '@/lib/reporting/auto-break';
import { resolveCanonicalSource } from '@/lib/reporting/canonical-source';

// docs/titanor-time/T8_REPORTS_DESIGN.md — T8.1 Admin Worker Time Report. This module owns the
// canonical-source selection (§1), grouping/rounding rules (§3), and the bounded read transaction
// (§6). The API route (app/api/admin/reports/workers/[employeeId]/route.ts) and the Server
// Component page (app/admin/reports/page.tsx) both call getWorkerTimeReport directly — no HTTP
// self-fetch, one shared implementation.

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface WorkerTimeReportEmployee {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
}

export interface WorkerTimeReportPeriod {
  id: string;
  startDate: string;
  endDate: string;
  status: string;
}

export interface WorkerTimeReportTimesheet {
  id: string;
  status: string;
  dataSource: 'DRAFT' | 'CURRENT_VERSION';
  versionNumber: number | null;
  submissionSource: string | null;
}

export interface WorkerTimeReportSiteBucket {
  siteId: string;
  siteName: string;
  grossMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  workedMinutes: number;
  segmentCount: number;
  workedDayCount: number;
}

export interface WorkerTimeReportTotal {
  grossMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  workedMinutes: number;
  segmentCount: number;
  workedDayCount: number;
  siteCount: number;
}

export interface WorkerTimeReport {
  asOf: string;
  employee: WorkerTimeReportEmployee;
  period: WorkerTimeReportPeriod;
  participant: { expected: boolean } | null;
  timesheet: WorkerTimeReportTimesheet | null;
  sites: WorkerTimeReportSiteBucket[];
  total: WorkerTimeReportTotal;
}

export type WorkerTimeReportOutcome = { code: 'WORKER_NOT_FOUND' } | { code: 'PERIOD_NOT_FOUND' } | { code: 'OK'; report: WorkerTimeReport };

const ZERO_TOTAL: WorkerTimeReportTotal = { grossMinutes: 0, paidBreakMinutes: 0, unpaidBreakMinutes: 0, workedMinutes: 0, segmentCount: 0, workedDayCount: 0, siteCount: 0 };

const REPORT_TX_OPTIONS = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 20_000 } as const;

interface RawSegment extends WorkedTimeSegmentInput {
  siteId: string;
  siteName: string;
  date: Date;
}

interface SiteAccumulator {
  siteName: string;
  grossMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  workedMinutes: number;
  segmentCount: number;
  dates: Set<string>;
}

function groupSegments(
  segments: RawSegment[],
  autoBreak: { plannedUnpaidByDate: Map<string, number>; grossThresholdMinutes: number }
): { sites: WorkerTimeReportSiteBucket[]; total: WorkerTimeReportTotal } {
  if (segments.length === 0) {
    return { sites: [], total: ZERO_TOTAL };
  }

  // docs/titanor-time/T8_REPORTS_DESIGN.md — canonical reporting bucket is (siteId, date), shared
  // with T8.2's own lib/site-time-report.ts::buildDays. Rounding per (siteId) alone (summing every
  // day's ms first) used to disagree with T8.2 on sub-minute segments — e.g. two 31-second days:
  // round(62s) = 1 min here vs round(31s) + round(31s) = 2 min there. Bucketing by date FIRST and
  // rounding once per bucket, THEN summing already-rounded bucket minutes into the site row, makes
  // the two reports reconcile exactly.
  const byBucket = new Map<string, { siteId: string; siteName: string; date: string; segments: RawSegment[] }>();
  for (const seg of segments) {
    const dateKey = formatDate(seg.date);
    const key = `${seg.siteId}:${dateKey}`;
    const bucket = byBucket.get(key);
    if (bucket) {
      bucket.segments.push(seg);
    } else {
      byBucket.set(key, { siteId: seg.siteId, siteName: seg.siteName, date: dateKey, segments: [seg] });
    }
  }

  const bySite = new Map<string, SiteAccumulator>();
  for (const bucket of byBucket.values()) {
    // Round once per (siteId, date) bucket — never per segment, never at the site or total level.
    // T10-D: computeDayWorkedMs applies the automatic unpaid-lunch deduction at this day level.
    const ms = computeDayWorkedMs(bucket.segments, {
      plannedUnpaidBreakMinutes: autoBreak.plannedUnpaidByDate.get(bucket.date) ?? 0,
      grossThresholdMinutes: autoBreak.grossThresholdMinutes
    });
    const dayGrossMinutes = msToMinutes(ms.grossMs);
    const dayPaidBreakMinutes = msToMinutes(ms.paidBreakMs);
    const dayUnpaidBreakMinutes = msToMinutes(ms.unpaidBreakMs);
    const dayWorkedMinutes = msToMinutes(ms.workedMs);

    let acc = bySite.get(bucket.siteId);
    if (!acc) {
      acc = { siteName: bucket.siteName, grossMinutes: 0, paidBreakMinutes: 0, unpaidBreakMinutes: 0, workedMinutes: 0, segmentCount: 0, dates: new Set() };
      bySite.set(bucket.siteId, acc);
    }
    // §3 — site row is the sum of already-rounded daily bucket minutes, never a second ms-level sum.
    acc.grossMinutes += dayGrossMinutes;
    acc.paidBreakMinutes += dayPaidBreakMinutes;
    acc.unpaidBreakMinutes += dayUnpaidBreakMinutes;
    acc.workedMinutes += dayWorkedMinutes;
    acc.segmentCount += bucket.segments.length;
    acc.dates.add(bucket.date);
  }

  const sites: WorkerTimeReportSiteBucket[] = [];
  for (const [siteId, acc] of bySite) {
    sites.push({
      siteId,
      siteName: acc.siteName,
      grossMinutes: acc.grossMinutes,
      paidBreakMinutes: acc.paidBreakMinutes,
      unpaidBreakMinutes: acc.unpaidBreakMinutes,
      workedMinutes: acc.workedMinutes,
      segmentCount: acc.segmentCount,
      workedDayCount: acc.dates.size
    });
  }

  sites.sort((a, b) => (a.siteName === b.siteName ? a.siteId.localeCompare(b.siteId) : a.siteName.localeCompare(b.siteName)));

  // §3 — total.*Minutes / segmentCount are sums of the already-rounded/-counted site rows (never a
  // second independent ms-level rounding), except workedDayCount, which is distinct dates across
  // ALL segments regardless of site (a day worked at two sites must not count twice).
  const total: WorkerTimeReportTotal = sites.reduce(
    (acc, s) => ({
      grossMinutes: acc.grossMinutes + s.grossMinutes,
      paidBreakMinutes: acc.paidBreakMinutes + s.paidBreakMinutes,
      unpaidBreakMinutes: acc.unpaidBreakMinutes + s.unpaidBreakMinutes,
      workedMinutes: acc.workedMinutes + s.workedMinutes,
      segmentCount: acc.segmentCount + s.segmentCount,
      workedDayCount: acc.workedDayCount, // filled in below, not a per-site sum
      siteCount: acc.siteCount + 1
    }),
    ZERO_TOTAL
  );
  total.workedDayCount = new Set(segments.map((s) => formatDate(s.date))).size;

  return { sites, total };
}

export async function getWorkerTimeReport(employeeId: string, periodId: string): Promise<WorkerTimeReportOutcome> {
  return prisma.$transaction(async (tx) => {
    const asOf = new Date();

    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, employeeNumber: true, firstName: true, lastName: true }
    });
    if (!employee) {
      return { code: 'WORKER_NOT_FOUND' as const };
    }

    const period = await tx.payrollPeriod.findUnique({
      where: { id: periodId },
      select: { id: true, startDate: true, endDate: true, status: true }
    });
    if (!period) {
      return { code: 'PERIOD_NOT_FOUND' as const };
    }

    const participant = await tx.payrollPeriodParticipant.findUnique({
      where: { periodId_employeeId: { periodId, employeeId } },
      select: { expected: true }
    });

    const timesheet = await tx.timesheet.findUnique({
      where: { employeeId_periodId: { employeeId, periodId } },
      select: {
        id: true,
        status: true,
        currentVersionId: true,
        draft: { select: { id: true } },
        currentVersion: { select: { versionNumber: true, submissionSource: true } }
      }
    });

    const periodDto: WorkerTimeReportPeriod = { id: period.id, startDate: formatDate(period.startDate), endDate: formatDate(period.endDate), status: period.status };
    const employeeDto: WorkerTimeReportEmployee = { id: employee.id, employeeNumber: employee.employeeNumber, firstName: employee.firstName, lastName: employee.lastName };
    const participantDto = participant ? { expected: participant.expected } : null;

    if (!timesheet) {
      return {
        code: 'OK' as const,
        report: { asOf: asOf.toISOString(), employee: employeeDto, period: periodDto, participant: participantDto, timesheet: null, sites: [], total: ZERO_TOTAL }
      };
    }

    // §1 — the shared canonical-source rule (also used by T8.2/T8.3); throws on an invariant
    // failure (never a partial/zero report) rather than returning here.
    const source = resolveCanonicalSource({ id: timesheet.id, status: timesheet.status, currentVersionId: timesheet.currentVersionId, draft: timesheet.draft, currentVersion: timesheet.currentVersion });

    let rawSegments: RawSegment[];
    if (source.dataSource === 'DRAFT') {
      const segments = await tx.timesheetDraftSegment.findMany({
        where: { draftId: source.draftId! },
        select: { siteId: true, date: true, startAt: true, endAt: true, site: { select: { name: true } }, breaks: { select: { startAt: true, endAt: true, paid: true } } }
      });
      rawSegments = segments.map((s) => ({ siteId: s.siteId, siteName: s.site.name, date: s.date, startAt: s.startAt, endAt: s.endAt, breaks: s.breaks }));
    } else {
      const segments = await tx.workSegment.findMany({
        where: { timesheetVersionId: source.versionId! },
        select: { siteId: true, date: true, startAt: true, endAt: true, site: { select: { name: true } }, breaks: { select: { startAt: true, endAt: true, paid: true } } }
      });
      rawSegments = segments.map((s) => ({ siteId: s.siteId, siteName: s.site.name, date: s.date, startAt: s.startAt, endAt: s.endAt, breaks: s.breaks }));
    }

    // T10-D — automatic unpaid-lunch inputs for this one timesheet's source.
    const [plannedUnpaidByDate, grossThresholdMinutes] = await Promise.all([
      source.dataSource === 'DRAFT'
        ? loadDraftPlannedUnpaidBreakByDate([source.draftId!], tx)
        : loadVersionPlannedUnpaidBreakByDate([source.versionId!], tx),
      loadAutoUnpaidBreakThresholdMinutes(tx)
    ]);

    const { sites, total } = groupSegments(rawSegments, { plannedUnpaidByDate, grossThresholdMinutes });

    const timesheetDto: WorkerTimeReportTimesheet = {
      id: timesheet.id,
      status: timesheet.status,
      dataSource: source.dataSource,
      versionNumber: source.versionNumber,
      submissionSource: source.submissionSource
    };

    return {
      code: 'OK' as const,
      report: { asOf: asOf.toISOString(), employee: employeeDto, period: periodDto, participant: participantDto, timesheet: timesheetDto, sites, total }
    };
  }, REPORT_TX_OPTIONS);
}
