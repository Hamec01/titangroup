// Monthly timesheet matrix ("Табель v2", /admin/timesheets-v2) — customer cards for a month, and per
// customer the month grid: one row per worker, one column per calendar day, a per-day total row
// underneath. Laid out like the spreadsheet customers already keep (worker, employee number, day 1..31).
// Rows = workers attached to the customer (a SiteAssignment overlapping the month) plus anyone who
// recorded hours for it.
//
// No new hours formula: every number is a DisplayDay.workedMinutes of a WeeklyCustomerSliceRow
// returned by getTimeLedger() — the same per-(employee, site, workArea, week) slices "Табель" and
// "Сводка" show. A day split between two customers therefore appears under each customer with that
// customer's own share, exactly as in the weekly view.
//
// Cell kinds:
//  - WORK     hours were recorded on the day (any day of the week).
//  - OFF      the worker did not come: an absence day type (sick leave, vacation, unpaid, other), a
//             confirmed zero, or a weekday with no hours inside a week this worker was active for this
//             customer, on/after their first worked day of the month and before today (today's shift
//             may still be open).
//  - WEEKEND  Saturday/Sunday or a public holiday without hours.
//  - EMPTY    nothing to show (before the worker started, outside their active weeks, future days).

import { prisma } from '@/lib/prisma';
import { getTimeLedger, type LedgerActor, type NormalizedTimeLedgerQuery, type WeeklyCustomerSliceRow } from '@/lib/reporting/time-ledger';

type Db = NonNullable<Parameters<typeof getTimeLedger>[3]>;

export const MONTHLY_MATRIX_MAX_SLICES = 2000;

export type MatrixCellKind = 'WORK' | 'OFF' | 'WEEKEND' | 'EMPTY';

export interface MatrixCell {
  date: string;
  kind: MatrixCellKind;
  workedMinutes: number;
  /** Day type behind an OFF/WEEKEND cell (SICK_LEAVE, VACATION, PUBLIC_HOLIDAY, …) or null. */
  dayType: string | null;
  /** True when the hours come from a week the worker has not submitted yet. */
  draft: boolean;
}

export interface MatrixRow {
  key: string;
  employeeId: string;
  lastName: string;
  firstName: string;
  employeeNumber: string;
  customerKey: string;
  customerName: string;
  cells: MatrixCell[];
  totalMinutes: number;
}

export interface MatrixDay {
  date: string;
  day: number;
  /** 1 = Monday … 7 = Sunday. */
  isoWeekday: number;
  weekend: boolean;
}

export interface CustomerOption {
  key: string;
  name: string;
}

export interface MonthlyMatrix {
  month: string;
  days: MatrixDay[];
  rows: MatrixRow[];
  dayTotals: number[];
  totalMinutes: number;
  customers: CustomerOption[];
}

export type MonthlyMatrixOutcome = { ok: true; matrix: MonthlyMatrix } | { ok: false; reason: 'SELECTION_TOO_LARGE'; totalItems: number; max: number };

const ABSENCE_DAY_TYPES = new Set(['SICK_LEAVE', 'VACATION', 'UNPAID_LEAVE', 'OTHER']);

/** "2026-10" → true. Months before 2000 or after 2100 are rejected as typos. */
export function isValidMonth(value: string): boolean {
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  return year >= 2000 && year <= 2100 && month >= 1 && month <= 12;
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthRange(month: string): { startDate: string; endDate: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { startDate: `${month}-01`, endDate: `${month}-${String(last).padStart(2, '0')}` };
}

export function monthDays(month: string): MatrixDay[] {
  const { endDate } = monthRange(month);
  const count = Number(endDate.slice(8, 10));
  return Array.from({ length: count }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, '0')}`;
    const jsDay = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    const isoWeekday = jsDay === 0 ? 7 : jsDay;
    return { date, day: i + 1, isoWeekday, weekend: isoWeekday >= 6 };
  });
}

export function customerKeyOf(siteId: string, workAreaId: string | null): string {
  return `${siteId}:${workAreaId ?? 'none'}`;
}

/** Customer label: the work area (the customer the hours are billed to) at its site. */
function customerLabel(siteName: string, workAreaName: string | null): string {
  return workAreaName ? `${workAreaName} · ${siteName}` : siteName;
}

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return { firstName: full.trim(), lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

export interface AssignedWorker {
  employeeId: string;
  firstName: string;
  lastName: string;
  employeeNumber: string;
  customerKey: string;
  customerName: string;
}

export interface MatrixSliceInput {
  slice: WeeklyCustomerSliceRow;
  siteName: string;
  workAreaName: string | null;
}

/**
 * Pure: turns ledger slices into the month grid. `todayIso` (Helsinki calendar date) stops future
 * weekdays from being marked OFF. `names` (employeeId → first/last name) is optional; without it the
 * display name is split at the last space.
 */
export function buildMonthlyMatrix(
  month: string,
  inputs: MatrixSliceInput[],
  todayIso: string,
  names: Map<string, { firstName: string; lastName: string }> = new Map(),
  customerFilter: string | null = null,
  assigned: AssignedWorker[] = []
): MonthlyMatrix {
  const days = monthDays(month);
  const dayIndex = new Map(days.map((d, i) => [d.date, i]));
  const customers = new Map<string, string>();

  type Acc = { row: MatrixRow; activeDates: Set<string>; firstWorked: string | null; attached: boolean };
  const acc = new Map<string, Acc>();
  const ensureRow = (rowKey: string, employeeId: string, firstName: string, lastName: string, employeeNumber: string, customerKey: string, customerName: string): Acc => {
    let entry = acc.get(rowKey);
    if (!entry) {
      entry = {
        row: {
          key: rowKey,
          employeeId,
          lastName,
          firstName,
          employeeNumber,
          customerKey,
          customerName,
          cells: days.map((d) => ({ date: d.date, kind: d.weekend ? 'WEEKEND' : 'EMPTY', workedMinutes: 0, dayType: null, draft: false })),
          totalMinutes: 0
        },
        activeDates: new Set(),
        firstWorked: null,
        attached: false
      };
      acc.set(rowKey, entry);
    }
    return entry;
  };
  for (const worker of assigned) {
    customers.set(worker.customerKey, worker.customerName);
    if (customerFilter && worker.customerKey !== customerFilter) continue;
    ensureRow(`${worker.employeeId}|${worker.customerKey}`, worker.employeeId, worker.firstName, worker.lastName, worker.employeeNumber, worker.customerKey, worker.customerName).attached = true;
  }

  for (const { slice, siteName, workAreaName } of inputs) {
    const customerKey = customerKeyOf(slice.logicalKey.siteId, slice.logicalKey.workAreaId);
    const customerName = customerLabel(siteName, workAreaName);
    customers.set(customerKey, customerName);
    if (customerFilter && customerKey !== customerFilter) continue;

    const employeeId = slice.logicalKey.employeeId;
    const rowKey = `${employeeId}|${customerKey}`;
    const name = names.get(employeeId) ?? splitName(slice.employeeName);
    const entry = ensureRow(rowKey, employeeId, name.firstName, name.lastName, slice.employeeNumber, customerKey, customerName);

    const draft = slice.submissionState !== 'SUBMITTED';
    for (const day of slice.displayDays) {
      const i = dayIndex.get(day.date);
      if (i === undefined) continue; // the week overlaps the neighbouring month
      entry.activeDates.add(day.date);
      const cell = entry.row.cells[i];
      if (day.workedMinutes > 0) {
        cell.kind = 'WORK';
        cell.workedMinutes += day.workedMinutes;
        cell.draft = cell.draft || draft;
        cell.dayType = null;
        if (!entry.firstWorked || day.date < entry.firstWorked) entry.firstWorked = day.date;
      } else if (cell.kind !== 'WORK') {
        if (day.dayType === 'PUBLIC_HOLIDAY') { cell.kind = 'WEEKEND'; cell.dayType = day.dayType; }
        else if (!days[i].weekend && (ABSENCE_DAY_TYPES.has(day.dayType) || day.confirmedZero)) { cell.kind = 'OFF'; cell.dayType = day.dayType === 'WORK' ? null : day.dayType; }
      }
    }
  }

  // Weekdays with no hours inside an active week, from the first worked day until yesterday → OFF.
  for (const { row, activeDates, firstWorked } of acc.values()) {
    row.cells.forEach((cell, i) => {
      if (cell.kind === 'EMPTY' && !days[i].weekend && activeDates.has(cell.date) && firstWorked && cell.date >= firstWorked && cell.date < todayIso) cell.kind = 'OFF';
    });
    row.totalMinutes = row.cells.reduce((sum, c) => sum + c.workedMinutes, 0);
  }

  const rows = [...acc.values()].filter((a) => a.attached || a.row.totalMinutes > 0 || a.row.cells.some((c) => c.kind === 'OFF')).map((a) => a.row);
  rows.sort((a, b) => a.customerName.localeCompare(b.customerName) || a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName) || a.employeeNumber.localeCompare(b.employeeNumber));
  const dayTotals = days.map((_, i) => rows.reduce((sum, r) => sum + r.cells[i].workedMinutes, 0));
  return {
    month,
    days,
    rows,
    dayTotals,
    totalMinutes: dayTotals.reduce((a, b) => a + b, 0),
    customers: [...customers.entries()].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name))
  };
}

/** Hours as the customer's sheet shows them: "10", "7.5", "7.25". */
export function formatMatrixHours(minutes: number): string {
  if (minutes <= 0) return '';
  return String(Math.round((minutes / 60) * 100) / 100);
}

function ledgerQuery(month: string, siteId: string | null, workAreaId: string | 'none' | null): NormalizedTimeLedgerQuery {
  return {
    allTime: false,
    requestedRange: monthRange(month),
    employeeSearch: null,
    employeeId: null,
    workAreaId,
    siteId,
    status: 'all',
    onlyIssues: false,
    onlyChangedAfterApproval: false,
    submissionState: 'all',
    submissionSource: 'all',
    page: 1,
    pageSize: MONTHLY_MATRIX_MAX_SLICES + 1
  };
}

/** Assignments whose [validFrom, validTo) window overlaps the month — the workers attached to a customer. */
async function loadAssignedWorkers(month: string, filter: { siteId: string; workAreaId: string | null } | null, db: Db): Promise<Array<AssignedWorker & { siteId: string; workAreaId: string | null; siteName: string; workAreaName: string | null }>> {
  const { startDate, endDate } = monthRange(month);
  const rows = await db.siteAssignment.findMany({
    where: {
      validFrom: { lte: new Date(`${endDate}T00:00:00.000Z`) },
      OR: [{ validTo: null }, { validTo: { gt: new Date(`${startDate}T00:00:00.000Z`) } }],
      ...(filter ? { siteId: filter.siteId, workAreaId: filter.workAreaId } : {})
    },
    select: { employeeId: true, siteId: true, workAreaId: true, employee: { select: { firstName: true, lastName: true, employeeNumber: true } }, site: { select: { name: true } }, workArea: { select: { name: true } } }
  });
  return rows.map((r) => ({
    employeeId: r.employeeId,
    firstName: r.employee.firstName,
    lastName: r.employee.lastName,
    employeeNumber: r.employee.employeeNumber,
    customerKey: customerKeyOf(r.siteId, r.workAreaId),
    customerName: customerLabel(r.site.name, r.workArea?.name ?? null),
    siteId: r.siteId,
    workAreaId: r.workAreaId,
    siteName: r.site.name,
    workAreaName: r.workArea?.name ?? null
  }));
}

async function loadSlices(query: NormalizedTimeLedgerQuery, actor: LedgerActor, db: Db): Promise<{ ok: true; inputs: MatrixSliceInput[]; names: Map<string, { firstName: string; lastName: string }> } | { ok: false; reason: 'SELECTION_TOO_LARGE'; totalItems: number; max: number }> {
  const result = await getTimeLedger(query, actor, {}, db);
  if (result.pagination.totalItems > MONTHLY_MATRIX_MAX_SLICES) return { ok: false, reason: 'SELECTION_TOO_LARGE', totalItems: result.pagination.totalItems, max: MONTHLY_MATRIX_MAX_SLICES };
  const inputs: MatrixSliceInput[] = result.customerGroups.flatMap((g) => g.rows.map((slice) => ({ slice, siteName: g.siteName, workAreaName: g.workAreaName })));
  const employeeIds = [...new Set(inputs.map((i) => i.slice.logicalKey.employeeId))];
  const employees = employeeIds.length ? await db.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, firstName: true, lastName: true } }) : [];
  return { ok: true, inputs, names: new Map(employees.map((e) => [e.id, { firstName: e.firstName, lastName: e.lastName }])) };
}

export interface CustomerCard {
  key: string;
  siteId: string;
  workAreaId: string | null;
  siteName: string;
  workAreaName: string | null;
  peopleCount: number;
  workedMinutes: number;
}

export type CustomerCardsOutcome = { ok: true; cards: CustomerCard[]; totalMinutes: number } | { ok: false; reason: 'SELECTION_TOO_LARGE'; totalItems: number; max: number };

/**
 * Cards for /admin/timesheets-v2: every active customer (work area), plus any customer bucket with
 * attached workers or hours this month. People = attached workers ∪ workers with hours.
 */
export async function loadCustomerCards(month: string, actor: LedgerActor, todayIso: string, db: Db = prisma): Promise<CustomerCardsOutcome> {
  const [slices, assigned, workAreas] = await Promise.all([
    loadSlices(ledgerQuery(month, null, null), actor, db),
    loadAssignedWorkers(month, null, db),
    db.workArea.findMany({ where: { active: true }, select: { id: true, name: true, siteId: true, site: { select: { name: true } } } })
  ]);
  if (!slices.ok) return slices;
  const matrix = buildMonthlyMatrix(month, slices.inputs, todayIso, slices.names, null, assigned);
  const cards = new Map<string, CustomerCard & { people: Set<string> }>();
  const card = (siteId: string, workAreaId: string | null, siteName: string, workAreaName: string | null) => {
    const key = customerKeyOf(siteId, workAreaId);
    let c = cards.get(key);
    if (!c) { c = { key, siteId, workAreaId, siteName, workAreaName, peopleCount: 0, workedMinutes: 0, people: new Set() }; cards.set(key, c); }
    return c;
  };
  for (const w of workAreas) card(w.siteId, w.id, w.site.name, w.name);
  for (const a of assigned) card(a.siteId, a.workAreaId, a.siteName, a.workAreaName).people.add(a.employeeId);
  for (const { slice, siteName, workAreaName } of slices.inputs) card(slice.logicalKey.siteId, slice.logicalKey.workAreaId, siteName, workAreaName);
  for (const row of matrix.rows) {
    const c = cards.get(row.customerKey);
    if (!c) continue;
    c.workedMinutes += row.totalMinutes;
    if (row.totalMinutes > 0) c.people.add(row.employeeId);
  }
  const list = [...cards.values()].map(({ people, ...c }) => ({ ...c, peopleCount: people.size }));
  // Real customers first (A–Z), the per-site "no customer" buckets last.
  list.sort((a, b) => Number(a.workAreaName === null) - Number(b.workAreaName === null) || (a.workAreaName ?? '').localeCompare(b.workAreaName ?? '') || a.siteName.localeCompare(b.siteName));
  return { ok: true, cards: list, totalMinutes: matrix.totalMinutes };
}

/** One customer's month: attached workers + anyone with hours for it. */
export async function loadCustomerMonthMatrix(month: string, customer: { siteId: string; workAreaId: string | null }, actor: LedgerActor, todayIso: string, db: Db = prisma): Promise<MonthlyMatrixOutcome> {
  const [slices, assigned] = await Promise.all([
    loadSlices(ledgerQuery(month, customer.siteId, customer.workAreaId ?? 'none'), actor, db),
    loadAssignedWorkers(month, customer, db)
  ]);
  if (!slices.ok) return slices;
  return { ok: true, matrix: buildMonthlyMatrix(month, slices.inputs, todayIso, slices.names, customerKeyOf(customer.siteId, customer.workAreaId), assigned) };
}
