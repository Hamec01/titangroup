import { AccessDeniedNotice } from '@/components/admin/AccessDeniedNotice';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { resolveAppLocale } from '@/lib/i18n/server';
import { listEmployeesForReportSelect } from '@/lib/users';
import { listSiteOptionsForAdmin } from '@/lib/attendance-overview-lookups';
import { AdminReportTabs } from '@/components/reports/AdminReportTabs';
import { CustomReportForm } from './CustomReportForm';

export const dynamic = 'force-dynamic';

// Part A — flexible time report export (task spec Part 2). New tab in the existing Reports/
// Export area (AdminReportTabs), reusing the same permission combination as GET
// /api/admin/reports/custom/export (worker.read.all + site.read.all + timesheet.read.all +
// export.read) so a user who can't hit the endpoint never sees a form for it.
const REQUIRED_PERMISSIONS = ['worker.read.all', 'site.read.all', 'timesheet.read.all', 'export.read'];

export default async function AdminCustomReportPage() {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();
  const ru = locale === 'RU';

  for (const permissionCode of REQUIRED_PERMISSIONS) {
    if (!(await hasPermission(session.user.roles, permissionCode))) {
      return (
        <AccessDeniedNotice area="reports" locale={locale} permission={permissionCode} />
      );
    }
  }

  const [employees, sites] = await Promise.all([listEmployeesForReportSelect(), listSiteOptionsForAdmin()]);

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{ru ? 'Произвольный отчёт по времени' : 'Custom time report'}</h1>
        <AdminReportTabs active="custom" locale={locale} />
        <p className="setup-subtitle">
          {ru
            ? 'Экспорт рабочего времени в PDF или CSV за произвольный период с выбором работников и объектов.'
            : 'Export worked time to PDF or CSV for an arbitrary date range, with worker and site selection.'}
        </p>

        <CustomReportForm
          employeeOptions={employees.map((e) => ({ id: e.id, label: `${e.lastName} ${e.firstName} (${e.employeeNumber})` }))}
          siteOptions={sites.map((s) => ({ id: s.id, label: s.name }))}
          locale={locale}
        />
      </div>
    </main>
  );
}
