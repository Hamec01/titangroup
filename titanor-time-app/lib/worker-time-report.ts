import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { computeSegmentMs, sumWorkedTimeMs, msToMinutes, type WorkedTimeSegmentInput } from '@/lib/reporting/worked-time';

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

function groupSegments(segments: RawSegment[]): { sites: WorkerTimeReportSiteBucket[]; total: WorkerTimeReportTotal } {
  if (segments.length === 0) {
    return { sites: [], total: ZERO_TOTAL };
  }

  const bySite = new Map<string, { siteName: string; segments: RawSegment[] }>();
  for (const seg of segments) {
    const bucket = bySite.get(seg.siteId);
    if (bucket) {
      bucket.segments.push(seg);
    } else {
      bySite.set(seg.siteId, { siteName: seg.siteName, segments: [seg] });
    }
  }

  const sites: WorkerTimeReportSiteBucket[] = [];
  for (const [siteId, { siteName, segments: siteSegments }] of bySite) {
    // §2 п.2 — sum in ms per site, round once here (not per-segment, not at the total level below).
    const ms = sumWorkedTimeMs(siteSegments.map((s) => computeSegmentMs(s)));
    const distinctDates = new Set(siteSegments.map((s) => formatDate(s.date)));
    sites.push({
      siteId,
      siteName,
      grossMinutes: msToMinutes(ms.grossMs),
      paidBreakMinutes: msToMinutes(ms.paidBreakMs),
      unpaidBreakMinutes: msToMinutes(ms.unpaidBreakMs),
      workedMinutes: msToMinutes(ms.workedMs),
      segmentCount: siteSegments.length,
      workedDayCount: distinctDates.size
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

    const usesDraft = timesheet.status === 'DRAFT' || timesheet.status === 'RETURNED';

    let rawSegments: RawSegment[];
    if (usesDraft) {
      if (!timesheet.draft) {
        // §1 invariant — DRAFT/RETURNED must always own a TimesheetDraft row (created atomically
        // with the timesheet/on return). Not a zero report — a genuine data-integrity failure.
        throw new Error(`WORKER_TIME_REPORT_INVARIANT_FAILURE: timesheet ${timesheet.id} has status ${timesheet.status} but no TimesheetDraft`);
      }
      const segments = await tx.timesheetDraftSegment.findMany({
        where: { draftId: timesheet.draft.id },
        select: { siteId: true, date: true, startAt: true, endAt: true, site: { select: { name: true } }, breaks: { select: { startAt: true, endAt: true, paid: true } } }
      });
      rawSegments = segments.map((s) => ({ siteId: s.siteId, siteName: s.site.name, date: s.date, startAt: s.startAt, endAt: s.endAt, breaks: s.breaks }));
    } else {
      if (!timesheet.currentVersionId || !timesheet.currentVersion) {
        // §1 invariant — SUBMITTED/FOREMAN_APPROVED/FINAL_APPROVED must always carry a
        // currentVersionId, set atomically with the status transition. Never falls back to draft.
        throw new Error(`WORKER_TIME_REPORT_INVARIANT_FAILURE: timesheet ${timesheet.id} has status ${timesheet.status} but no currentVersionId`);
      }
      const segments = await tx.workSegment.findMany({
        where: { timesheetVersionId: timesheet.currentVersionId },
        select: { siteId: true, date: true, startAt: true, endAt: true, site: { select: { name: true } }, breaks: { select: { startAt: true, endAt: true, paid: true } } }
      });
      rawSegments = segments.map((s) => ({ siteId: s.siteId, siteName: s.site.name, date: s.date, startAt: s.startAt, endAt: s.endAt, breaks: s.breaks }));
    }

    const { sites, total } = groupSegments(rawSegments);

    const timesheetDto: WorkerTimeReportTimesheet = {
      id: timesheet.id,
      status: timesheet.status,
      dataSource: usesDraft ? 'DRAFT' : 'CURRENT_VERSION',
      versionNumber: usesDraft ? null : (timesheet.currentVersion?.versionNumber ?? null),
      submissionSource: usesDraft ? null : (timesheet.currentVersion?.submissionSource ?? null)
    };

    return {
      code: 'OK' as const,
      report: { asOf: asOf.toISOString(), employee: employeeDto, period: periodDto, participant: participantDto, timesheet: timesheetDto, sites, total }
    };
  }, REPORT_TX_OPTIONS);
}
