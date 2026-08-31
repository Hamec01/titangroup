// docs/titanor-time/CUSTOMER_REPORT_SCOPE_PICKER_RU.md — the "site -> workers" scope model for the
// customer hours report (/admin/reports/customer). Read-only, set-based, bounded query count. Does
// NOT touch canonical worked-time, readiness levels, PDF/CSV, permissions or the schema — this is
// only about which workers are *offered* for selection and how the explicit ALL/PICK modes map back
// onto the existing export API (which encodes "all" as an absent siteIds/employeeIds list).

import { prisma as defaultPrisma } from '@/lib/prisma';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { resolveCanonicalSource } from '@/lib/reporting/canonical-source';

type PrismaLike = typeof defaultPrisma;

export type ScopeMode = 'ALL' | 'PICK' | 'NONE';

/** Result of parsing the customer-report URL params. `NONE` = the user has not made an explicit
 *  choice yet (neither "all" nor a concrete pick) — the report must stay blocked, never silently
 *  treated as "the whole company" (ТЗ §6). */
export interface CustomerReportScope {
  dateFrom: string | null;
  dateTo: string | null;
  customer: string;
  projectReference: string;
  siteMode: ScopeMode;
  siteIds: string[];
  workerMode: ScopeMode;
  workerIds: string[];
  /** Only meaningful when workerMode === 'ALL' — workers the user manually unticked. */
  workerExcludeIds: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toList(v: string | string[] | undefined | null): string[] {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .flatMap((x) => String(x).split(','))
    .map((s) => s.trim().toLowerCase())
    .filter((s) => UUID_PATTERN.test(s));
}

function one(v: string | string[] | undefined | null): string | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/** Lenient — unknown / malformed params are dropped, never an error. `siteIds` present wins over an
 *  absent `sites=all`; `sites=all` wins over an empty `siteIds`. */
export function parseCustomerReportScope(params: Record<string, string | string[] | undefined>): CustomerReportScope {
  const rawFrom = one(params.dateFrom);
  const rawTo = one(params.dateTo);
  const siteIds = Array.from(new Set(toList(params.siteIds)));
  const sitesAll = one(params.sites)?.toLowerCase() === 'all';
  const workerIds = Array.from(new Set(toList(params.workerIds)));
  const workersAll = one(params.workers)?.toLowerCase() === 'all';
  const workerExcludeIds = Array.from(new Set(toList(params.wx)));

  const siteMode: ScopeMode = siteIds.length > 0 ? 'PICK' : sitesAll ? 'ALL' : 'NONE';
  const workerMode: ScopeMode = workersAll ? 'ALL' : workerIds.length > 0 ? 'PICK' : 'NONE';

  return {
    dateFrom: rawFrom && DATE_RE.test(rawFrom) ? rawFrom : null,
    dateTo: rawTo && DATE_RE.test(rawTo) ? rawTo : null,
    customer: (one(params.customer) ?? '').slice(0, 200),
    projectReference: (one(params.projectReference) ?? '').slice(0, 200),
    siteMode,
    siteIds: siteMode === 'PICK' ? siteIds : [],
    workerMode,
    workerIds: workerMode === 'PICK' ? workerIds : [],
    workerExcludeIds: workerMode === 'ALL' ? workerExcludeIds : []
  };
}

export interface ScopeWorker {
  employeeId: string;
  firstName: string;
  lastName: string;
  employeeNumber: string;
  /** Which of the *selected* sites this worker relates to (empty in ALL-sites mode). */
  siteIds: string[];
  assigned: boolean;
  hasHours: boolean;
}

export interface ResolveScopeWorkersInput {
  siteMode: 'ALL' | 'PICK';
  /** Required when siteMode === 'PICK'. */
  siteIds: string[];
  /** YYYY-MM-DD (inclusive). */
  dateFrom: string;
  dateTo: string;
}

/**
 * Every worker who, for the selected sites and date range, is either assigned to one of the sites
 * (SiteAssignment window overlaps the range) OR has a canonical segment on one of the sites in the
 * range. Historical hours are never hidden because a current assignment has ended (`hasHours` does
 * not look at `validTo`). A worker on several selected sites appears once, with all their sites.
 *
 * Query count (independent of worker/site counts): periods, timesheets, workSegments,
 * draftSegments, siteAssignments, employees = 6. All `select`-narrowed, no per-row queries.
 */
export async function resolveCustomerScopeWorkers(input: ResolveScopeWorkersInput, client: PrismaLike = defaultPrisma): Promise<ScopeWorker[]> {
  const dateFrom = new Date(`${input.dateFrom}T00:00:00.000Z`);
  const dateTo = new Date(`${input.dateTo}T00:00:00.000Z`);
  const pickIds = input.siteMode === 'PICK' ? Array.from(new Set(input.siteIds.map((s) => s.toLowerCase()))).filter((s) => UUID_PATTERN.test(s)) : [];
  if (input.siteMode === 'PICK' && pickIds.length === 0) {
    return [];
  }
  const siteFilter = input.siteMode === 'PICK' ? { siteId: { in: pickIds } } : {};
  const dateFilter = { date: { gte: dateFrom, lte: dateTo } };

  const periods = await client.payrollPeriod.findMany({
    where: { startDate: { lte: dateTo }, endDate: { gte: dateFrom } },
    select: { id: true }
  });
  const periodIds = periods.map((p) => p.id);

  const timesheets = periodIds.length
    ? await client.timesheet.findMany({
        where: { periodId: { in: periodIds } },
        select: { id: true, employeeId: true, status: true, currentVersionId: true, draft: { select: { id: true } }, currentVersion: { select: { versionNumber: true, submissionSource: true } } }
      })
    : [];

  const versionIdToEmployee = new Map<string, string>();
  const draftIdToEmployee = new Map<string, string>();
  for (const t of timesheets) {
    const src = resolveCanonicalSource({ id: t.id, status: t.status, currentVersionId: t.currentVersionId, draft: t.draft, currentVersion: t.currentVersion });
    if (src.dataSource === 'DRAFT') draftIdToEmployee.set(src.draftId!, t.employeeId);
    else versionIdToEmployee.set(src.versionId!, t.employeeId);
  }
  const versionIds = [...versionIdToEmployee.keys()];
  const draftIds = [...draftIdToEmployee.keys()];

  const [versionSegs, draftSegs, assignments] = await Promise.all([
    versionIds.length
      ? client.workSegment.findMany({ where: { timesheetVersionId: { in: versionIds }, ...dateFilter, ...siteFilter }, select: { timesheetVersionId: true, siteId: true }, distinct: ['timesheetVersionId', 'siteId'] })
      : Promise.resolve([]),
    draftIds.length
      ? client.timesheetDraftSegment.findMany({ where: { draftId: { in: draftIds }, ...dateFilter, ...siteFilter }, select: { draftId: true, siteId: true }, distinct: ['draftId', 'siteId'] })
      : Promise.resolve([]),
    client.siteAssignment.findMany({
      where: { ...(input.siteMode === 'PICK' ? { siteId: { in: pickIds } } : {}), validFrom: { lte: dateTo }, OR: [{ validTo: null }, { validTo: { gte: dateFrom } }] },
      select: { employeeId: true, siteId: true },
      distinct: ['employeeId', 'siteId']
    })
  ]);

  // employeeId -> { assigned, hasHours, siteIds:Set }
  const acc = new Map<string, { assigned: boolean; hasHours: boolean; siteIds: Set<string> }>();
  const bump = (employeeId: string, siteId: string, kind: 'assigned' | 'hasHours') => {
    let e = acc.get(employeeId);
    if (!e) {
      e = { assigned: false, hasHours: false, siteIds: new Set() };
      acc.set(employeeId, e);
    }
    e[kind] = true;
    if (input.siteMode === 'PICK') e.siteIds.add(siteId);
  };
  for (const s of versionSegs) bump(versionIdToEmployee.get(s.timesheetVersionId)!, s.siteId, 'hasHours');
  for (const s of draftSegs) bump(draftIdToEmployee.get(s.draftId)!, s.siteId, 'hasHours');
  for (const a of assignments) bump(a.employeeId, a.siteId, 'assigned');

  if (acc.size === 0) return [];

  const employees = await client.employee.findMany({
    where: { id: { in: [...acc.keys()] } },
    select: { id: true, firstName: true, lastName: true, employeeNumber: true },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }]
  });

  return employees.map((e) => {
    const a = acc.get(e.id)!;
    return {
      employeeId: e.id,
      firstName: e.firstName,
      lastName: e.lastName,
      employeeNumber: e.employeeNumber,
      siteIds: [...a.siteIds],
      assigned: a.assigned,
      hasHours: a.hasHours
    };
  });
}

/**
 * Maps the explicit ALL/PICK scope onto the *existing* export API params (`siteIds` / `employeeIds`,
 * where an absent list means "all"). `scopeWorkerIds` is the full set of workers currently in scope
 * (from resolveCustomerScopeWorkers), used to expand an "all minus excludes" worker selection into a
 * concrete id list without ever putting hundreds of ids in the page URL.
 *
 * Returns null when the scope is not fully chosen yet (siteMode/workerMode === 'NONE' or missing
 * dates) — the caller must keep the report blocked.
 */
export function serializeScopeToExportParams(
  scope: CustomerReportScope,
  scopeWorkerIds: string[],
  extra: Record<string, string> = {}
): URLSearchParams | null {
  if (!scope.dateFrom || !scope.dateTo) return null;
  if (scope.siteMode === 'NONE' || scope.workerMode === 'NONE') return null;

  const p = new URLSearchParams();
  p.set('dateFrom', scope.dateFrom);
  p.set('dateTo', scope.dateTo);
  if (scope.customer.trim()) p.set('customer', scope.customer.trim());
  if (scope.projectReference.trim()) p.set('projectReference', scope.projectReference.trim());

  if (scope.siteMode === 'PICK') {
    if (scope.siteIds.length === 0) return null;
    for (const id of scope.siteIds) p.append('siteIds', id);
  }
  // siteMode ALL -> omit siteIds (backend "all sites")

  if (scope.workerMode === 'PICK') {
    if (scope.workerIds.length === 0) return null;
    for (const id of scope.workerIds) p.append('employeeIds', id);
  } else {
    // workerMode ALL
    const excluded = new Set(scope.workerExcludeIds);
    if (excluded.size === 0) {
      // ALL-in-scope with no manual removals:
      //  - sites ALL  -> omit employeeIds (backend "all workers")
      //  - sites PICK -> omit employeeIds (backend already returns all workers with hours on those sites)
    } else {
      const kept = scopeWorkerIds.filter((id) => !excluded.has(id));
      if (kept.length === 0) return null; // everyone removed -> nothing to report
      for (const id of kept) p.append('employeeIds', id);
    }
  }

  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p;
}
