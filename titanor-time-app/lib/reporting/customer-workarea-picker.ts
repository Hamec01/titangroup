import { prisma as defaultPrisma } from '@/lib/prisma';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';

// R15-D7 Deploy F — the customer picker for /admin/reports/customer. Replaces the free-text
// `customer` field and the site/worker scope: the admin picks one or more REAL WorkAreas (searchable
// by customer name AND site name), each rendered "Aros Marine — Meyer Turku Shipyard". Active AND
// disabled customers are offered (old hours must stay reportable). An internal-only
// "Без указанного заказчика" pseudo-option (workAreaId IS NULL) exists for checks but a client PDF
// can never be produced from it.

type PrismaLike = typeof defaultPrisma;

export const NO_CUSTOMER_TOKEN = 'none';

export interface CustomerWorkAreaOption {
  workAreaId: string;
  workAreaName: string;
  siteId: string;
  siteName: string;
  active: boolean;
  /** "Aros Marine — Meyer Turku Shipyard" */
  label: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function one(v: string | string[] | undefined | null): string | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}
function idList(v: string | string[] | undefined | null): string[] {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return Array.from(
    new Set(
      arr
        .flatMap((x) => String(x).split(','))
        .map((s) => s.trim().toLowerCase())
        .filter((s) => UUID_PATTERN.test(s))
    )
  );
}

export interface CustomerReportSelection {
  dateFrom: string | null;
  dateTo: string | null;
  workAreaIds: string[];
  includeNoCustomer: boolean;
  /** WORKERS mode: PICK a subset, or ALL (every worker in the customer scope). */
  workerMode: 'ALL' | 'PICK';
  workerIds: string[];
}

/** URL is the source of truth (§ persist across reload + Back/Forward). Lenient: bad params dropped. */
export function parseCustomerReportSelection(params: Record<string, string | string[] | undefined>): CustomerReportSelection {
  const from = one(params.dateFrom);
  const to = one(params.dateTo);
  const waIds = idList(params.waIds);
  const includeNoCustomer = one(params.noCustomer) === '1';
  const workerIds = idList(params.workerIds);
  const workersAll = one(params.workers)?.toLowerCase() === 'all';
  return {
    dateFrom: from && DATE_RE.test(from) ? from : null,
    dateTo: to && DATE_RE.test(to) ? to : null,
    workAreaIds: waIds,
    includeNoCustomer,
    workerMode: workerIds.length > 0 && !workersAll ? 'PICK' : 'ALL',
    workerIds: workersAll ? [] : workerIds
  };
}

export function serializeCustomerReportSelection(sel: CustomerReportSelection): URLSearchParams {
  const p = new URLSearchParams();
  if (sel.dateFrom) p.set('dateFrom', sel.dateFrom);
  if (sel.dateTo) p.set('dateTo', sel.dateTo);
  if (sel.workAreaIds.length) p.set('waIds', sel.workAreaIds.join(','));
  if (sel.includeNoCustomer) p.set('noCustomer', '1');
  if (sel.workerMode === 'PICK' && sel.workerIds.length) p.set('workerIds', sel.workerIds.join(','));
  else if (sel.workerMode === 'ALL') p.set('workers', 'all');
  return p;
}

/**
 * WorkAreas matching `query` on customer name OR site name (case-insensitive substring). Empty query
 * → the first `limit` customers, active first then by site + name. Disabled customers are included.
 */
export async function searchCustomerWorkAreas(
  query: string,
  opts: { limit?: number } = {},
  client: PrismaLike = defaultPrisma
): Promise<CustomerWorkAreaOption[]> {
  const q = query.trim().slice(0, 120);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = q
    ? {
        OR: [
          { name: { contains: q, mode: 'insensitive' as const } },
          { site: { name: { contains: q, mode: 'insensitive' as const } } }
        ]
      }
    : {};
  const rows = await client.workArea.findMany({
    where,
    select: { id: true, name: true, active: true, siteId: true, site: { select: { name: true } } },
    orderBy: [{ active: 'desc' }, { site: { name: 'asc' } }, { name: 'asc' }],
    take: limit
  });
  return rows.map((r) => ({
    workAreaId: r.id,
    workAreaName: r.name,
    siteId: r.siteId,
    siteName: r.site.name,
    active: r.active,
    label: `${r.name} — ${r.site.name}`
  }));
}

/** Resolve the labels for a concrete id list (for showing the current selection without a search). */
export async function resolveCustomerWorkAreaOptions(
  workAreaIds: string[],
  client: PrismaLike = defaultPrisma
): Promise<CustomerWorkAreaOption[]> {
  const ids = Array.from(new Set(workAreaIds.filter((s) => UUID_PATTERN.test(s))));
  if (ids.length === 0) return [];
  const rows = await client.workArea.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, active: true, siteId: true, site: { select: { name: true } } }
  });
  return rows.map((r) => ({
    workAreaId: r.id,
    workAreaName: r.name,
    siteId: r.siteId,
    siteName: r.site.name,
    active: r.active,
    label: `${r.name} — ${r.site.name}`
  }));
}
