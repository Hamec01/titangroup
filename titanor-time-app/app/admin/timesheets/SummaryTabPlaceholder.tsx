import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';

// UT4-B — an honest placeholder (TZ agreement: "Сводка — честный placeholder", no fake numbers).
// The real Сводка tab is UT9.
export function SummaryTabPlaceholder({ locale }: { locale: AppLocale }) {
  return (
    <p className="wk-empty" role="status">
      {localeText(locale, 'The summary tab will be available in a later update.', 'Вкладка «Сводка» будет доступна позже.')}
    </p>
  );
}
