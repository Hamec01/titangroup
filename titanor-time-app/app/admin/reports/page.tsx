import { redirect } from 'next/navigation';
import { AccessDeniedNotice } from '@/components/admin/AccessDeniedNotice';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { getPeriodTimeReport, parsePeriodReportQuery } from '@/lib/period-time-report';
import { getWorkerTimeReport } from '@/lib/worker-time-report';
import { getSiteTimeReport } from '@/lib/site-time-report';
import { listEmployeesForReportSelect } from '@/lib/users';
import { listPeriodOptions, listSiteOptionsForAdmin } from '@/lib/attendance-overview-lookups';
import { listReportFiles, parseReportFilesQuery } from '@/lib/report-files';
import { ReportsCommandCenter, type ReportsScreen, type ReportsView } from '@/components/reports/ReportsCommandCenter';
import { resolveAppLocale } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

// docs/titanor-time/REPORT_REDESIGN_PRODUCTION_READINESS_RU.md §2 + §3. The URL is the single
// source of truth: `view` (overview | worker | site | files) picks the tab, `periodId` /
// `employeeId` / `siteId` pick the subject, `page` / `filesPage` pick the pagination position.
// `view=worker` ignores `siteId` and `view=site` ignores `employeeId`, so the two subjects can
// never conflict. An unknown or malformed id renders a clear message — never a silent fallback to
// another screen. Every list (period sites, site workers, saved files) is really paginated.
const REQUIRED_PERMISSIONS = ['period.read.all', 'site.read.all', 'worker.read.all', 'timesheet.read.all', 'export.read'];
const VIEWS: ReportsView[] = ['overview', 'worker', 'site', 'files'];

type RouteParams = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function one(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

export default async function AdminReportsPage({ searchParams }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) redirect('/login');
  const locale = await resolveAppLocale();
  for (const permission of REQUIRED_PERMISSIONS) {
    if (!(await hasPermission(session.user.roles, permission))) {
      return <AccessDeniedNotice area="reports" locale={locale} permission={permission} />;
    }
  }

  const sp = await searchParams;
  const rawView = one(sp.view);
  const view: ReportsView = VIEWS.includes(rawView as ReportsView) ? (rawView as ReportsView) : 'overview';
  const rawPeriodId = one(sp.periodId);
  // view scopes which subject id is honoured — the other is dropped entirely (§2.7).
  const rawEmployeeId = view === 'worker' ? one(sp.employeeId) : null;
  const rawSiteId = view === 'site' ? one(sp.siteId) : null;
  const pageParsed = parsePeriodReportQuery({ page: one(sp.page), pageSize: null });
  const detailPage = pageParsed.ok ? pageParsed.page : 1;
  const detailPageSize = pageParsed.ok ? pageParsed.pageSize : 20;
  const filesParsed = parseReportFilesQuery({ page: one(sp.filesPage), pageSize: null });
  const filesPage = filesParsed.ok ? filesParsed.page : 1;

  const [periodOptions, employeeOptions, siteOptions] = await Promise.all([
    listPeriodOptions(),
    listEmployeesForReportSelect(),
    listSiteOptionsForAdmin()
  ]);

  // ── period resolution ────────────────────────────────────────────────────────────────────────
  let selectedPeriodId: string | null = null;
  let periodProblem: 'invalid' | 'not-found' | null = null;
  if (rawPeriodId !== null && rawPeriodId !== '') {
    if (!UUID_PATTERN.test(rawPeriodId)) periodProblem = 'invalid';
    else selectedPeriodId = rawPeriodId;
  } else {
    selectedPeriodId = periodOptions[0]?.id ?? null;
  }

  const selectedPeriodOption = periodOptions.find((p) => p.id === selectedPeriodId) ?? null;

  let screen: ReportsScreen;

  if (periodProblem === 'invalid') {
    screen = { kind: 'period-invalid' };
  } else if (selectedPeriodId === null) {
    screen = { kind: 'no-periods' };
  } else if (view === 'files') {
    const page = await listReportFiles({ periodId: selectedPeriodId, page: filesPage, pageSize: 10 });
    screen = { kind: 'files', filesPage: page };
  } else if (view === 'worker') {
    if (rawEmployeeId === null || rawEmployeeId === '') {
      screen = { kind: 'worker-picker' };
    } else if (!UUID_PATTERN.test(rawEmployeeId)) {
      screen = { kind: 'entity-invalid', entity: 'worker' };
    } else {
      const result = await getWorkerTimeReport(rawEmployeeId, selectedPeriodId);
      if (result.code === 'PERIOD_NOT_FOUND') screen = { kind: 'period-not-found' };
      else if (result.code === 'WORKER_NOT_FOUND') screen = { kind: 'entity-not-found', entity: 'worker' };
      else screen = { kind: 'worker', report: result.report };
    }
  } else if (view === 'site') {
    if (rawSiteId === null || rawSiteId === '') {
      screen = { kind: 'site-picker' };
    } else if (!UUID_PATTERN.test(rawSiteId)) {
      screen = { kind: 'entity-invalid', entity: 'site' };
    } else {
      const result = await getSiteTimeReport(rawSiteId, selectedPeriodId, { page: detailPage, pageSize: detailPageSize }, { kind: 'unrestricted' });
      if (result.code === 'PERIOD_NOT_FOUND') screen = { kind: 'period-not-found' };
      else if (result.code === 'SITE_NOT_FOUND' || result.code === 'SITE_REPORT_NOT_FOUND') screen = { kind: 'entity-not-found', entity: 'site' };
      else screen = { kind: 'site', report: result.report };
    }
  } else {
    const result = await getPeriodTimeReport(selectedPeriodId, { page: detailPage, pageSize: detailPageSize });
    if (result.code === 'PERIOD_NOT_FOUND') screen = { kind: 'period-not-found' };
    else screen = { kind: 'overview', report: result.report };
  }

  return (
    <ReportsCommandCenter
      locale={locale}
      view={view}
      periodOptions={periodOptions}
      employeeOptions={employeeOptions}
      siteOptions={siteOptions}
      selectedPeriodId={selectedPeriodId}
      selectedPeriodLabel={selectedPeriodOption?.label ?? null}
      selectedPeriodStatus={selectedPeriodOption?.status ?? null}
      selectedEmployeeId={rawEmployeeId}
      selectedSiteId={rawSiteId}
      detailPage={detailPage}
      filesPage={filesPage}
      screen={screen}
    />
  );
}
