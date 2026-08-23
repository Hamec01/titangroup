import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { getPeriodTimeReport, parsePeriodReportQuery, isValidPeriodId } from '@/lib/period-time-report';
import { listPeriodOptions } from '@/lib/attendance-overview-lookups';
import { PeriodTimeReportView, type PeriodReportOutcome, type RawPeriodReportFilters } from '@/components/reports/PeriodTimeReportView';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText } from '@/lib/i18n/locale';

export const dynamic = 'force-dynamic';

const BASE_PATH = '/admin/reports/periods';
const REQUIRED_PERMISSIONS = ['period.read.all', 'site.read.all', 'worker.read.all', 'timesheet.read.all'];

type RouteParams = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function one(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.3B" §AB — thin Server Component wrapper.
// Calls getPeriodTimeReport() directly (no HTTP self-fetch), the exact same function the
// /api/admin/reports/periods/:periodId route calls.
export default async function AdminPeriodReportsPage({ searchParams }: RouteParams) {
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
  const rawFilters: RawPeriodReportFilters = { periodId: one(sp.periodId), page: one(sp.page), pageSize: one(sp.pageSize) };
  const noFiltersAtAll = !rawFilters.periodId && !rawFilters.page && !rawFilters.pageSize;

  let outcome: PeriodReportOutcome;
  if (noFiltersAtAll) {
    outcome = { kind: 'prompt' };
  } else {
    const parsedQuery = parsePeriodReportQuery({ page: rawFilters.page, pageSize: rawFilters.pageSize });
    const fieldErrors: Record<string, string[]> = !parsedQuery.ok ? { ...parsedQuery.fieldErrors } : {};
    if (!rawFilters.periodId || !isValidPeriodId(rawFilters.periodId)) {
      fieldErrors.periodId = ['must be a UUID'];
    }
    if (Object.keys(fieldErrors).length > 0) {
      outcome = { kind: 'invalid', fieldErrors };
    } else {
      const parsedOk = parsedQuery as { ok: true; page: number; pageSize: number };
      const result = await getPeriodTimeReport(rawFilters.periodId as string, { page: parsedOk.page, pageSize: parsedOk.pageSize });
      outcome = result.code === 'PERIOD_NOT_FOUND' ? { kind: 'period-not-found' } : { kind: 'ok', report: result.report };
    }
  }

  const periodOptions = await listPeriodOptions();

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <PeriodTimeReportView basePath={BASE_PATH} rawFilters={rawFilters} periodOptions={periodOptions} outcome={outcome} locale={locale} />
      </div>
    </main>
  );
}
