import type { DisplayDay, TimeLedgerResult, WeeklyCustomerSliceRow } from '@/lib/reporting/time-ledger';

export type ReportWeekGroupBy = 'all' | 'customer' | 'site' | 'worker';
export type ReportWeekSort = 'name_asc' | 'hours_desc' | 'hours_asc' | 'attention_first';
export type ReportWeekStatus = 'all' | 'approved' | 'attention' | 'changed' | 'ready' | 'not_submitted' | 'source_error';

export interface ReportWeekQuery {
  groupBy: ReportWeekGroupBy;
  sort: ReportWeekSort;
  customerId: string | 'none' | null;
  siteId: string | null;
  employeeSearch: string | null;
  status: ReportWeekStatus;
  onlyIssues: boolean;
}

export interface ReportWeekDay {
  date: string;
  confirmedZero: boolean;
  grossMinutes: number;
  breakMinutes: number;
  workedMinutes: number;
  dayTypes: string[];
  intervals: Array<{
    startAt: string;
    endAt: string;
    paidBreakMinutes: number;
    unpaidBreakMinutes: number;
    siteName: string;
    customerName: string;
  }>;
}

export interface ReportWeekRow {
  key: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  subjectLabel: string | null;
  days: ReportWeekDay[];
  grossMinutes: number;
  breakMinutes: number;
  workedMinutes: number;
  status: Exclude<ReportWeekStatus, 'all' | 'not_submitted' | 'source_error'>;
  issueCount: number;
}

export interface ReportWeekGroup {
  key: string;
  title: string;
  subtitle: string | null;
  rows: ReportWeekRow[];
  workerCount: number;
  issueCount: number;
  days: ReportWeekDay[];
  grossMinutes: number;
  breakMinutes: number;
  workedMinutes: number;
}

export interface ReportWeekDetail {
  dates: string[];
  groups: ReportWeekGroup[];
  missing: TimeLedgerResult['notSubmitted'];
  sourceErrors: TimeLedgerResult['sourceErrors'];
  customerOptions: Array<{ id: string | 'none'; label: string }>;
  siteOptions: Array<{ id: string; label: string }>;
  visibleRowCount: number;
}

const GROUP_VALUES = new Set<ReportWeekGroupBy>(['all', 'customer', 'site', 'worker']);
const SORT_VALUES = new Set<ReportWeekSort>(['name_asc', 'hours_desc', 'hours_asc', 'attention_first']);
const STATUS_VALUES = new Set<ReportWeekStatus>(['all', 'approved', 'attention', 'changed', 'ready', 'not_submitted', 'source_error']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function one(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

/** Lenient for backwards-compatible report URLs: invalid presentation values fall back to the
 * documented defaults, while entity ids are ignored unless they are well-formed UUIDs. */
export function parseReportWeekQuery(sp: Record<string, string | string[] | undefined>): ReportWeekQuery {
  const groupRaw = one(sp.groupBy);
  const sortRaw = one(sp.sort);
  const statusRaw = one(sp.reportStatus);
  const customerRaw = one(sp.customerId);
  const siteRaw = one(sp.reportSiteId);
  const employeeRaw = one(sp.employeeSearch)?.trim() ?? '';
  return {
    groupBy: GROUP_VALUES.has(groupRaw as ReportWeekGroupBy) ? (groupRaw as ReportWeekGroupBy) : 'customer',
    sort: SORT_VALUES.has(sortRaw as ReportWeekSort) ? (sortRaw as ReportWeekSort) : 'name_asc',
    customerId: customerRaw === 'none' ? 'none' : customerRaw && UUID_PATTERN.test(customerRaw) ? customerRaw : null,
    siteId: siteRaw && UUID_PATTERN.test(siteRaw) ? siteRaw : null,
    employeeSearch: employeeRaw ? employeeRaw : null,
    status: STATUS_VALUES.has(statusRaw as ReportWeekStatus) ? (statusRaw as ReportWeekStatus) : 'all',
    onlyIssues: one(sp.onlyIssues) === 'true'
  };
}

function enumerateDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function emptyDay(date: string): ReportWeekDay {
  return { date, confirmedZero: false, grossMinutes: 0, breakMinutes: 0, workedMinutes: 0, dayTypes: [], intervals: [] };
}

function segmentBreakMinutes(segment: DisplayDay['segments'][number], paid: boolean): number {
  return segment.breaks
    .filter((item) => item.paid === paid)
    .reduce((sum, item) => sum + Math.max(0, (new Date(item.endAt).getTime() - new Date(item.startAt).getTime()) / 60000), 0);
}

interface SliceWithNames {
  row: WeeklyCustomerSliceRow;
  siteName: string;
  customerName: string;
}

function rowStatus(row: WeeklyCustomerSliceRow): ReportWeekRow['status'] {
  if (row.blockers.length > 0 || row.warnings.length > 0 || row.approvalState === 'NEEDS_ATTENTION') return 'attention';
  if (row.approvalState === 'CHANGED_AFTER_APPROVAL') return 'changed';
  if (row.approvalState === 'APPROVED') return 'approved';
  return 'ready';
}

const STATUS_RANK: Record<ReportWeekRow['status'], number> = { attention: 4, changed: 3, ready: 2, approved: 1 };

function mergeStatus(current: ReportWeekRow['status'], next: ReportWeekRow['status']): ReportWeekRow['status'] {
  return STATUS_RANK[next] > STATUS_RANK[current] ? next : current;
}

function matchesStatus(slice: SliceWithNames, query: ReportWeekQuery): boolean {
  if (query.status === 'all') return true;
  if (query.status === 'not_submitted' || query.status === 'source_error') return false;
  return rowStatus(slice.row) === query.status;
}

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase('ru-RU');
}

function aggregateRows(slices: SliceWithNames[], dates: string[], key: string, subjectLabel: string | null): ReportWeekRow {
  const first = slices[0];
  const daysByDate = new Map(dates.map((date) => [date, emptyDay(date)]));
  let status = rowStatus(first.row);
  let issueCount = 0;
  let grossMinutes = 0;
  let breakMinutes = 0;
  let workedMinutes = 0;

  for (const slice of slices) {
    status = mergeStatus(status, rowStatus(slice.row));
    issueCount += slice.row.blockers.length + slice.row.warnings.length;
    grossMinutes += slice.row.grossMinutes;
    breakMinutes += slice.row.breakMinutes;
    workedMinutes += slice.row.workedMinutes;
    for (const sourceDay of slice.row.displayDays) {
      const day = daysByDate.get(sourceDay.date);
      if (!day) continue;
      day.grossMinutes += sourceDay.grossMinutes;
      day.breakMinutes += sourceDay.breakMinutes;
      day.workedMinutes += sourceDay.workedMinutes;
      day.confirmedZero ||= sourceDay.confirmedZero;
      if (sourceDay.dayType && !day.dayTypes.includes(sourceDay.dayType)) day.dayTypes.push(sourceDay.dayType);
      for (const segment of sourceDay.segments) {
        day.intervals.push({
          startAt: segment.startAt,
          endAt: segment.endAt,
          paidBreakMinutes: segmentBreakMinutes(segment, true),
          unpaidBreakMinutes: segmentBreakMinutes(segment, false),
          siteName: slice.siteName,
          customerName: slice.customerName
        });
      }
    }
  }

  return {
    key,
    employeeId: first.row.logicalKey.employeeId,
    employeeName: first.row.employeeName,
    employeeNumber: first.row.employeeNumber,
    subjectLabel,
    days: dates.map((date) => daysByDate.get(date)!),
    grossMinutes,
    breakMinutes,
    workedMinutes,
    status,
    issueCount
  };
}

function aggregateDays(rows: ReportWeekRow[], dates: string[]): ReportWeekDay[] {
  return dates.map((date, index) => {
    const result = emptyDay(date);
    for (const row of rows) {
      const day = row.days[index];
      result.grossMinutes += day.grossMinutes;
      result.breakMinutes += day.breakMinutes;
      result.workedMinutes += day.workedMinutes;
    }
    return result;
  });
}

function sortRows(rows: ReportWeekRow[], sort: ReportWeekSort): void {
  rows.sort((a, b) => {
    if (sort === 'hours_desc') return b.workedMinutes - a.workedMinutes || a.employeeName.localeCompare(b.employeeName);
    if (sort === 'hours_asc') return a.workedMinutes - b.workedMinutes || a.employeeName.localeCompare(b.employeeName);
    if (sort === 'attention_first') return STATUS_RANK[b.status] - STATUS_RANK[a.status] || a.employeeName.localeCompare(b.employeeName);
    return a.employeeName.localeCompare(b.employeeName);
  });
}

function makeGroup(key: string, title: string, subtitle: string | null, rows: ReportWeekRow[], dates: string[], sort: ReportWeekSort): ReportWeekGroup {
  sortRows(rows, sort);
  return {
    key,
    title,
    subtitle,
    rows,
    workerCount: new Set(rows.map((row) => row.employeeId)).size,
    issueCount: rows.reduce((sum, row) => sum + row.issueCount, 0),
    days: aggregateDays(rows, dates),
    grossMinutes: rows.reduce((sum, row) => sum + row.grossMinutes, 0),
    breakMinutes: rows.reduce((sum, row) => sum + row.breakMinutes, 0),
    workedMinutes: rows.reduce((sum, row) => sum + row.workedMinutes, 0)
  };
}

function groupSlices(slices: SliceWithNames[], dates: string[], query: ReportWeekQuery): ReportWeekGroup[] {
  const grouped = new Map<string, { title: string; subtitle: string | null; rowBuckets: Map<string, { subjectLabel: string | null; slices: SliceWithNames[] }> }>();

  for (const slice of slices) {
    const employeeId = slice.row.logicalKey.employeeId;
    let groupKey: string;
    let groupTitle: string;
    let groupSubtitle: string | null = null;
    let rowKey: string;
    let subjectLabel: string | null = null;

    if (query.groupBy === 'customer') {
      groupKey = `customer:${slice.row.logicalKey.siteId}:${slice.row.logicalKey.workAreaId ?? 'none'}`;
      groupTitle = slice.customerName;
      groupSubtitle = slice.siteName;
      rowKey = employeeId;
    } else if (query.groupBy === 'site') {
      groupKey = `site:${slice.row.logicalKey.siteId}`;
      groupTitle = slice.siteName;
      rowKey = employeeId;
    } else if (query.groupBy === 'worker') {
      groupKey = `worker:${employeeId}`;
      groupTitle = `${slice.row.employeeName} · #${slice.row.employeeNumber}`;
      rowKey = `${slice.row.logicalKey.siteId}:${slice.row.logicalKey.workAreaId ?? 'none'}`;
      subjectLabel = `${slice.customerName} · ${slice.siteName}`;
    } else {
      groupKey = 'all';
      groupTitle = 'all';
      rowKey = employeeId;
    }

    let group = grouped.get(groupKey);
    if (!group) {
      group = { title: groupTitle, subtitle: groupSubtitle, rowBuckets: new Map() };
      grouped.set(groupKey, group);
    }
    let bucket = group.rowBuckets.get(rowKey);
    if (!bucket) {
      bucket = { subjectLabel, slices: [] };
      group.rowBuckets.set(rowKey, bucket);
    }
    bucket.slices.push(slice);
  }

  const groups = [...grouped.entries()].map(([key, group]) => {
    const rows = [...group.rowBuckets.entries()].map(([rowKey, bucket]) => aggregateRows(bucket.slices, dates, `${key}:${rowKey}`, bucket.subjectLabel));
    return makeGroup(key, group.title, group.subtitle, rows, dates, query.sort);
  });

  groups.sort((a, b) => {
    if (query.sort === 'hours_desc') return b.workedMinutes - a.workedMinutes || a.title.localeCompare(b.title);
    if (query.sort === 'hours_asc') return a.workedMinutes - b.workedMinutes || a.title.localeCompare(b.title);
    if (query.sort === 'attention_first') return b.issueCount - a.issueCount || a.title.localeCompare(b.title);
    return a.title.localeCompare(b.title);
  });
  return groups;
}

export function buildReportWeekDetail(
  ledger: TimeLedgerResult,
  startDate: string,
  endDate: string,
  query: ReportWeekQuery,
  noCustomerLabel = 'Без заказчика'
): ReportWeekDetail {
  const dates = enumerateDates(startDate, endDate);
  const allSlices: SliceWithNames[] = ledger.customerGroups.flatMap((group) => {
    const customerName = group.workAreaId === null ? noCustomerLabel : (group.workAreaName ?? group.workAreaId);
    return group.rows.map((row) => ({ row, siteName: group.siteName, customerName }));
  });

  const customerOptions = [...new Map(allSlices.map((slice) => [slice.row.logicalKey.workAreaId ?? 'none', slice.customerName])).entries()]
    .map(([id, label]) => ({ id: id as string | 'none', label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const siteOptions = [...new Map(allSlices.map((slice) => [slice.row.logicalKey.siteId, slice.siteName])).entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const needle = query.employeeSearch ? normalizeSearch(query.employeeSearch) : null;
  const filtered = allSlices.filter((slice) => {
    if (query.customerId && (slice.row.logicalKey.workAreaId ?? 'none') !== query.customerId) return false;
    if (query.siteId && slice.row.logicalKey.siteId !== query.siteId) return false;
    if (needle && !normalizeSearch(`${slice.row.employeeName} ${slice.row.employeeNumber}`).includes(needle)) return false;
    if (query.onlyIssues && slice.row.blockers.length + slice.row.warnings.length === 0) return false;
    return matchesStatus(slice, query);
  });

  const missing = ledger.notSubmitted.filter((row) => {
    if (query.status !== 'all' && query.status !== 'not_submitted') return false;
    if (query.customerId || query.siteId || query.onlyIssues) return false;
    return !needle || normalizeSearch(`${row.employeeName} ${row.employeeNumber}`).includes(needle);
  });
  const sourceErrors = ledger.sourceErrors.filter((row) => {
    if (query.status !== 'all' && query.status !== 'source_error') return false;
    if (query.customerId || query.siteId) return false;
    return !needle || normalizeSearch(`${row.employeeName} ${row.employeeNumber}`).includes(needle);
  });
  const groups = query.status === 'not_submitted' || query.status === 'source_error' ? [] : groupSlices(filtered, dates, query);

  return {
    dates,
    groups,
    missing,
    sourceErrors,
    customerOptions,
    siteOptions,
    visibleRowCount: groups.reduce((sum, group) => sum + group.rows.length, 0) + missing.length + sourceErrors.length
  };
}
