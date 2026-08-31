import { AccessDeniedNotice } from '@/components/admin/AccessDeniedNotice';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { hasPermission } from '@/lib/permissions';
import { resolveAppLocale } from '@/lib/i18n/server';
import { listSiteOptionsForAdmin } from '@/lib/attendance-overview-lookups';
import { parseCustomerReportScope } from '@/lib/reporting/customer-report-scope';
import { AdminReportTabs } from '@/components/reports/AdminReportTabs';
import { CustomerHoursForm } from './CustomerHoursForm';

export const dynamic = 'force-dynamic';

// T13.11 — Customer Project Working Hours. Same permission set as the custom report endpoint.
const REQUIRED_PERMISSIONS = ['worker.read.all', 'site.read.all', 'timesheet.read.all', 'export.read'];

type RouteParams = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function AdminCustomerHoursPage({ searchParams }: RouteParams) {
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

  const sp = await searchParams;
  // CUSTOMER_REPORT_SCOPE_PICKER_RU.md §4 — the URL is the source of truth. The site list is small
  // and bounded; the worker list is fetched by the client from /api/admin/reports/customer/scope
  // once dates + sites are chosen (it depends on the date range).
  const sites = await listSiteOptionsForAdmin();
  const initial = parseCustomerReportScope(sp);

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
        <CustomerHoursForm allSites={sites} initial={initial} locale={locale} />
      </div>
    </main>
  );
}
