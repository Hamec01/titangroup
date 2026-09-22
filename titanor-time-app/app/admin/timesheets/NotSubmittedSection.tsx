import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import type { NotSubmittedRow } from '@/lib/reporting/time-ledger';

// UT4-B — TZ §5.3: "Ещё не сдали" is its own section, opened by the summary counter or simply
// scrolled to, never rendered as a fake 0h row inside a customer group.
export function NotSubmittedSection({ locale, rows }: { locale: AppLocale; rows: NotSubmittedRow[] }) {
  return (
    <details className="ledger-section-details" open>
      <summary>
        {localeText(locale, 'Not submitted yet', 'Ещё не сдали')}: {rows.length}
      </summary>
      <ul className="ledger-plain-list">
        {rows.map((r) => (
          <li key={`${r.employeeId}:${r.periodId}`}>
            {r.employeeName} · #{r.employeeNumber} — {r.periodStartDate} – {r.periodEndDate}
          </li>
        ))}
      </ul>
    </details>
  );
}
