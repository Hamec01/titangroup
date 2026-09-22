import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import type { CustomerGroup } from '@/lib/reporting/time-ledger';
import { formatWorkedDuration } from '@/lib/reporting/report-format';
import { noCustomerGroupLabel } from '@/lib/reporting/ledger-ui-text';
import { WorkerSliceRow } from './WorkerSliceRow';

// UT4-B point 3 — the API never returns a global total per customer group (only global summary +
// the current page's rows), so this heading explicitly labels its number as page-scoped ("На этой
// странице: …") rather than presenting a page subtotal as if it were the customer's full total.
export function CustomerGroupSection({ locale, group }: { locale: AppLocale; group: CustomerGroup }) {
  const distinctWorkers = new Set(group.rows.map((r) => r.logicalKey.employeeId)).size;
  const pageMinutes = group.rows.reduce((sum, r) => sum + r.workedMinutes, 0);
  const title = group.workAreaId === null ? noCustomerGroupLabel(locale) : `${group.workAreaName ?? group.workAreaId} · ${group.siteName}`;

  return (
    <section className="ledger-group">
      <h2 className="ledger-group-title">{title}</h2>
      <p className="ledger-group-subtotal">
        {localeText(locale, 'On this page', 'На этой странице')}: {distinctWorkers} {localeText(locale, 'workers', 'работников')} · {formatWorkedDuration(pageMinutes, locale)}
      </p>
      <ul className="ledger-row-list">
        {group.rows.map((row) => (
          <li key={`${row.logicalKey.timesheetId}:${row.logicalKey.siteId}:${row.logicalKey.workAreaId ?? ''}:${row.logicalKey.weekStart}`}>
            <WorkerSliceRow locale={locale} row={row} />
          </li>
        ))}
      </ul>
    </section>
  );
}
