import { prisma } from '@/lib/prisma';
import { getForemanSiteIds } from '@/lib/foreman-review';

// T7A.9B — small server-only presentation helpers for the /admin and /foreman overview pages'
// period/site filter dropdowns. Deliberately separate from lib/attendance-overview.ts: these never
// touch the overview API contract (no new fields on OverviewResult), and never read anything a
// FOREMAN isn't already allowed to see (payroll period start/end/status; work site names — the same
// two entities already exposed by GET /api/admin/periods and GET /api/admin/sites for ADMIN, and by
// GET /api/foreman/review-scopes' own site names for FOREMAN). Bounded query count: exactly one
// query each, capped by PERIOD_OPTION_LIMIT — never grows with worker/timesheet count.

const PERIOD_OPTION_LIMIT = 50;

export interface PeriodOption {
  id: string;
  label: string;
  status: string;
}

export interface SiteOption {
  id: string;
  name: string;
}

function formatPeriodLabel(startDate: Date, endDate: Date, status: string): string {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return `${fmt(startDate)} – ${fmt(endDate)} · ${status}`;
}

/** Most recent periods first — bounded to PERIOD_OPTION_LIMIT, plenty for a dropdown without
 * scanning the whole table as PayrollPeriod grows over the life of the project. */
export async function listPeriodOptions(): Promise<PeriodOption[]> {
  const periods = await prisma.payrollPeriod.findMany({
    orderBy: { startDate: 'desc' },
    take: PERIOD_OPTION_LIMIT,
    select: { id: true, startDate: true, endDate: true, status: true }
  });
  return periods.map((p) => ({ id: p.id, label: formatPeriodLabel(p.startDate, p.endDate, p.status), status: p.status }));
}

/** ADMIN sees every site — same unrestricted scope as the overview endpoint itself for ADMIN. */
export async function listSiteOptionsForAdmin(): Promise<SiteOption[]> {
  const sites = await prisma.workSite.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } });
  return sites;
}

/** FOREMAN sees only their own current (not expired/future) ForemanAssignment sites — reuses the
 * exact same site-id resolution as the overview scope itself, so the dropdown can never offer a
 * site the actual query would then silently ignore. */
export async function listSiteOptionsForForeman(foremanUserId: string, today: Date): Promise<SiteOption[]> {
  const siteIds = await getForemanSiteIds(foremanUserId, today);
  if (siteIds.length === 0) {
    return [];
  }
  const sites = await prisma.workSite.findMany({ where: { id: { in: siteIds } }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
  return sites;
}
