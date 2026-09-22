import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import type { TimeLedgerResult } from '@/lib/reporting/time-ledger';
import { formatWorkedDuration } from '@/lib/reporting/report-format';
import type { TimeLedgerUiState } from '@/lib/reporting/time-ledger-ui-query';

// UT4-B — the EXACT global summary from the API response, point 3 of the fixup: this component
// only ever reads `summary` (a single object from the server), never sums the currently rendered
// rows. TZ §5.3: no separate always-visible "not yet submitted"/"errors" column — those open via
// clicking their own counter instead.
export function LedgerSummaryStrip({
  locale,
  summary,
  state,
  onNavigate
}: {
  locale: AppLocale;
  summary: TimeLedgerResult['summary'];
  state: TimeLedgerUiState;
  onNavigate: (changes: Partial<TimeLedgerUiState>) => void;
}) {
  return (
    <div className="ledger-summary-strip">
      <span className="ledger-summary-item">
        <strong>{summary.workerCount}</strong> {localeText(locale, 'workers', 'работников')}
      </span>
      <span className="ledger-summary-item">
        <strong>{formatWorkedDuration(summary.workedMinutes, locale)}</strong>
      </span>
      <span className="ledger-summary-item ledger-summary-tone-neutral">
        {localeText(locale, 'Ready', 'Готово')}: <strong>{summary.readyCount}</strong>
      </span>
      <span className="ledger-summary-item ledger-summary-tone-warning">
        {localeText(locale, 'Needs attention', 'Требует внимания')}: <strong>{summary.needsAttentionCount}</strong>
      </span>
      <span className="ledger-summary-item ledger-summary-tone-success">
        {localeText(locale, 'Approved', 'Подтверждено')}: <strong>{summary.approvedCount}</strong>
      </span>
      <span className="ledger-summary-item ledger-summary-tone-warning">
        {localeText(locale, 'Changed', 'Изменено')}: <strong>{summary.changedAfterApprovalCount}</strong>
      </span>
      <button type="button" className="ledger-summary-item ledger-summary-button" onClick={() => onNavigate({ status: 'not_submitted', page: 1 })} disabled={state.status === 'not_submitted'}>
        {localeText(locale, 'Not submitted', 'Ещё не сдали')}: <strong>{summary.notSubmittedEntryCount}</strong>
      </button>
      {summary.sourceErrorCount > 0 && (
        <button type="button" className="ledger-summary-item ledger-summary-button ledger-summary-tone-danger" onClick={() => onNavigate({ status: 'source_error', page: 1 })} disabled={state.status === 'source_error'}>
          {localeText(locale, 'Data errors', 'Ошибки данных')}: <strong>{summary.sourceErrorCount}</strong>
        </button>
      )}
    </div>
  );
}
