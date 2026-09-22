import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import type { TimeLedgerResult } from '@/lib/reporting/time-ledger';
import type { TimeLedgerUiState } from '@/lib/reporting/time-ledger-ui-query';

// UT4-B — always carries every current filter/range param, only `page` changes (point: "page 2
// сохраняет фильтры"), via the same onNavigate() the rest of the page uses.
export function LedgerPagination({
  locale,
  pagination,
  onNavigate
}: {
  locale: AppLocale;
  pagination: TimeLedgerResult['pagination'];
  onNavigate: (changes: Partial<TimeLedgerUiState>) => void;
}) {
  if (pagination.totalPages <= 1) return null;

  return (
    <nav className="ledger-pagination" aria-label={localeText(locale, 'Pagination', 'Постраничная навигация')}>
      <button type="button" disabled={pagination.page <= 1} onClick={() => onNavigate({ page: pagination.page - 1 })}>
        {localeText(locale, 'Previous', 'Назад')}
      </button>
      <span>
        {localeText(locale, 'Page', 'Страница')} {pagination.page} / {pagination.totalPages}
      </span>
      <button type="button" disabled={pagination.page >= pagination.totalPages} onClick={() => onNavigate({ page: pagination.page + 1 })}>
        {localeText(locale, 'Next', 'Далее')}
      </button>
    </nav>
  );
}
