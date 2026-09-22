import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import type { SourceErrorRow } from '@/lib/reporting/time-ledger';

// UT4-B — SOURCE_ERROR must always be visible and never presented as 0 hours (explicit
// requirement). Always expanded by default — a real data error should not be one click away from
// invisible.
export function SourceErrorSection({ locale, rows }: { locale: AppLocale; rows: SourceErrorRow[] }) {
  return (
    <details className="ledger-section-details ledger-section-details-danger" open>
      <summary>
        {localeText(locale, 'Data errors', 'Ошибки данных')}: {rows.length}
      </summary>
      <ul className="ledger-plain-list">
        {rows.map((r) => (
          <li key={`${r.employeeId}:${r.timesheetId}`}>
            {r.employeeName} · #{r.employeeNumber} — {r.periodStartDate} – {r.periodEndDate}
            <span className="ledger-source-error-reason"> — {r.reason}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
