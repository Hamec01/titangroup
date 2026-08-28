import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import type { WorkedTimeSegmentInput } from '@/lib/reporting/worked-time';
import { resolveCanonicalSource } from '@/lib/reporting/canonical-source';
import { buildCanonicalDailyBuckets } from '@/lib/reporting/canonical-daily-buckets';
import { loadPlannedUnpaidBreakBySourceAndDate, loadAutoUnpaidBreakThresholdMinutes } from '@/lib/reporting/auto-break';

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.3A Company Payroll Period Report API" — this
// module owns company population (§Q), site population (§R), canonical-source resolution (§S,
// shared with T8.1/T8.2 via lib/reporting/canonical-source.ts), the (employeeId, siteId, date)
// rounding bucket (§T), the aggregation hierarchy (§U), and the bounded read transaction (§Z).
// GET /api/admin/reports/periods/:periodId calls getPeriodTimeReport directly — no HTTP self-fetch,
// no per-worker/per-site loop calling getWorkerTimeReport/getSiteTimeReport, one bulk pass.

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface PeriodTimeReportPeriod {
  id: string;
  startDate: string;
  endDate: string;
  status: string;
}

export type TimesheetStatusCounts = Record<'DRAFT' | 'SUBMITTED' | 'RETURNED' | 'FOREMAN_APPROVED' | 'FINAL_APPROVED', number>;

function zeroStatusCounts(): TimesheetStatusCounts {
  return { DRAFT: 0, SUBMITTED: 0, RETURNED: 0, FOREMAN_APPROVED: 0, FINAL_APPROVED: 0 };
}

export interface PeriodTimeReportSummary {
  workerCount: number;
  participantCount: number;
  expectedParticipantCount: number;
  excludedParticipantCount: number;
  assignedWorkerCount: number;
  workedWorkerCount: number;
  withoutTimesheetCount: number;
  withoutSiteCount: number;
  siteCount: number;
  workedDayCount: number;
  grossMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  workedMinutes: number;
  segmentCount: number;
  timesheetStatusCounts: TimesheetStatusCounts;
}

export interface PeriodTimeReportSite {
  site: { id: string; name: string; active: boolean };
  assignedWorkerCount: number;
  workedWorkerCount: number;
  withoutTimesheetCount: number;
  workedDayCount: number;
  grossMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  workedMinutes: number;
  segmentCount: number;
  timesheetStatusCounts: TimesheetStatusCounts;
}

export interface PeriodTimeReport {
  asOf: string;
  period: PeriodTimeReportPeriod;
  summary: PeriodTimeReportSummary;
  sites: PeriodTimeReportSite[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export type PeriodTimeReportOutcome = { code: 'PERIOD_NOT_FOUND' } | { code: 'OK'; report: PeriodTimeReport };

const REPORT_TX_OPTIONS = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 20_000 } as const;

export interface PeriodReportQueryInput {
  page: string | null;
  pageSize: string | null;
}

export type PeriodReportQueryResult = { ok: true; page: number; pageSize: number } | { ok: false; fieldErrors: Record<string, string[]> };

export function parsePeriodReportQuery(input: PeriodReportQueryInput): PeriodReportQueryResult {
  const fieldErrors: Record<string, string[]> = {};

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
  return { ok: true, page, pageSize };
}

/** periodId itself is a path param, not a query param — validated separately so a malformed path
 * segment produces the same 400 VALIDATION_ERROR shape as a malformed query param. */
export function isValidPeriodId(periodId: string): boolean {
  return UUID_PATTERN.test(periodId);
}

interface RawSegment extends WorkedTimeSegmentInput {
  employeeId: string;
  timesheetVersionId: string | null;
  siteId: string;
  date: Date;
  plannedUnpaidBreakMinutes: number;
}

interface SiteAccumulator {
  assignedEmployeeIds: Set<string>;
  workedEmployeeIds: Set<string>;
  dates: Set<string>;
  grossMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  workedMinutes: number;
  segmentCount: number;
}

export async function getPeriodTimeReport(periodId: string, pagination: { page: number; pageSize: number }): Promise<PeriodTimeReportOutcome> {
  const page = Number.isInteger(pagination.page) && pagination.page > 0 ? pagination.page : 1;
  const pageSize = Number.isInteger(pagination.pageSize) && pagination.pageSize > 0 && pagination.pageSize <= MAX_PAGE_SIZE ? pagination.pageSize : DEFAULT_PAGE_SIZE;

  return prisma.$transaction(async (tx) => {
    const asOf = new Date();

    const period = await tx.payrollPeriod.findUnique({ where: { id: periodId }, select: { id: true, startDate: true, endDate: true, status: true } });
    if (!period) {
      return { code: 'PERIOD_NOT_FOUND' as const };
    }
    const periodDto: PeriodTimeReportPeriod = { id: period.id, startDate: formatDate(period.startDate), endDate: formatDate(period.endDate), status: period.status };

    // §Q path 1 — every PayrollPeriodParticipant of this period (company-wide, no site filter).
    const participants = await tx.payrollPeriodParticipant.findMany({ where: { periodId }, select: { employeeId: true, expected: true } });
    const participantIds = new Set(participants.map((p) => p.employeeId));
    const expectedParticipantCount = participants.filter((p) => p.expected).length;
    const excludedParticipantCount = participants.length - expectedParticipantCount;

    // §Q path 3 / §R path 1 — every SiteAssignment overlapping the period, company-wide (no siteId
    // filter — unlike T8.2A, which scopes this to one site).
    const overlappingAssignments = await tx.siteAssignment.findMany({
      where: { validFrom: { lte: period.endDate }, OR: [{ validTo: null }, { validTo: { gte: period.startDate } }] },
      select: { employeeId: true, siteId: true }
    });
    const assignedEmployeeIds = new Set(overlappingAssignments.map((a) => a.employeeId));
    const assignedEmployeeIdsBySite = new Map<string, Set<string>>();
    for (const a of overlappingAssignments) {
      let set = assignedEmployeeIdsBySite.get(a.siteId);
      if (!set) {
        set = new Set();
        assignedEmployeeIdsBySite.set(a.siteId, set);
      }
      set.add(a.employeeId);
    }

    // §Q path 2 / §S — every Timesheet of this period, canonical-source resolved once (shared
    // helper, §P) — throws for the whole request on an invariant failure, never a silently-skipped
    // employee/timesheet.
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
    const timesheetByEmployee = new Map(timesheets.map((t) => [t.employeeId, t]));
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

    // §S — one bulk pass per source type, company-wide (no siteId filter — unlike T8.2A).
    const [draftSegments, versionSegments] = await Promise.all([
      draftIds.length > 0
        ? tx.timesheetDraftSegment.findMany({
            where: { draftId: { in: draftIds } },
            select: { draftId: true, siteId: true, date: true, startAt: true, endAt: true, breaks: { select: { startAt: true, endAt: true, paid: true } } }
          })
        : Promise.resolve([]),
      versionIds.length > 0
        ? tx.workSegment.findMany({
            where: { timesheetVersionId: { in: versionIds } },
            select: { timesheetVersionId: true, siteId: true, date: true, startAt: true, endAt: true, breaks: { select: { startAt: true, endAt: true, paid: true } } }
          })
        : Promise.resolve([])
    ]);

    // T10-D — planned UNPAID break per source+date, and the company auto-deduct threshold, for the
    // automatic unpaid-lunch deduction inside buildCanonicalDailyBuckets.
    const [plannedUnpaidByKey, autoBreakThresholdMinutes] = await Promise.all([
      loadPlannedUnpaidBreakBySourceAndDate({ versionIds, draftIds }, tx),
      loadAutoUnpaidBreakThresholdMinutes(tx)
    ]);
    const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

    const rawSegments: RawSegment[] = [
      ...draftSegments.map((s) => ({
        employeeId: draftIdToEmployeeId.get(s.draftId)!,
        timesheetVersionId: null,
        siteId: s.siteId,
        date: s.date,
        startAt: s.startAt,
        endAt: s.endAt,
        breaks: s.breaks,
        plannedUnpaidBreakMinutes: plannedUnpaidByKey.get(`${s.draftId}:${isoDay(s.date)}`) ?? 0
      })),
      ...versionSegments.map((s) => ({
        employeeId: versionIdToEmployeeId.get(s.timesheetVersionId)!,
        timesheetVersionId: s.timesheetVersionId,
        siteId: s.siteId,
        date: s.date,
        startAt: s.startAt,
        endAt: s.endAt,
        breaks: s.breaks,
        plannedUnpaidBreakMinutes: plannedUnpaidByKey.get(`${s.timesheetVersionId}:${isoDay(s.date)}`) ?? 0
      }))
    ];

    // §T — canonical rounding bucket (employeeId, siteId, date), shared with CSV_V1 via
    // lib/reporting/canonical-daily-buckets.ts (T8_REPORTS_DESIGN.md Addendum "T8.4B" §BD). Sum ms
    // within the bucket, round once via msToMinutes. Every higher level below is only ever a sum of
    // these already-rounded bucket numbers, never a second ms-level round.
    const roundedBuckets = buildCanonicalDailyBuckets(rawSegments, { grossThresholdMinutes: autoBreakThresholdMinutes });

    const workedEmployeeIds = new Set(roundedBuckets.map((b) => b.employeeId));
    const workedEmployeeIdsBySite = new Map<string, Set<string>>();
    for (const b of roundedBuckets) {
      let set = workedEmployeeIdsBySite.get(b.siteId);
      if (!set) {
        set = new Set();
        workedEmployeeIdsBySite.set(b.siteId, set);
      }
      set.add(b.employeeId);
    }

    // §Q — company population: union of participant / timesheet / assignment. Segment-presence
    // (path 4) is a proven subset of "has a Timesheet" here (§Q note) so it adds nothing further.
    const companyPopulation = new Set<string>([...participantIds, ...timesheetByEmployee.keys(), ...assignedEmployeeIds]);

    if (companyPopulation.size === 0) {
      const emptySummary: PeriodTimeReportSummary = {
        workerCount: 0,
        participantCount: participants.length,
        expectedParticipantCount,
        excludedParticipantCount,
        assignedWorkerCount: 0,
        workedWorkerCount: 0,
        withoutTimesheetCount: 0,
        withoutSiteCount: 0,
        siteCount: 0,
        workedDayCount: 0,
        grossMinutes: 0,
        paidBreakMinutes: 0,
        unpaidBreakMinutes: 0,
        workedMinutes: 0,
        segmentCount: 0,
        timesheetStatusCounts: zeroStatusCounts()
      };
      return {
        code: 'OK' as const,
        report: { asOf: asOf.toISOString(), period: periodDto, summary: emptySummary, sites: [], page, pageSize, totalItems: 0, totalPages: 0 }
      };
    }

    // §R — site population: union of (assignment from company population) and (has a segment).
    const sitePopulationIds = new Set<string>([...assignedEmployeeIdsBySite.keys(), ...workedEmployeeIdsBySite.keys()]);

    const sitesRaw = sitePopulationIds.size > 0 ? await tx.workSite.findMany({ where: { id: { in: [...sitePopulationIds] } }, select: { id: true, name: true, active: true } }) : [];

    // §U — accumulate each site row from the already-rounded daily buckets belonging to that site.
    const siteAccumulators = new Map<string, SiteAccumulator>();
    for (const siteId of sitePopulationIds) {
      siteAccumulators.set(siteId, {
        assignedEmployeeIds: assignedEmployeeIdsBySite.get(siteId) ?? new Set(),
        workedEmployeeIds: workedEmployeeIdsBySite.get(siteId) ?? new Set(),
        dates: new Set(),
        grossMinutes: 0,
        paidBreakMinutes: 0,
        unpaidBreakMinutes: 0,
        workedMinutes: 0,
        segmentCount: 0
      });
    }
    for (const b of roundedBuckets) {
      const acc = siteAccumulators.get(b.siteId)!;
      acc.grossMinutes += b.grossMinutes;
      acc.paidBreakMinutes += b.paidBreakMinutes;
      acc.unpaidBreakMinutes += b.unpaidBreakMinutes;
      acc.workedMinutes += b.workedMinutes;
      acc.segmentCount += b.segmentCount;
      acc.dates.add(b.date);
    }

    // Site-level timesheetStatusCounts/withoutTimesheetCount — over site population (assigned ∪
    // worked at that site), each counted once PER SITE (a multi-site worker intentionally appears
    // in every site row they belong to — §W documents this as expected, not a bug).
    const siteNameById = new Map(sitesRaw.map((s) => [s.id, s.name]));
    const siteActiveById = new Map(sitesRaw.map((s) => [s.id, s.active]));
    const sites: PeriodTimeReportSite[] = [];
    for (const [siteId, acc] of siteAccumulators) {
      const sitePopulation = new Set<string>([...acc.assignedEmployeeIds, ...acc.workedEmployeeIds]);
      const statusCounts = zeroStatusCounts();
      let withoutTimesheetCount = 0;
      for (const employeeId of sitePopulation) {
        const t = timesheetByEmployee.get(employeeId);
        if (t) {
          statusCounts[t.status as keyof TimesheetStatusCounts] += 1;
        } else {
          withoutTimesheetCount += 1;
        }
      }
      sites.push({
        site: { id: siteId, name: siteNameById.get(siteId) ?? '', active: siteActiveById.get(siteId) ?? false },
        assignedWorkerCount: acc.assignedEmployeeIds.size,
        workedWorkerCount: acc.workedEmployeeIds.size,
        withoutTimesheetCount,
        workedDayCount: acc.dates.size,
        grossMinutes: acc.grossMinutes,
        paidBreakMinutes: acc.paidBreakMinutes,
        unpaidBreakMinutes: acc.unpaidBreakMinutes,
        workedMinutes: acc.workedMinutes,
        segmentCount: acc.segmentCount,
        timesheetStatusCounts: statusCounts
      });
    }

    // §W — deterministic sorting even on tied site names.
    sites.sort((a, b) => (a.site.name === b.site.name ? a.site.id.localeCompare(b.site.id) : a.site.name.localeCompare(b.site.name)));

    // §W — company summary from the FULL (unpaginated) site set, computed before the page slice.
    const companyStatusCounts = zeroStatusCounts();
    let companyWithoutTimesheetCount = 0;
    for (const employeeId of companyPopulation) {
      const t = timesheetByEmployee.get(employeeId);
      if (t) {
        companyStatusCounts[t.status as keyof TimesheetStatusCounts] += 1;
      } else {
        companyWithoutTimesheetCount += 1;
      }
    }
    let companyWithoutSiteCount = 0;
    for (const employeeId of companyPopulation) {
      if (!assignedEmployeeIds.has(employeeId) && !workedEmployeeIds.has(employeeId)) {
        companyWithoutSiteCount += 1;
      }
    }

    const companyTotals = sites.reduce(
      (acc, s) => ({
        grossMinutes: acc.grossMinutes + s.grossMinutes,
        paidBreakMinutes: acc.paidBreakMinutes + s.paidBreakMinutes,
        unpaidBreakMinutes: acc.unpaidBreakMinutes + s.unpaidBreakMinutes,
        workedMinutes: acc.workedMinutes + s.workedMinutes,
        segmentCount: acc.segmentCount + s.segmentCount
      }),
      { grossMinutes: 0, paidBreakMinutes: 0, unpaidBreakMinutes: 0, workedMinutes: 0, segmentCount: 0 }
    );
    const companyWorkedDayCount = new Set(roundedBuckets.map((b) => b.date)).size;

    const summary: PeriodTimeReportSummary = {
      workerCount: companyPopulation.size,
      participantCount: participants.length,
      expectedParticipantCount,
      excludedParticipantCount,
      assignedWorkerCount: assignedEmployeeIds.size,
      workedWorkerCount: workedEmployeeIds.size,
      withoutTimesheetCount: companyWithoutTimesheetCount,
      withoutSiteCount: companyWithoutSiteCount,
      siteCount: sites.length,
      workedDayCount: companyWorkedDayCount,
      grossMinutes: companyTotals.grossMinutes,
      paidBreakMinutes: companyTotals.paidBreakMinutes,
      unpaidBreakMinutes: companyTotals.unpaidBreakMinutes,
      workedMinutes: companyTotals.workedMinutes,
      segmentCount: companyTotals.segmentCount,
      timesheetStatusCounts: companyStatusCounts
    };

    const totalItems = sites.length;
    const totalPages = Math.ceil(totalItems / pageSize);
    const pageSites = sites.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);

    return {
      code: 'OK' as const,
      report: { asOf: asOf.toISOString(), period: periodDto, summary, sites: pageSites, page, pageSize, totalItems, totalPages }
    };
  }, REPORT_TX_OPTIONS);
}
