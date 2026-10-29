import { localeText } from '@/lib/i18n/locale';
import { formatMatrixHours, loadCustomerCards } from '@/lib/reporting/monthly-matrix';
import { resolveTimesheetsV2Context } from './admin-gate';
import { MonthPicker, monthTitle } from './MonthMatrixTable';
import { TimesheetV2Cards } from './TimesheetV2Cards';

export const dynamic = 'force-dynamic';

// Табель v2 — step 1: one card per customer (work area) for the chosen month: name, how many
// workers are attached / worked, hours so far. A card opens that customer's month grid.
type RouteParams = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function TimesheetsV2Page({ searchParams }: RouteParams) {
  const sp = await searchParams;
  const ctx = await resolveTimesheetsV2Context(sp.month);
  if (!ctx.ok) {
    return <main className="setup-page"><p className="login-error" role="alert">{ctx.message}</p></main>;
  }
  const { locale, month } = ctx;
  const outcome = await loadCustomerCards(month, ctx.actor, ctx.todayIso);

  return (
    <main className="setup-page">
      <div className="setup-card worker-card ledger-card month-matrix-card">
        <h1>{localeText(locale, 'Timesheets v2', 'Табель v2')}</h1>
        <p className="month-matrix-subtitle">{localeText(locale, 'Pick a customer to see its workers for the whole month.', 'Выберите заказчика, чтобы увидеть его работников за весь месяц.')}</p>
        <MonthPicker locale={locale} month={month} basePath="/admin/timesheets-v2" />
        {!outcome.ok ? (
          <p className="login-error" role="alert">
            {localeText(locale, `Too much data for one month (${outcome.totalItems} weekly rows, limit ${outcome.max}).`, `Слишком много данных за месяц (${outcome.totalItems} недельных строк, предел ${outcome.max}).`)}
          </p>
        ) : (
          <>
            <p className="month-matrix-total">
              {monthTitle(locale, month)}: <strong>{formatMatrixHours(outcome.totalMinutes) || '0'} {localeText(locale, 'h', 'ч')}</strong> {localeText(locale, 'in total', 'всего')}
            </p>
            {outcome.hiddenCardCount > 0 && (
              <p className="tv2-hidden-total-note">
                {localeText(locale,
                  `The total still includes ${outcome.hiddenCardCount} hidden card(s); source hours are preserved.`,
                  `Итого по-прежнему включает скрытые карточки (${outcome.hiddenCardCount}); исходные часы сохранены.`)}
              </p>
            )}
            <TimesheetV2Cards locale={locale} month={month} cards={outcome.cards} trashedCards={outcome.trashedCards} />
          </>
        )}
      </div>
    </main>
  );
}
