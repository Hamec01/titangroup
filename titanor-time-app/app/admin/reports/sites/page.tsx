import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { getSiteTimeReport, parseSiteReportQuery } from '@/lib/site-time-report';
import { listSiteOptionsForAdmin, listPeriodOptions } from '@/lib/attendance-overview-lookups';
import { SiteTimeReportView, type SiteReportOutcome, type RawSiteReportFilters } from '@/components/reports/SiteTimeReportView';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

const BASE_PATH = '/admin/reports/sites';
const REQUIRED_PERMISSIONS = ['site.read.all', 'period.read.all', 'timesheet.read.all'];

type RouteParams = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function one(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.2B" §J/§K — thin Server Component wrapper.
// Calls getSiteTimeReport() directly (no HTTP self-fetch), the exact same function the
// /api/admin/reports/sites/:siteId route calls, with an unrestricted scope.
export default async function AdminSiteReportsPage({ searchParams }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();

  for (const permissionCode of REQUIRED_PERMISSIONS) {
    if (!(await hasPermission(session.user.roles, permissionCode))) {
      return (
        <main className="setup-page">
          <p className="login-error" role="alert">
            {localeText(locale, `Access denied — this page requires the ${permissionCode} permission.`, `Доступ запрещён — для этой страницы требуется право ${permissionCode}.`)}
          </p>
        </main>
      );
    }
  }

  const sp = await searchParams;
  const rawFilters: RawSiteReportFilters = { siteId: one(sp.siteId), periodId: one(sp.periodId), page: one(sp.page), pageSize: one(sp.pageSize) };
  const noFiltersAtAll = !rawFilters.siteId && !rawFilters.periodId && !rawFilters.page && !rawFilters.pageSize;

  let outcome: SiteReportOutcome;
  if (noFiltersAtAll) {
    outcome = { kind: 'prompt' };
  } else {
    const parsed = parseSiteReportQuery(rawFilters);
    if (!parsed.ok) {
      outcome = { kind: 'invalid', fieldErrors: parsed.fieldErrors };
    } else {
      const result = await getSiteTimeReport(parsed.siteId, parsed.periodId, { page: parsed.page, pageSize: parsed.pageSize }, { kind: 'unrestricted' });
      if (result.code === 'SITE_NOT_FOUND' || result.code === 'SITE_REPORT_NOT_FOUND') {
        outcome = { kind: 'site-not-found' };
      } else if (result.code === 'PERIOD_NOT_FOUND') {
        outcome = { kind: 'period-not-found' };
      } else {
        outcome = { kind: 'ok', report: result.report };
      }
    }
  }

  const [siteOptions, periodOptions] = await Promise.all([listSiteOptionsForAdmin(), listPeriodOptions()]);

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <SiteTimeReportView role="admin" basePath={BASE_PATH} rawFilters={rawFilters} siteOptions={siteOptions} periodOptions={periodOptions} outcome={outcome} locale={locale} />
      </div>
    </main>
  );
}
