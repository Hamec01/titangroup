import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { resolveAppLocale } from '@/lib/i18n/server';
import { localeText } from '@/lib/i18n/locale';
import { listEmployeesForReportSelect } from '@/lib/users';
import { listSiteOptionsForAdmin } from '@/lib/attendance-overview-lookups';
import { AdminReportTabs } from '@/components/reports/AdminReportTabs';
import { CustomerHoursForm } from './CustomerHoursForm';

export const dynamic = 'force-dynamic';

// T13.11 — Customer Project Working Hours. Same permission set as the custom report endpoint.
const REQUIRED_PERMISSIONS = ['worker.read.all', 'site.read.all', 'timesheet.read.all', 'export.read'];

export default async function AdminCustomerHoursPage() {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }
  const locale = await resolveAppLocale();
  const ru = locale === 'RU';

  for (const permissionCode of REQUIRED_PERMISSIONS) {
    if (!(await hasPermission(session.user.roles, permissionCode))) {
      return (
        <main className="setup-page">
          <p className="login-error" role="alert">
            {localeText(locale, `Access denied — this page requires the ${permissionCode} permission.`, `Доступ запрещён — требуется право ${permissionCode}.`)}
          </p>
        </main>
      );
    }
  }

  const [employees, sites] = await Promise.all([listEmployeesForReportSelect(), listSiteOptionsForAdmin()]);

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{ru ? 'Часы заказчику по объекту' : 'Customer project working hours'}</h1>
        <AdminReportTabs active="customer" locale={locale} />
        <p className="setup-subtitle">
          {ru
            ? 'Документ заказчику: подтверждённые (окончательно одобренные) часы по объекту за период. Без зарплат, ставок и TES.'
            : 'A document for the customer: confirmed (final-approved) hours by site for a date range. No salary, rates or TES.'}
        </p>
        <CustomerHoursForm
          employeeOptions={employees.map((e) => ({ id: e.id, label: `${e.lastName} ${e.firstName} (${e.employeeNumber})` }))}
          siteOptions={sites.map((s) => ({ id: s.id, label: s.name }))}
          locale={locale}
        />
      </div>
    </main>
  );
}
