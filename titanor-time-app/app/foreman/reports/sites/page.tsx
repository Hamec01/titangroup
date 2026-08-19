import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { helsinkiToday } from '@/lib/workers';
import { getSiteTimeReport, parseSiteReportQuery } from '@/lib/site-time-report';
import { listSiteOptionsForForeman, listPeriodOptions } from '@/lib/attendance-overview-lookups';
import { SiteTimeReportView, type SiteReportOutcome, type RawSiteReportFilters } from '@/components/reports/SiteTimeReportView';

export const dynamic = 'force-dynamic';

const BASE_PATH = '/foreman/reports/sites';
const REQUIRED_PERMISSIONS = ['site.read.assigned', 'period.read.assigned', 'timesheet.read.assigned'];

type RouteParams = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function one(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.2B" §J/§K/§L — thin Server Component
// wrapper. Scope is recomputed inside getSiteTimeReport()'s own transaction on every request (§B
// of the T8.2A addendum) — this page never pre-checks scope itself, only the lookup list below is
// pre-filtered for the select box.
export default async function ForemanSiteReportsPage({ searchParams }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }

  for (const permissionCode of REQUIRED_PERMISSIONS) {
    if (!(await hasPermission(session.user.roles, permissionCode))) {
      return (
        <main className="setup-page">
          <p className="login-error" role="alert">
            Access denied — this page requires the {permissionCode} permission.
          </p>
        </main>
      );
    }
  }

  const sp = await searchParams;
  const rawFilters: RawSiteReportFilters = { siteId: one(sp.siteId), periodId: one(sp.periodId), page: one(sp.page), pageSize: one(sp.pageSize) };
  const noFiltersAtAll = !rawFilters.siteId && !rawFilters.periodId && !rawFilters.page && !rawFilters.pageSize;
  const today = helsinkiToday();

  let outcome: SiteReportOutcome;
  if (noFiltersAtAll) {
    outcome = { kind: 'prompt' };
  } else {
    const parsed = parseSiteReportQuery(rawFilters);
    if (!parsed.ok) {
      outcome = { kind: 'invalid', fieldErrors: parsed.fieldErrors };
    } else {
      const result = await getSiteTimeReport(parsed.siteId, parsed.periodId, { page: parsed.page, pageSize: parsed.pageSize }, { kind: 'foreman', foremanUserId: session.user.id, today });
      if (result.code === 'SITE_NOT_FOUND' || result.code === 'SITE_REPORT_NOT_FOUND') {
        outcome = { kind: 'site-not-found' };
      } else if (result.code === 'PERIOD_NOT_FOUND') {
        outcome = { kind: 'period-not-found' };
      } else {
        outcome = { kind: 'ok', report: result.report };
      }
    }
  }

  const [siteOptions, periodOptions] = await Promise.all([listSiteOptionsForForeman(session.user.id, today), listPeriodOptions()]);

  return (
    <main className="wk-page">
      <div className="setup-card worker-card">
        <SiteTimeReportView role="foreman" basePath={BASE_PATH} rawFilters={rawFilters} siteOptions={siteOptions} periodOptions={periodOptions} outcome={outcome} />
      </div>
    </main>
  );
}
