import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getForemanSiteIds } from '@/lib/foreman-review';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { computeSegmentMs, sumWorkedTimeMs, msToMinutes, type WorkedTimeSegmentInput } from '@/lib/reporting/worked-time';
import { resolveCanonicalSource } from '@/lib/reporting/canonical-source';

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.2A Site Time Report APIs" — this module owns
// population (§A), FOREMAN scope (§B), canonical-source selection (§C, identical to T8.1's
// lib/worker-time-report.ts), day/site aggregation (§D), pagination/summary (§E), and the bounded
// read transaction (§G). Both GET /api/admin/reports/sites/:siteId and
// GET /api/foreman/reports/sites/:siteId call getSiteTimeReport directly — one implementation, two
// thin route wrappers that only differ in auth/permission/scope.

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export type SiteTimeReportScope = { kind: 'unrestricted' } | { kind: 'foreman'; foremanUserId: string; today: Date };

export interface SiteTimeReportPagination {
  page: number;
  pageSize: number;
}

export interface SiteTimeReportSite {
  id: string;
  name: string;
  active: boolean;
}

export interface SiteTimeReportPeriod {
  id: string;
  startDate: string;
  endDate: string;
  status: string;
}

export interface SiteTimeReportTimesheet {
  id: string;
  status: string;
  dataSource: 'DRAFT' | 'CURRENT_VERSION';
  versionNumber: number | null;
  submissionSource: string | null;
}

export interface SiteTimeReportDay {
  date: string;
  grossMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  workedMinutes: number;
  segmentCount: number;
}

export interface SiteTimeReportWorkerTotal {
  workedDayCount: number;
  grossMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  workedMinutes: number;
  segmentCount: number;
}

export interface SiteTimeReportItem {
  employee: { id: string; employeeNumber: string; firstName: string; lastName: string };
  assignmentInPeriod: boolean;
  participantExpected: boolean | null;
  timesheet: SiteTimeReportTimesheet | null;
  days: SiteTimeReportDay[];
  total: SiteTimeReportWorkerTotal;
}

export interface SiteTimeReportSummary {
  workerCount: number;
  withoutTimesheetCount: number;
  workedDayCount: number;
  grossMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  workedMinutes: number;
  segmentCount: number;
  timesheetStatusCounts: Record<'DRAFT' | 'SUBMITTED' | 'RETURNED' | 'FOREMAN_APPROVED' | 'FINAL_APPROVED', number>;
}

export interface SiteTimeReport {
  asOf: string;
  site: SiteTimeReportSite;
  period: SiteTimeReportPeriod;
  summary: SiteTimeReportSummary;
  items: SiteTimeReportItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export type SiteTimeReportOutcome = { code: 'SITE_NOT_FOUND' } | { code: 'SITE_REPORT_NOT_FOUND' } | { code: 'PERIOD_NOT_FOUND' } | { code: 'OK'; report: SiteTimeReport };

const REPORT_TX_OPTIONS = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 20_000 } as const;

export interface SiteReportQueryInput {
  siteId: string | null;
  periodId: string | null;
  page: string | null;
  pageSize: string | null;
}

export type SiteReportQueryResult = { ok: true; siteId: string; periodId: string; page: number; pageSize: number } | { ok: false; fieldErrors: Record<string, string[]> };

// Shared by both routes (§I) — identical validation, only the permission/scope check differs.
export function parseSiteReportQuery(input: SiteReportQueryInput): SiteReportQueryResult {
  const fieldErrors: Record<string, string[]> = {};

  if (!input.siteId || !UUID_PATTERN.test(input.siteId)) {
    fieldErrors.siteId = ['must be a UUID'];
  }
  if (!input.periodId) {
    fieldErrors.periodId = ['required'];
  } else if (!UUID_PATTERN.test(input.periodId)) {
    fieldErrors.periodId = ['must be a UUID'];
  }

  let page = 1;
  if (input.page !== null && input.page !== '') {
    const parsed = Number(input.page);
    if (!Number.isInteger(parsed) || parsed < 1) {
      fieldErrors.page = ['must be a positive integer'];
    } else {
      page = parsed;
    }
  }

  let pageSize = DEFAULT_PAGE_SIZE;
  if (input.pageSize !== null && input.pageSize !== '') {
    const parsed = Number(input.pageSize);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
      fieldErrors.pageSize = [`must be an integer between 1 and ${MAX_PAGE_SIZE}`];
    } else {
      pageSize = parsed;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }
  return { ok: true, siteId: input.siteId as string, periodId: input.periodId as string, page, pageSize };
}

const ZERO_WORKER_TOTAL: SiteTimeReportWorkerTotal = { workedDayCount: 0, grossMinutes: 0, paidBreakMinutes: 0, unpaidBreakMinutes: 0, workedMinutes: 0, segmentCount: 0 };

interface RawSegment extends WorkedTimeSegmentInput {
  employeeId: string;
  date: Date;
}

function buildDays(segments: RawSegment[]): { days: SiteTimeReportDay[]; total: SiteTimeReportWorkerTotal } {
  if (segments.length === 0) {
    return { days: [], total: ZERO_WORKER_TOTAL };
  }

  const byDate = new Map<string, RawSegment[]>();
  for (const seg of segments) {
    const key = formatDate(seg.date);
    const list = byDate.get(key);
    if (list) {
      list.push(seg);
    } else {
      byDate.set(key, [seg]);
    }
  }

  const days: SiteTimeReportDay[] = [];
  for (const [date, daySegments] of byDate) {
    // §D п.1 — sum in ms per day, round once here.
    const ms = sumWorkedTimeMs(daySegments.map((s) => computeSegmentMs(s)));
    days.push({
      date,
      grossMinutes: msToMinutes(ms.grossMs),
      paidBreakMinutes: msToMinutes(ms.paidBreakMs),
      unpaidBreakMinutes: msToMinutes(ms.unpaidBreakMs),
      workedMinutes: msToMinutes(ms.workedMs),
      segmentCount: daySegments.length
    });
  }

  days.sort((a, b) => a.date.localeCompare(b.date));

  // §D п.2 — worker total is the sum of already-rounded day rows, not a second ms-level rounding.
  const total = days.reduce(
    (acc, d) => ({
      workedDayCount: acc.workedDayCount + 1,
      grossMinutes: acc.grossMinutes + d.grossMinutes,
      paidBreakMinutes: acc.paidBreakMinutes + d.paidBreakMinutes,
      unpaidBreakMinutes: acc.unpaidBreakMinutes + d.unpaidBreakMinutes,
      workedMinutes: acc.workedMinutes + d.workedMinutes,
      segmentCount: acc.segmentCount + d.segmentCount
    }),
    ZERO_WORKER_TOTAL
  );

  return { days, total };
}

export async function getSiteTimeReport(siteId: string, periodId: string, pagination: SiteTimeReportPagination, scope: SiteTimeReportScope): Promise<SiteTimeReportOutcome> {
  const page = Number.isInteger(pagination.page) && pagination.page > 0 ? pagination.page : 1;
  const pageSize = Number.isInteger(pagination.pageSize) && pagination.pageSize > 0 && pagination.pageSize <= MAX_PAGE_SIZE ? pagination.pageSize : DEFAULT_PAGE_SIZE;

  return prisma.$transaction(async (tx) => {
    const asOf = new Date();

    const site = await tx.workSite.findUnique({ where: { id: siteId }, select: { id: true, name: true, active: true } });
    if (!site) {
      return { code: scope.kind === 'foreman' ? ('SITE_REPORT_NOT_FOUND' as const) : ('SITE_NOT_FOUND' as const) };
    }

    if (scope.kind === 'foreman') {
      // §B — scope resolved INSIDE this same snapshot transaction, not a pre-check before it.
      const foremanSiteIds = await getForemanSiteIds(scope.foremanUserId, scope.today, tx);
      if (!foremanSiteIds.includes(siteId)) {
        // Same code as "site doesn't exist at all" — a foreign-but-real site must never be
        // distinguishable from a nonexistent one (no enumeration oracle).
        return { code: 'SITE_REPORT_NOT_FOUND' as const };
      }
    }

    const period = await tx.payrollPeriod.findUnique({ where: { id: periodId }, select: { id: true, startDate: true, endDate: true, status: true } });
    if (!period) {
      return { code: 'PERIOD_NOT_FOUND' as const };
    }

    // §A path 1 — SiteAssignment overlapping the period's date range (existing inclusive-both-ends
    // overlap semantics, same as lib/periods.ts's createPeriod participant materialization).
    const overlappingAssignments = await tx.siteAssignment.findMany({
      where: { siteId, validFrom: { lte: period.endDate }, OR: [{ validTo: null }, { validTo: { gte: period.startDate } }] },
      select: { employeeId: true }
    });
    const assignmentInPeriodIds = new Set(overlappingAssignments.map((a) => a.employeeId));

    // §A path 2 — every Timesheet in this period, to resolve canonical source per employee and to
    // find which employees have at least one segment at this site.
    const timesheets = await tx.timesheet.findMany({
      where: { periodId },
      select: {
        id: true,
        employeeId: true,
        status: true,
        currentVersionId: true,
        draft: { select: { id: true } },
        currentVersion: { select: { versionNumber: true, submissionSource: true } }
      }
    });

    // §C — the shared canonical-source rule (also used by T8.1/T8.3); throws for the whole request
    // on an invariant failure, never a silently-skipped employee.
    const sourceByTimesheetId = new Map(
      timesheets.map((t) => [t.id, resolveCanonicalSource({ id: t.id, status: t.status, currentVersionId: t.currentVersionId, draft: t.draft, currentVersion: t.currentVersion })])
    );

    const draftIdToEmployeeId = new Map<string, string>();
    const versionIdToEmployeeId = new Map<string, string>();
    for (const t of timesheets) {
      const source = sourceByTimesheetId.get(t.id)!;
      if (source.dataSource === 'DRAFT') {
        draftIdToEmployeeId.set(source.draftId!, t.employeeId);
      } else {
        versionIdToEmployeeId.set(source.versionId!, t.employeeId);
      }
    }
    const draftIds = [...draftIdToEmployeeId.keys()];
    const versionIds = [...versionIdToEmployeeId.keys()];

    const [draftSegments, versionSegments] = await Promise.all([
      draftIds.length > 0
        ? tx.timesheetDraftSegment.findMany({
            where: { draftId: { in: draftIds }, siteId },
            select: { draftId: true, date: true, startAt: true, endAt: true, breaks: { select: { startAt: true, endAt: true, paid: true } } }
          })
        : Promise.resolve([]),
      versionIds.length > 0
        ? tx.workSegment.findMany({
            where: { timesheetVersionId: { in: versionIds }, siteId },
            select: { timesheetVersionId: true, date: true, startAt: true, endAt: true, breaks: { select: { startAt: true, endAt: true, paid: true } } }
          })
        : Promise.resolve([])
    ]);

    const rawSegments: RawSegment[] = [
      ...draftSegments.map((s) => ({ employeeId: draftIdToEmployeeId.get(s.draftId)!, date: s.date, startAt: s.startAt, endAt: s.endAt, breaks: s.breaks })),
      ...versionSegments.map((s) => ({ employeeId: versionIdToEmployeeId.get(s.timesheetVersionId)!, date: s.date, startAt: s.startAt, endAt: s.endAt, breaks: s.breaks }))
    ];

    const segmentsByEmployee = new Map<string, RawSegment[]>();
    for (const seg of rawSegments) {
      const list = segmentsByEmployee.get(seg.employeeId);
      if (list) {
        list.push(seg);
      } else {
        segmentsByEmployee.set(seg.employeeId, [seg]);
      }
    }

    // §A — union of path 1 (assignment overlap) and path 2 (has a segment at this site).
    const populationIds = new Set<string>([...assignmentInPeriodIds, ...segmentsByEmployee.keys()]);

    if (populationIds.size === 0) {
      const emptySummary: SiteTimeReportSummary = {
        workerCount: 0,
        withoutTimesheetCount: 0,
        workedDayCount: 0,
        grossMinutes: 0,
        paidBreakMinutes: 0,
        unpaidBreakMinutes: 0,
        workedMinutes: 0,
        segmentCount: 0,
        timesheetStatusCounts: { DRAFT: 0, SUBMITTED: 0, RETURNED: 0, FOREMAN_APPROVED: 0, FINAL_APPROVED: 0 }
      };
      return {
        code: 'OK' as const,
        report: {
          asOf: asOf.toISOString(),
          site: { id: site.id, name: site.name, active: site.active },
          period: { id: period.id, startDate: formatDate(period.startDate), endDate: formatDate(period.endDate), status: period.status },
          summary: emptySummary,
          items: [],
          page,
          pageSize,
          totalItems: 0,
          totalPages: 0
        }
      };
    }

    const [employees, participants] = await Promise.all([
      tx.employee.findMany({ where: { id: { in: [...populationIds] } }, select: { id: true, employeeNumber: true, firstName: true, lastName: true } }),
      tx.payrollPeriodParticipant.findMany({ where: { periodId, employeeId: { in: [...populationIds] } }, select: { employeeId: true, expected: true } })
    ]);

    const participantByEmployee = new Map(participants.map((p) => [p.employeeId, p.expected]));
    const timesheetByEmployee = new Map(timesheets.map((t) => [t.employeeId, t]));

    const items: SiteTimeReportItem[] = employees.map((employee) => {
      const t = timesheetByEmployee.get(employee.id);
      const source = t ? sourceByTimesheetId.get(t.id)! : null;
      const timesheetDto: SiteTimeReportTimesheet | null =
        t && source ? { id: t.id, status: t.status, dataSource: source.dataSource, versionNumber: source.versionNumber, submissionSource: source.submissionSource } : null;
      const { days, total } = buildDays(segmentsByEmployee.get(employee.id) ?? []);
      const participantExpectedRaw = participantByEmployee.get(employee.id);
      return {
        employee: { id: employee.id, employeeNumber: employee.employeeNumber, firstName: employee.firstName, lastName: employee.lastName },
        assignmentInPeriod: assignmentInPeriodIds.has(employee.id),
        participantExpected: participantExpectedRaw === undefined ? null : participantExpectedRaw,
        timesheet: timesheetDto,
        days,
        total
      };
    });

    // Task rule — lastName ASC, firstName ASC, employeeNumber ASC, employee.id ASC.
    items.sort((a, b) => {
      const e1 = a.employee;
      const e2 = b.employee;
      return e1.lastName.localeCompare(e2.lastName) || e1.firstName.localeCompare(e2.firstName) || e1.employeeNumber.localeCompare(e2.employeeNumber) || e1.id.localeCompare(e2.id);
    });

    // §E — summary from the FULL (unpaginated) set, computed before the page slice.
    const timesheetStatusCounts: SiteTimeReportSummary['timesheetStatusCounts'] = { DRAFT: 0, SUBMITTED: 0, RETURNED: 0, FOREMAN_APPROVED: 0, FINAL_APPROVED: 0 };
    let withoutTimesheetCount = 0;
    let summaryGross = 0;
    let summaryPaidBreak = 0;
    let summaryUnpaidBreak = 0;
    let summaryWorked = 0;
    let summarySegmentCount = 0;
    for (const item of items) {
      if (item.timesheet) {
        timesheetStatusCounts[item.timesheet.status as keyof typeof timesheetStatusCounts] += 1;
      } else {
        withoutTimesheetCount += 1;
      }
      summaryGross += item.total.grossMinutes;
      summaryPaidBreak += item.total.paidBreakMinutes;
      summaryUnpaidBreak += item.total.unpaidBreakMinutes;
      summaryWorked += item.total.workedMinutes;
      summarySegmentCount += item.total.segmentCount;
    }
    // summary.workedDayCount — distinct dates across ALL employees' segments at this site at once.
    const summaryWorkedDayCount = new Set(rawSegments.map((s) => formatDate(s.date))).size;

    const summary: SiteTimeReportSummary = {
      workerCount: items.length,
      withoutTimesheetCount,
      workedDayCount: summaryWorkedDayCount,
      grossMinutes: summaryGross,
      paidBreakMinutes: summaryPaidBreak,
      unpaidBreakMinutes: summaryUnpaidBreak,
      workedMinutes: summaryWorked,
      segmentCount: summarySegmentCount,
      timesheetStatusCounts
    };

    const totalItems = items.length;
    const totalPages = Math.ceil(totalItems / pageSize);
    const pageItems = items.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);

    return {
      code: 'OK' as const,
      report: {
        asOf: asOf.toISOString(),
        site: { id: site.id, name: site.name, active: site.active },
        period: { id: period.id, startDate: formatDate(period.startDate), endDate: formatDate(period.endDate), status: period.status },
        summary,
        items: pageItems,
        page,
        pageSize,
        totalItems,
        totalPages
      }
    };
  }, REPORT_TX_OPTIONS);
}
