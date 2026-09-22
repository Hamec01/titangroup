import Link from 'next/link';
import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import { uiStateToHref, type TimeLedgerUiState } from '@/lib/reporting/time-ledger-ui-query';

// UT4-B — plain <Link> tabs, no client JS, matching the dominant admin-section convention
// (app/admin/reports/page.tsx's own `view` tab pattern). Switching tabs preserves every other
// filter/range param — only `view` changes.
export function TimesheetsTabs({ locale, state }: { locale: AppLocale; state: TimeLedgerUiState }) {
  const tableHref = uiStateToHref('/admin/timesheets', { ...state, view: 'table', page: 1 });
  const summaryHref = uiStateToHref('/admin/timesheets', { ...state, view: 'summary', page: 1 });

  return (
    <nav className="ledger-tabs" aria-label={localeText(locale, 'Timesheets sections', 'Разделы табеля')}>
      {state.view === 'table' ? (
        <span className="ledger-tab is-current" aria-current="page">
          {localeText(locale, 'Timesheet', 'Табель')}
        </span>
      ) : (
        <Link href={tableHref} className="ledger-tab">
          {localeText(locale, 'Timesheet', 'Табель')}
        </Link>
      )}
      {state.view === 'summary' ? (
        <span className="ledger-tab is-current" aria-current="page">
          {localeText(locale, 'Summary', 'Сводка')}
        </span>
      ) : (
        <Link href={summaryHref} className="ledger-tab">
          {localeText(locale, 'Summary', 'Сводка')}
        </Link>
      )}
    </nav>
  );
}
