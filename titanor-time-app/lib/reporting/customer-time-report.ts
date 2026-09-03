import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { computeDayWorkedMs, msToMinutes } from '@/lib/reporting/worked-time';
import { resolveCanonicalSource } from '@/lib/reporting/canonical-source';
import { loadPlannedUnpaidBreakBySourceAndDate, loadAutoUnpaidBreakThresholdMinutes } from '@/lib/reporting/auto-break';
import { liveAssignmentWhere, helsinkiToday } from '@/lib/assignment-lifecycle';

// R15-D7 Deploy F (docs/titanor-time/R15_D7_DEPLOY_F_SPEC_RU.md) — "Часы заказчику".
//
// THE defect this fixes: one WorkSite can host several customers (WorkAreas); the old
// /admin/reports/customer never filtered segments by workAreaId, so one customer's document could
// contain another customer's hours. This module filters EVERY segment (WorkSegment +
// TimesheetDraftSegment) by workAreaId and buckets by (employeeId, siteId, workAreaId, date), so a
// customer report contains only that customer's minutes — to the minute, identical in UI/PDF/CSV.
//
// Historical attribution is by the SEGMENT's own workAreaId, never today's SiteAssignment — a
// transferred / terminated worker stays in the customer's historical report for the days they
// actually worked that customer. Disabled (active=false) customers stay reportable.

export type CustomerReportDataMode = 'FINAL_APPROVED_ONLY' | 'CURRENT_CANONICAL';

/** The special key for the internal-only "Без указанного заказчика" bucket (workAreaId IS NULL). */
export const NO_CUSTOMER = '__NO_CUSTOMER__';

export interface CustomerTimeReportParams {
  dateFrom: Date;
  dateTo: Date;
  /** Real WorkArea ids to report on. */
  workAreaIds: string[];
  /** Also include segments with workAreaId IS NULL (internal preview only — never a client PDF). */
  includeNoCustomer: boolean;
  /** null = every worker with hours in the selected customer scope. */
  employeeIds: string[] | null;
  dataMode: CustomerReportDataMode;
}

export interface CustomerReportEmployee {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
}

export interface CustomerReportWorkerRow {
  employee: CustomerReportEmployee;
  /** Rounded worked minutes for this customer in the period (sum of per-day canonical buckets). */
  workedMinutes: number;
  /** Distinct YYYY-MM-DD this worker had hours for this customer. */
  workDates: string[];
  /** The least-approved timesheet status across this worker's days in the period (for the "status"
   *  column). '' when unknown. */
  timesheetStatus: string;
  /** Operationally-live SiteAssignment on this customer right now. */
  assignedNow: boolean;
  /** Had at least one worked segment for this customer in the period. */
  workedInPeriod: boolean;
}

export interface CustomerReportSection {
  /** null for the NO_CUSTOMER bucket. */
  workAreaId: string | null;
  workAreaName: string | null;
  siteId: string;
  siteName: string;
  customerActive: boolean;
  /** Operationally-live SiteAssignment rows pointing at this workAreaId right now (§3). */
  assignedNowCount: number;
  /** Distinct workers with hours for this customer in the period. */
  workedInPeriodCount: number;
  totalMinutes: number;
  workers: CustomerReportWorkerRow[];
}

export interface CustomerTimeReport {
  dateFrom: string;
  dateTo: string;
  dataMode: CustomerReportDataMode;
  /** true when the NO_CUSTOMER bucket is part of the report — blocks a client PDF. */
  includesNoCustomer: boolean;
  sections: CustomerReportSection[];
  grandTotalMinutes: number;
  grandWorkerCount: number;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Ranked worst→best so we can pick the least-approved status a worker's days carry.
const STATUS_RANK: Record<string, number> = {
  DRAFT: 0,
  RETURNED: 1,
  SUBMITTED: 2,
  FOREMAN_APPROVED: 3,
  FINAL_APPROVED: 4
};
function leastApproved(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return (STATUS_RANK[a] ?? 9) <= (STATUS_RANK[b] ?? 9) ? a : b;
}

const REPORT_TX_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  maxWait: 15_000,
  timeout: 30_000
} as const;

export async function getCustomerTimeReport(params: CustomerTimeReportParams): Promise<CustomerTimeReport> {
  const workAreaIds = Array.from(new Set(params.workAreaIds));
  const dateFrom = params.dateFrom;
  const dateTo = params.dateTo;
  const includesNoCustomer = params.includeNoCustomer;

  const empty = (): CustomerTimeReport => ({
    dateFrom: isoDay(dateFrom),
    dateTo: isoDay(dateTo),
    dataMode: params.dataMode,
    includesNoCustomer,
    sections: [],
    grandTotalMinutes: 0,
    grandWorkerCount: 0
  });

  if (workAreaIds.length === 0 && !includesNoCustomer) return empty();

  return prisma.$transaction(async (tx) => {
    const periods = await tx.payrollPeriod.findMany({
      where: { startDate: { lte: dateTo }, endDate: { gte: dateFrom } },
      select: { id: true }
    });
    const periodIds = periods.map((p) => p.id);

    // The WorkArea / site metadata for the requested scope (resolved by ID — never trust caller text).
    const workAreas = workAreaIds.length
      ? await tx.workArea.findMany({
          where: { id: { in: workAreaIds } },
          select: { id: true, name: true, active: true, siteId: true, site: { select: { name: true } } }
        })
      : [];
    const workAreaById = new Map(workAreas.map((w) => [w.id, w]));

    // The workAreaId filter for BOTH WorkSegment and TimesheetDraftSegment (identical shape on both).
    const waClause: Prisma.WorkSegmentWhereInput & Prisma.TimesheetDraftSegmentWhereInput =
      includesNoCustomer && workAreaIds.length
        ? { OR: [{ workAreaId: { in: workAreaIds } }, { workAreaId: null }] }
        : includesNoCustomer
          ? { workAreaId: null }
          : { workAreaId: { in: workAreaIds } };

    if (periodIds.length === 0) {
      return finalizeReport(tx, params, workAreaById, [], new Map(), includesNoCustomer);
    }

    const timesheets = await tx.timesheet.findMany({
      where: {
        periodId: { in: periodIds },
        ...(params.employeeIds ? { employeeId: { in: params.employeeIds } } : {}),
        ...(params.dataMode === 'FINAL_APPROVED_ONLY' ? { status: 'FINAL_APPROVED' } : {})
      },
      select: {
        id: true,
        employeeId: true,
        status: true,
        currentVersionId: true,
        draft: { select: { id: true } },
        currentVersion: { select: { versionNumber: true, submissionSource: true } }
      }
    });
    if (timesheets.length === 0) {
      return finalizeReport(tx, params, workAreaById, [], new Map(), includesNoCustomer);
    }

    const draftIdToEmployee = new Map<string, string>();
    const versionIdToEmployee = new Map<string, string>();
    const statusByEmployee = new Map<string, string>();
    for (const t of timesheets) {
      statusByEmployee.set(t.employeeId, leastApproved(statusByEmployee.get(t.employeeId) ?? '', t.status));
      const src = resolveCanonicalSource({ id: t.id, status: t.status, currentVersionId: t.currentVersionId, draft: t.draft, currentVersion: t.currentVersion });
      if (src.dataSource === 'DRAFT') draftIdToEmployee.set(src.draftId!, t.employeeId);
      else versionIdToEmployee.set(src.versionId!, t.employeeId);
    }
    const draftIds = [...draftIdToEmployee.keys()];
    const versionIds = [...versionIdToEmployee.keys()];
    const dateFilter = { date: { gte: dateFrom, lte: dateTo } } as const;

    const [draftSegments, versionSegments] = await Promise.all([
      draftIds.length
        ? tx.timesheetDraftSegment.findMany({
            where: { draftId: { in: draftIds }, ...dateFilter, ...waClause },
            select: { draftId: true, siteId: true, workAreaId: true, date: true, startAt: true, endAt: true, breaks: { select: { startAt: true, endAt: true, paid: true } } }
          })
        : Promise.resolve([]),
      versionIds.length
        ? tx.workSegment.findMany({
            where: { timesheetVersionId: { in: versionIds }, ...dateFilter, ...waClause },
            select: { timesheetVersionId: true, siteId: true, workAreaId: true, date: true, startAt: true, endAt: true, breaks: { select: { startAt: true, endAt: true, paid: true } } }
          })
        : Promise.resolve([])
    ]);

    const [plannedUnpaidByKey, autoBreakThresholdMinutes] = await Promise.all([
      loadPlannedUnpaidBreakBySourceAndDate({ versionIds, draftIds }, tx),
      loadAutoUnpaidBreakThresholdMinutes(tx)
    ]);

    interface Seg {
      employeeId: string;
      siteId: string;
      workAreaId: string | null;
      date: Date;
      startAt: Date;
      endAt: Date;
      breaks: { startAt: Date; endAt: Date; paid: boolean }[];
      plannedUnpaidBreakMinutes: number;
    }
    const segs: Seg[] = [
      ...draftSegments.map((s) => ({
        employeeId: draftIdToEmployee.get(s.draftId)!,
        siteId: s.siteId,
        workAreaId: s.workAreaId,
        date: s.date,
        startAt: s.startAt,
        endAt: s.endAt,
        breaks: s.breaks,
        plannedUnpaidBreakMinutes: plannedUnpaidByKey.get(`${s.draftId}:${isoDay(s.date)}`) ?? 0
      })),
      ...versionSegments.map((s) => ({
        employeeId: versionIdToEmployee.get(s.timesheetVersionId)!,
        siteId: s.siteId,
        workAreaId: s.workAreaId,
        date: s.date,
        startAt: s.startAt,
        endAt: s.endAt,
        breaks: s.breaks,
        plannedUnpaidBreakMinutes: plannedUnpaidByKey.get(`${s.timesheetVersionId}:${isoDay(s.date)}`) ?? 0
      }))
    ];

    // Canonical bucket = (employeeId, siteId, workAreaKey, date). workAreaKey scopes the NO_CUSTOMER
    // bucket per site. Round worked-time ONCE per bucket via computeDayWorkedMs + msToMinutes.
    const buckets = new Map<string, { employeeId: string; siteId: string; workAreaId: string | null; date: string; segs: Seg[] }>();
    for (const s of segs) {
      const waKey = s.workAreaId ?? `${NO_CUSTOMER}:${s.siteId}`;
      const key = `${s.employeeId}:${s.siteId}:${waKey}:${isoDay(s.date)}`;
      const b = buckets.get(key);
      if (b) b.segs.push(s);
      else buckets.set(key, { employeeId: s.employeeId, siteId: s.siteId, workAreaId: s.workAreaId, date: isoDay(s.date), segs: [s] });
    }

    // section key -> per-worker accumulation
    interface Acc {
      workAreaId: string | null;
      siteId: string;
      workers: Map<string, { minutes: number; dates: Set<string> }>;
    }
    const sectionKey = (workAreaId: string | null, siteId: string) => (workAreaId ? `wa:${workAreaId}` : `none:${siteId}`);
    const sections = new Map<string, Acc>();
    for (const b of buckets.values()) {
      const plannedUnpaid = b.segs.reduce((m, s) => Math.max(m, s.plannedUnpaidBreakMinutes), 0);
      const ms = computeDayWorkedMs(b.segs, { plannedUnpaidBreakMinutes: plannedUnpaid, grossThresholdMinutes: autoBreakThresholdMinutes });
      const minutes = msToMinutes(ms.workedMs);
      if (minutes <= 0) continue;
      const sk = sectionKey(b.workAreaId, b.siteId);
      let acc = sections.get(sk);
      if (!acc) {
        acc = { workAreaId: b.workAreaId, siteId: b.siteId, workers: new Map() };
        sections.set(sk, acc);
      }
      let w = acc.workers.get(b.employeeId);
      if (!w) {
        w = { minutes: 0, dates: new Set() };
        acc.workers.set(b.employeeId, w);
      }
      w.minutes += minutes;
      w.dates.add(b.date);
    }

    return finalizeReport(tx, params, workAreaById, [...sections.values()], statusByEmployee, includesNoCustomer);
  }, REPORT_TX_OPTIONS);
}

type WorkAreaMeta = Map<string, { id: string; name: string; active: boolean; siteId: string; site: { name: string } }>;

async function finalizeReport(
  tx: Prisma.TransactionClient,
  params: CustomerTimeReportParams,
  workAreaById: WorkAreaMeta,
  accs: { workAreaId: string | null; siteId: string; workers: Map<string, { minutes: number; dates: Set<string> }> }[],
  statusByEmployee: Map<string, string>,
  includesNoCustomer: boolean
): Promise<CustomerTimeReport> {
  const workAreaIds = Array.from(new Set(params.workAreaIds));
  const today = helsinkiToday();

  // Sites we still need names for (the NO_CUSTOMER buckets, plus any missing).
  const siteIdsNeeded = new Set<string>();
  for (const a of accs) if (!a.workAreaId) siteIdsNeeded.add(a.siteId);
  for (const w of workAreaById.values()) siteIdsNeeded.add(w.siteId);
  const sitesRaw = siteIdsNeeded.size
    ? await tx.workSite.findMany({ where: { id: { in: [...siteIdsNeeded] } }, select: { id: true, name: true } })
    : [];
  const siteName = new Map(sitesRaw.map((s) => [s.id, s.name]));

  // "assigned now" — the actual live-assigned employee ids per workArea (used for the count AND to
  // add zero-hour rows for currently-assigned workers with no segments in the period, §4).
  const assignedNowByWa = new Map<string, Set<string>>();
  if (workAreaIds.length) {
    const rows = await tx.siteAssignment.findMany({
      where: { workAreaId: { in: workAreaIds }, ...liveAssignmentWhere(new Date(), today) },
      select: { workAreaId: true, employeeId: true },
      distinct: ['workAreaId', 'employeeId']
    });
    for (const r of rows) {
      if (!r.workAreaId) continue;
      let set = assignedNowByWa.get(r.workAreaId);
      if (!set) {
        set = new Set();
        assignedNowByWa.set(r.workAreaId, set);
      }
      set.add(r.employeeId);
    }
  }

  const employeeIds = new Set<string>();
  for (const a of accs) for (const id of a.workers.keys()) employeeIds.add(id);
  for (const set of assignedNowByWa.values()) for (const id of set) employeeIds.add(id);
  const employees = employeeIds.size
    ? await tx.employee.findMany({
        where: { id: { in: [...employeeIds] } },
        select: { id: true, employeeNumber: true, firstName: true, lastName: true }
      })
    : [];
  const empById = new Map(employees.map((e) => [e.id, e]));

  const accByKey = new Map(
    accs.map((a) => [a.workAreaId ? `wa:${a.workAreaId}` : `none:${a.siteId}`, a])
  );

  const sections: CustomerReportSection[] = [];

  // One section per requested WorkArea (even if it has zero hours in the period — the card still shows).
  for (const waId of workAreaIds) {
    const meta = workAreaById.get(waId);
    if (!meta) continue; // unknown id -> silently skipped (route validates)
    const acc = accByKey.get(`wa:${waId}`);
    sections.push(buildSection(waId, meta.name, meta.siteId, meta.site.name, meta.active, assignedNowByWa.get(waId) ?? new Set(), acc, empById, statusByEmployee));
  }

  // NO_CUSTOMER sections — one per site that had NULL-workArea hours (no "assigned now" for these).
  if (includesNoCustomer) {
    for (const a of accs) {
      if (a.workAreaId) continue;
      sections.push(
        buildSection(null, null, a.siteId, siteName.get(a.siteId) ?? a.siteId, true, new Set(), a, empById, statusByEmployee)
      );
    }
  }

  sections.sort((x, y) => {
    const sx = `${x.siteName} ${x.workAreaName ?? '￿'}`;
    const sy = `${y.siteName} ${y.workAreaName ?? '￿'}`;
    return sx.localeCompare(sy);
  });

  const grandMinutes = sections.reduce((s, sec) => s + sec.totalMinutes, 0);
  const grandWorkers = new Set<string>();
  for (const sec of sections) for (const w of sec.workers) grandWorkers.add(w.employee.id);

  return {
    dateFrom: isoDay(params.dateFrom),
    dateTo: isoDay(params.dateTo),
    dataMode: params.dataMode,
    includesNoCustomer,
    sections,
    grandTotalMinutes: grandMinutes,
    grandWorkerCount: grandWorkers.size
  };
}

function buildSection(
  workAreaId: string | null,
  workAreaName: string | null,
  siteId: string,
  siteName: string,
  customerActive: boolean,
  assignedNowEmployeeIds: Set<string>,
  acc: { workers: Map<string, { minutes: number; dates: Set<string> }> } | undefined,
  empById: Map<string, CustomerReportEmployee>,
  statusByEmployee: Map<string, string>
): CustomerReportSection {
  // Union of "had hours for this customer in the period" and "assigned to this customer right now"
  // (§4 — a currently-assigned worker with no hours yet still shows, at 0 min).
  const ids = new Set<string>([...(acc?.workers.keys() ?? []), ...assignedNowEmployeeIds]);
  const workers: CustomerReportWorkerRow[] = [];
  let total = 0;
  let workedInPeriod = 0;
  for (const empId of ids) {
    const e = empById.get(empId);
    if (!e) continue;
    const w = acc?.workers.get(empId);
    const minutes = w?.minutes ?? 0;
    total += minutes;
    const had = !!w && minutes > 0;
    if (had) workedInPeriod += 1;
    workers.push({
      employee: { id: e.id, employeeNumber: e.employeeNumber, firstName: e.firstName, lastName: e.lastName },
      workedMinutes: minutes,
      workDates: w ? [...w.dates].sort() : [],
      timesheetStatus: statusByEmployee.get(empId) ?? '',
      assignedNow: assignedNowEmployeeIds.has(empId),
      workedInPeriod: had
    });
  }
  workers.sort((a, b) => a.employee.lastName.localeCompare(b.employee.lastName) || a.employee.firstName.localeCompare(b.employee.firstName));
  return {
    workAreaId,
    workAreaName,
    siteId,
    siteName,
    customerActive,
    assignedNowCount: assignedNowEmployeeIds.size,
    workedInPeriodCount: workedInPeriod,
    totalMinutes: total,
    workers
  };
}
