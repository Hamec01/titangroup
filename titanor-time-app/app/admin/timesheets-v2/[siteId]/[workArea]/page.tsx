import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isUuid } from '@/lib/api-guard';
import { localeText } from '@/lib/i18n/locale';
import { prisma } from '@/lib/prisma';
import { formatMatrixHours, loadCustomerMonthMatrix } from '@/lib/reporting/monthly-matrix';
import { resolveTimesheetsV2Context } from '../../admin-gate';
import { MonthMatrixTable, MonthPicker, monthTitle } from '../../MonthMatrixTable';

export const dynamic = 'force-dynamic';

// Табель v2 — step 2: one customer's month. `workArea` is the WorkArea id, or `none` for hours at
// the site that are not attributed to any customer.
type RouteParams = { params: Promise<{ siteId: string; workArea: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function TimesheetsV2CustomerPage({ params, searchParams }: RouteParams) {
  const [{ siteId, workArea }, sp] = await Promise.all([params, searchParams]);
  const ctx = await resolveTimesheetsV2Context(sp.month);
  if (!ctx.ok) {
    return <main className="setup-page"><p className="login-error" role="alert">{ctx.message}</p></main>;
  }
  if (!isUuid(siteId) || (workArea !== 'none' && !isUuid(workArea))) notFound();
  const workAreaId = workArea === 'none' ? null : workArea;
  const site = await prisma.workSite.findUnique({ where: { id: siteId }, select: { name: true } });
  const area = workAreaId ? await prisma.workArea.findFirst({ where: { id: workAreaId, siteId }, select: { name: true } }) : null;
  if (!site || (workAreaId && !area)) notFound();

  const { locale, month } = ctx;
  const customerName = area?.name ?? localeText(locale, 'No customer', 'Без заказчика');
  const outcome = await loadCustomerMonthMatrix(month, { siteId, workAreaId }, ctx.actor, ctx.todayIso);
  const basePath = `/admin/timesheets-v2/${siteId}/${workArea}`;

  return (
    <main className="setup-page">
      <div className="setup-card worker-card ledger-card month-matrix-card">
        <Link href={`/admin/timesheets-v2?month=${month}`} className="tv2-back">← {localeText(locale, 'All customers', 'Все заказчики')}</Link>
        <h1>{customerName}</h1>
        <p className="month-matrix-subtitle">{site.name}</p>
        <MonthPicker locale={locale} month={month} basePath={basePath} />
        {!outcome.ok ? (
          <p className="login-error" role="alert">
            {localeText(locale, `Too much data for one month (${outcome.totalItems} weekly rows, limit ${outcome.max}).`, `Слишком много данных за месяц (${outcome.totalItems} недельных строк, предел ${outcome.max}).`)}
          </p>
        ) : outcome.matrix.rows.length === 0 ? (
          <p className="month-matrix-empty">{localeText(locale, 'No workers attached and no hours this month.', 'В этом месяце нет прикреплённых работников и часов.')}</p>
        ) : (
          <>
            <p className="month-matrix-total">
              {localeText(locale, 'Workers', 'Работников')}: <strong>{outcome.matrix.rows.length}</strong> · {localeText(locale, 'Hours', 'Часов')}: <strong>{formatMatrixHours(outcome.matrix.totalMinutes) || '0'}</strong>
            </p>
            <MonthMatrixTable locale={locale} matrix={outcome.matrix} caption={`${customerName} — ${monthTitle(locale, month)}`} />
            <div className="month-matrix-actions">
              <a className="month-matrix-download" href={`/api/admin/timesheets-v2/export?siteId=${siteId}&workArea=${workArea}&month=${month}`} download>
                ⬇ {localeText(locale, 'Download Excel', 'Скачать Excel')}
              </a>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
