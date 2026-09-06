import { redirect } from 'next/navigation';
import { AccessDeniedNotice } from '@/components/admin/AccessDeniedNotice';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { getPeriodTimeReport } from '@/lib/period-time-report';
import { getWorkerTimeReport } from '@/lib/worker-time-report';
import { getSiteTimeReport } from '@/lib/site-time-report';
import { listEmployeesForReportSelect, type ReportSelectableEmployee } from '@/lib/users';
import { listPeriodOptions, listSiteOptionsForAdmin } from '@/lib/attendance-overview-lookups';
import { listReportFiles } from '@/lib/report-files';
import { ReportsCommandCenter } from '@/components/reports/ReportsCommandCenter';
import { resolveAppLocale } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

const REQUIRED_PERMISSIONS = ['period.read.all', 'site.read.all', 'worker.read.all', 'timesheet.read.all', 'export.read'];
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
    if (!(await hasPermission(session.user.roles, permission))) return <AccessDeniedNotice area="reports" locale={locale} permission={permission} />;
  }

  const sp = await searchParams;
  const requestedPeriodId = one(sp.periodId);
  const selectedEmployeeId = one(sp.employeeId);
  const selectedSiteId = one(sp.siteId);
  const view = one(sp.view) ?? 'overview';
  const [periodOptions, employeeOptions, siteOptions] = await Promise.all([listPeriodOptions(), listEmployeesForReportSelect(), listSiteOptionsForAdmin()]);
  const selectedPeriodId = requestedPeriodId && UUID_PATTERN.test(requestedPeriodId) ? requestedPeriodId : periodOptions[0]?.id ?? null;

  let periodReport = null;
  let workerReport = null;
  let siteReport = null;
  if (selectedPeriodId) {
    const periodResult = await getPeriodTimeReport(selectedPeriodId, { page: 1, pageSize: 100 });
    if (periodResult.code === 'OK') periodReport = periodResult.report;
    if (selectedEmployeeId && UUID_PATTERN.test(selectedEmployeeId)) {
      const result = await getWorkerTimeReport(selectedEmployeeId, selectedPeriodId);
      if (result.code === 'OK') workerReport = result.report;
    }
    if (selectedSiteId && UUID_PATTERN.test(selectedSiteId)) {
      const result = await getSiteTimeReport(selectedSiteId, selectedPeriodId, { page: 1, pageSize: 100 }, { kind: 'unrestricted' });
      if (result.code === 'OK') siteReport = result.report;
    }
  }

  const files = await listReportFiles(selectedPeriodId ?? undefined);
  return <ReportsCommandCenter locale={locale} periodOptions={periodOptions} employeeOptions={employeeOptions as ReportSelectableEmployee[]} siteOptions={siteOptions} selectedPeriodId={selectedPeriodId} selectedEmployeeId={selectedEmployeeId} selectedSiteId={selectedSiteId} view={view} periodReport={periodReport} workerReport={workerReport} siteReport={siteReport} files={files} />;
}
