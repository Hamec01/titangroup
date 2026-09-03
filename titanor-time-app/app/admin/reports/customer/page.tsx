import { AccessDeniedNotice } from '@/components/admin/AccessDeniedNotice';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { resolveAppLocale } from '@/lib/i18n/server';
import { AdminReportTabs } from '@/components/reports/AdminReportTabs';
import { CustomerHoursForm } from './CustomerHoursForm';

export const dynamic = 'force-dynamic';

// R15-D7 Deploy F — "Часы заказчику". Pick real customers (WorkAreas), workers, a date range;
// preview; download a PDF/CSV scoped to those customers only. Same permission set as the export.
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
      return <AccessDeniedNotice area="reports" locale={locale} permission={permissionCode} />;
    }
  }

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>{ru ? 'Часы заказчику' : 'Customer working hours'}</h1>
        <AdminReportTabs active="customer" locale={locale} />
        <p className="setup-subtitle">
          {ru
            ? 'Документ заказчику: часы по выбранному заказчику (WorkArea) за период. Часы разных заказчиков одного объекта не смешиваются. Без зарплат, ставок, GPS и TES.'
            : 'A document for the customer: hours for the selected customer(s) (WorkArea) over a period. Hours of different customers on the same site are never mixed. No salary, rates, GPS or TES.'}
        </p>
        <CustomerHoursForm locale={locale} />
      </div>
    </main>
  );
}
