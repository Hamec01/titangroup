import Link from 'next/link';
import { localeText } from '@/lib/i18n/locale';
import { formatMatrixHours, loadCustomerCards } from '@/lib/reporting/monthly-matrix';
import { resolveTimesheetsV2Context } from './admin-gate';
import { MonthPicker, monthTitle } from './MonthMatrixTable';

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
        ) : outcome.cards.length === 0 ? (
          <p className="month-matrix-empty">{localeText(locale, 'No customers yet. Create them under Setup → Customers.', 'Заказчиков пока нет. Их создают в разделе «Настройка → Заказчики».')}</p>
        ) : (
          <>
            <p className="month-matrix-total">
              {monthTitle(locale, month)}: <strong>{formatMatrixHours(outcome.totalMinutes) || '0'} {localeText(locale, 'h', 'ч')}</strong> {localeText(locale, 'in total', 'всего')}
            </p>
            <ul className="tv2-cards">
              {outcome.cards.map((card) => (
                <li key={card.key}>
                  <Link href={`/admin/timesheets-v2/${card.siteId}/${card.workAreaId ?? 'none'}?month=${month}`} className={card.peopleCount === 0 && card.workedMinutes === 0 ? 'tv2-card is-idle' : 'tv2-card'}>
                    <strong className="tv2-card-name">{card.workAreaName ?? localeText(locale, 'No customer', 'Без заказчика')}</strong>
                    <span className="tv2-card-site">{card.siteName}</span>
                    <span className="tv2-card-stats">
                      <span><b>{card.peopleCount}</b> {localeText(locale, card.peopleCount === 1 ? 'worker' : 'workers', 'чел.')}</span>
                      <span><b>{formatMatrixHours(card.workedMinutes) || '0'}</b> {localeText(locale, 'h this month', 'ч за месяц')}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </main>
  );
}
