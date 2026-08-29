import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { WorkedTimeSegmentInput } from '@/lib/reporting/worked-time';
import { computeSegmentMs, msToMinutes } from '@/lib/reporting/worked-time';
import { resolveCanonicalSource } from '@/lib/reporting/canonical-source';
import { buildCanonicalDailyBuckets, type CanonicalDailyBucket } from '@/lib/reporting/canonical-daily-buckets';
import { loadPlannedUnpaidBreakBySourceAndDate, loadAutoUnpaidBreakThresholdMinutes } from '@/lib/reporting/auto-break';

// Part A (flexible time report export) — task spec §3. Reuses the EXACT canonical reporting
// core T8.1-T8.4 use (lib/reporting/worked-time.ts, canonical-source.ts,
// canonical-daily-buckets.ts) instead of a second formula. The only genuinely new thing here is
// the query shape: an arbitrary [dateFrom, dateTo] span (not a single PayrollPeriod) with
// optional employee/site filters and a FINAL_APPROVED_ONLY vs CURRENT_CANONICAL data-source
// switch (§3). Canonical bucket = (employeeId, siteId, date), rounded once, exactly as T8.

export const MAX_CUSTOM_REPORT_DAYS = 366;

export type CustomReportDataMode = 'FINAL_APPROVED_ONLY' | 'CURRENT_CANONICAL';

export interface CustomReportParams {
  dateFrom: Date;
  dateTo: Date;
  employeeIds: string[] | null;
  siteIds: string[] | null;
  dataMode: CustomReportDataMode;
}

export interface CustomReportEmployee {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
}

export interface CustomReportSite {
  id: string;
  name: string;
}

export interface CustomReportDetailRow {
  date: string;
  employee: CustomReportEmployee;
  site: CustomReportSite;
  workAreaName: string | null;
  startAt: string;
  endAt: string;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  workedMinutes: number;
  timesheetStatus: string;
}

export interface CustomReportSummaryRow {
  employee: CustomReportEmployee;
  site: CustomReportSite;
  grossMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  workedMinutes: number;
  workedDays: number;
}

// T13.7/T13.13/T13.16 — the DAILY row: one per (employee, site, calendar date). Canonical bucket
// numbers (rounded once). firstStartAt / lastEndAt are the earliest / latest segment ISO instants
// on that day at that site (for display; never re-summed).
export interface CustomReportDailyRow {
  date: string;
  employee: CustomReportEmployee;
  site: CustomReportSite;
  firstStartAt: string | null;
  lastEndAt: string | null;
  grossMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  workedMinutes: number;
  segmentCount: number;
  timesheetStatus: string;
}

export interface CustomReportTotals {
  grossMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  workedMinutes: number;
  workedDays: number;
}

export interface CustomTimeReport {
  dateFrom: string;
  dateTo: string;
  dataMode: CustomReportDataMode;
  employees: CustomReportEmployee[];
  sites: CustomReportSite[];
  detailRows: CustomReportDetailRow[];
  dailyRows: CustomReportDailyRow[];
  summaryRows: CustomReportSummaryRow[];
  employeeSubtotals: { employee: CustomReportEmployee; totals: CustomReportTotals }[];
  siteSubtotals: { site: CustomReportSite; totals: CustomReportTotals }[];
  grandTotal: CustomReportTotals;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function emptyTotals(): CustomReportTotals {
  return { grossMinutes: 0, paidBreakMinutes: 0, unpaidBreakMinutes: 0, workedMinutes: 0, workedDays: 0 };
}

const REPORT_TX_OPTIONS = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 15_000, timeout: 30_000 } as const;

interface RawSegment extends WorkedTimeSegmentInput {
  employeeId: string;
  timesheetVersionId: string | null;
  siteId: string;
  workAreaId: string | null;
  date: Date;
  plannedUnpaidBreakMinutes: number;
}

export async function getCustomTimeReport(params: CustomReportParams): Promise<CustomTimeReport> {
  return prisma.$transaction(async (tx) => {
    // Every PayrollPeriod overlapping the requested date range — a custom report's segments
    // always belong to some period even though the report itself isn't period-scoped.
    const periods = await tx.payrollPeriod.findMany({
      where: { startDate: { lte: params.dateTo }, endDate: { gte: params.dateFrom } },
      select: { id: true }
    });
    const periodIds = periods.map((p) => p.id);
    if (periodIds.length === 0) {
      return emptyReport(params);
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
      return emptyReport(params);
    }

    const draftIdToTimesheet = new Map<string, (typeof timesheets)[number]>();
    const versionIdToTimesheet = new Map<string, (typeof timesheets)[number]>();
    for (const t of timesheets) {
      const source = resolveCanonicalSource({ id: t.id, status: t.status, currentVersionId: t.currentVersionId, draft: t.draft, currentVersion: t.currentVersion });
      if (source.dataSource === 'DRAFT') {
        draftIdToTimesheet.set(source.draftId!, t);
      } else {
        versionIdToTimesheet.set(source.versionId!, t);
      }
    }
    const draftIds = [...draftIdToTimesheet.keys()];
    const versionIds = [...versionIdToTimesheet.keys()];

    const siteFilter = params.siteIds ? { siteId: { in: params.siteIds } } : {};
    const dateFilter = { date: { gte: params.dateFrom, lte: params.dateTo } };

    const [draftSegments, versionSegments] = await Promise.all([
      draftIds.length > 0
        ? tx.timesheetDraftSegment.findMany({
            where: { draftId: { in: draftIds }, ...dateFilter, ...siteFilter },
            select: { draftId: true, siteId: true, workAreaId: true, date: true, startAt: true, endAt: true, breaks: { select: { startAt: true, endAt: true, paid: true } } }
          })
        : Promise.resolve([]),
      versionIds.length > 0
        ? tx.workSegment.findMany({
            where: { timesheetVersionId: { in: versionIds }, ...dateFilter, ...siteFilter },
            select: { timesheetVersionId: true, siteId: true, workAreaId: true, date: true, startAt: true, endAt: true, breaks: { select: { startAt: true, endAt: true, paid: true } } }
          })
        : Promise.resolve([])
    ]);

    if (draftSegments.length === 0 && versionSegments.length === 0) {
      return emptyReport(params);
    }

    // T10-D — planned UNPAID break per source+date + the company threshold.
    const [plannedUnpaidByKey, autoBreakThresholdMinutes] = await Promise.all([
      loadPlannedUnpaidBreakBySourceAndDate({ versionIds, draftIds }, tx),
      loadAutoUnpaidBreakThresholdMinutes(tx)
    ]);
    const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

    const rawSegments: RawSegment[] = [
      ...draftSegments.map((s) => ({ employeeId: draftIdToTimesheet.get(s.draftId)!.employeeId, timesheetVersionId: null, siteId: s.siteId, workAreaId: s.workAreaId, date: s.date, startAt: s.startAt, endAt: s.endAt, breaks: s.breaks, plannedUnpaidBreakMinutes: plannedUnpaidByKey.get(`${s.draftId}:${isoDay(s.date)}`) ?? 0 })),
      ...versionSegments.map((s) => ({ employeeId: versionIdToTimesheet.get(s.timesheetVersionId)!.employeeId, timesheetVersionId: s.timesheetVersionId, siteId: s.siteId, workAreaId: s.workAreaId, date: s.date, startAt: s.startAt, endAt: s.endAt, breaks: s.breaks, plannedUnpaidBreakMinutes: plannedUnpaidByKey.get(`${s.timesheetVersionId}:${isoDay(s.date)}`) ?? 0 }))
    ];

    const employeeIdSet = new Set(rawSegments.map((s) => s.employeeId));
    const siteIdSet = new Set(rawSegments.map((s) => s.siteId));
    const workAreaKeys = new Set(rawSegments.filter((s) => s.workAreaId).map((s) => `${s.siteId}:${s.workAreaId}`));

    const [employeesRaw, sitesRaw, workAreasRaw] = await Promise.all([
      tx.employee.findMany({ where: { id: { in: [...employeeIdSet] } }, select: { id: true, employeeNumber: true, firstName: true, lastName: true } }),
      tx.workSite.findMany({ where: { id: { in: [...siteIdSet] } }, select: { id: true, name: true } }),
      workAreaKeys.size > 0 ? tx.workArea.findMany({ where: { siteId: { in: [...siteIdSet] } }, select: { id: true, siteId: true, name: true } }) : Promise.resolve([])
    ]);

    const employeeById = new Map(employeesRaw.map((e) => [e.id, e]));
    const siteById = new Map(sitesRaw.map((s) => [s.id, s]));
    const workAreaByKey = new Map(workAreasRaw.map((w) => [`${w.siteId}:${w.id}`, w.name]));
    const timesheetStatusByEmployeeAndVersion = new Map<string, string>();
    for (const t of timesheets) {
      if (t.currentVersionId) timesheetStatusByEmployeeAndVersion.set(t.currentVersionId, t.status);
    }
    const draftStatusByDraftId = new Map(draftIdToTimesheet.entries().map(([draftId, t]) => [draftId, t.status]));

    // --- Detailed rows: one per raw segment (before canonical bucket rounding) ---
    const detailRows: CustomReportDetailRow[] = [];
    for (const segment of [...draftSegments.map((s) => ({ ...s, kind: 'draft' as const })), ...versionSegments.map((s) => ({ ...s, kind: 'version' as const }))]) {
      const employeeId = segment.kind === 'draft' ? draftIdToTimesheet.get(segment.draftId!)!.employeeId : versionIdToTimesheet.get(segment.timesheetVersionId!)!.employeeId;
      const employee = employeeById.get(employeeId)!;
      const site = siteById.get(segment.siteId)!;
      const status = segment.kind === 'draft' ? (draftStatusByDraftId.get(segment.draftId!) ?? '') : (timesheetStatusByEmployeeAndVersion.get(segment.timesheetVersionId!) ?? '');
      const ms = computeSegmentMs({ startAt: segment.startAt, endAt: segment.endAt, breaks: segment.breaks });
      detailRows.push({
        date: formatDate(segment.date),
        employee: { id: employee.id, employeeNumber: employee.employeeNumber, firstName: employee.firstName, lastName: employee.lastName },
        site: { id: site.id, name: site.name },
        workAreaName: segment.workAreaId ? (workAreaByKey.get(`${segment.siteId}:${segment.workAreaId}`) ?? null) : null,
        startAt: segment.startAt.toISOString(),
        endAt: segment.endAt.toISOString(),
        paidBreakMinutes: msToMinutes(ms.paidBreakMs),
        unpaidBreakMinutes: msToMinutes(ms.unpaidBreakMs),
        workedMinutes: msToMinutes(ms.workedMs),
        timesheetStatus: status
      });
    }
    // Deterministic order: date ASC, employee lastName/firstName ASC, siteName ASC, segment startAt ASC (§5).
    detailRows.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.employee.lastName !== b.employee.lastName) return a.employee.lastName.localeCompare(b.employee.lastName);
      if (a.employee.firstName !== b.employee.firstName) return a.employee.firstName.localeCompare(b.employee.firstName);
      if (a.site.name !== b.site.name) return a.site.name.localeCompare(b.site.name);
      return a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : 0;
    });

    // --- Canonical (employeeId, siteId, date) buckets — round once, sum only already-rounded numbers above (§3/§4). ---
    const buckets: CanonicalDailyBucket[] = buildCanonicalDailyBuckets(rawSegments, { grossThresholdMinutes: autoBreakThresholdMinutes });

    // --- DAILY rows: one per (employee, site, date) canonical bucket, with first/last segment time.
    const detailByDayKey = new Map<string, CustomReportDetailRow[]>();
    for (const dr of detailRows) {
      const key = `${dr.employee.id}:${dr.site.id}:${dr.date}`;
      const arr = detailByDayKey.get(key);
      if (arr) arr.push(dr);
      else detailByDayKey.set(key, [dr]);
    }
    const dailyRows: CustomReportDailyRow[] = buckets
      .map((b) => {
        const employee = employeeById.get(b.employeeId)!;
        const site = siteById.get(b.siteId)!;
        const key = `${b.employeeId}:${b.siteId}:${b.date}`;
        const daySegments = detailByDayKey.get(key) ?? [];
        const starts = daySegments.map((s) => s.startAt).sort();
        const ends = daySegments.map((s) => s.endAt).sort();
        const status = daySegments[0]?.timesheetStatus ?? '';
        return {
          date: b.date,
          employee: { id: employee.id, employeeNumber: employee.employeeNumber, firstName: employee.firstName, lastName: employee.lastName },
          site: { id: site.id, name: site.name },
          firstStartAt: starts[0] ?? null,
          lastEndAt: ends[ends.length - 1] ?? null,
          grossMinutes: b.grossMinutes,
          paidBreakMinutes: b.paidBreakMinutes,
          unpaidBreakMinutes: b.unpaidBreakMinutes,
          workedMinutes: b.workedMinutes,
          segmentCount: b.segmentCount,
          timesheetStatus: status
        };
      })
      .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.employee.lastName.localeCompare(b.employee.lastName) || a.employee.firstName.localeCompare(b.employee.firstName) || a.site.name.localeCompare(b.site.name)));

    const summaryKey = (employeeId: string, siteId: string) => `${employeeId}:${siteId}`;
    const summaryMap = new Map<string, CustomReportSummaryRow>();
    for (const bucket of buckets) {
      const key = summaryKey(bucket.employeeId, bucket.siteId);
      let row = summaryMap.get(key);
      if (!row) {
        const employee = employeeById.get(bucket.employeeId)!;
        const site = siteById.get(bucket.siteId)!;
        row = {
          employee: { id: employee.id, employeeNumber: employee.employeeNumber, firstName: employee.firstName, lastName: employee.lastName },
          site: { id: site.id, name: site.name },
          grossMinutes: 0,
          paidBreakMinutes: 0,
          unpaidBreakMinutes: 0,
          workedMinutes: 0,
          workedDays: 0
        };
        summaryMap.set(key, row);
      }
      row.grossMinutes += bucket.grossMinutes;
      row.paidBreakMinutes += bucket.paidBreakMinutes;
      row.unpaidBreakMinutes += bucket.unpaidBreakMinutes;
      row.workedMinutes += bucket.workedMinutes;
      row.workedDays += 1; // one bucket = one (employee, site, date) — each contributes exactly one worked day here.
    }
    const summaryRows = [...summaryMap.values()].sort((a, b) => {
      if (a.employee.lastName !== b.employee.lastName) return a.employee.lastName.localeCompare(b.employee.lastName);
      if (a.employee.firstName !== b.employee.firstName) return a.employee.firstName.localeCompare(b.employee.firstName);
      return a.site.name.localeCompare(b.site.name);
    });

    const employeeSubtotalsMap = new Map<string, { employee: CustomReportEmployee; totals: CustomReportTotals }>();
    const siteSubtotalsMap = new Map<string, { site: CustomReportSite; totals: CustomReportTotals }>();
    const grandTotal = emptyTotals();
    for (const row of summaryRows) {
      let e = employeeSubtotalsMap.get(row.employee.id);
      if (!e) {
        e = { employee: row.employee, totals: emptyTotals() };
        employeeSubtotalsMap.set(row.employee.id, e);
      }
      let s = siteSubtotalsMap.get(row.site.id);
      if (!s) {
        s = { site: row.site, totals: emptyTotals() };
        siteSubtotalsMap.set(row.site.id, s);
      }
      // Minutes: sum of already-rounded (employee, site) rows (§T8 rounding rules) — fine to add up.
      for (const totals of [e.totals, s.totals, grandTotal]) {
        totals.grossMinutes += row.grossMinutes;
        totals.paidBreakMinutes += row.paidBreakMinutes;
        totals.unpaidBreakMinutes += row.unpaidBreakMinutes;
        totals.workedMinutes += row.workedMinutes;
      }
      // workedDays for the SITE subtotal = COUNT DISTINCT (employeeId, date) at this site; since
      // each (employee, site) row already carries that employee's distinct-date count at this
      // site, summing across employees is correct here.
      s.totals.workedDays += row.workedDays;
    }

    // T13.7 (docs/titanor-time/T13 §12) — workedDays for the EMPLOYEE subtotal is COUNT DISTINCT
    // date ACROSS the selected sites (a worker on two sites the same day = one worked day), and
    // the GRAND TOTAL is COUNT DISTINCT (employeeId, date). Summing the per-(employee, site) row
    // counts overcounts both — compute them straight from the canonical buckets instead.
    const employeeDateSets = new Map<string, Set<string>>();
    const grandKeys = new Set<string>();
    for (const bucket of buckets) {
      let set = employeeDateSets.get(bucket.employeeId);
      if (!set) {
        set = new Set<string>();
        employeeDateSets.set(bucket.employeeId, set);
      }
      set.add(bucket.date);
      grandKeys.add(`${bucket.employeeId}|${bucket.date}`);
    }
    for (const [employeeId, entry] of employeeSubtotalsMap) {
      entry.totals.workedDays = employeeDateSets.get(employeeId)?.size ?? 0;
    }
    grandTotal.workedDays = grandKeys.size;

    return {
      dateFrom: formatDate(params.dateFrom),
      dateTo: formatDate(params.dateTo),
      dataMode: params.dataMode,
      employees: [...employeeById.values()].map((e) => ({ id: e.id, employeeNumber: e.employeeNumber, firstName: e.firstName, lastName: e.lastName })),
      sites: [...siteById.values()].map((s) => ({ id: s.id, name: s.name })),
      detailRows,
      dailyRows,
      summaryRows,
      employeeSubtotals: [...employeeSubtotalsMap.values()].sort((a, b) => a.employee.lastName.localeCompare(b.employee.lastName) || a.employee.firstName.localeCompare(b.employee.firstName)),
      siteSubtotals: [...siteSubtotalsMap.values()].sort((a, b) => a.site.name.localeCompare(b.site.name)),
      grandTotal
    };
  }, REPORT_TX_OPTIONS);
}

function emptyReport(params: CustomReportParams): CustomTimeReport {
  return {
    dateFrom: formatDate(params.dateFrom),
    dateTo: formatDate(params.dateTo),
    dataMode: params.dataMode,
    employees: [],
    sites: [],
    detailRows: [],
    dailyRows: [],
    summaryRows: [],
    employeeSubtotals: [],
    siteSubtotals: [],
    grandTotal: emptyTotals()
  };
}
