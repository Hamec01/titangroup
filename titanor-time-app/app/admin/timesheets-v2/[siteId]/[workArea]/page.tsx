import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isUuid } from '@/lib/api-guard';
import { localeText } from '@/lib/i18n/locale';
import { prisma } from '@/lib/prisma';
import { formatMatrixHours, loadCustomerMonthMatrix } from '@/lib/reporting/monthly-matrix';
import { resolveTimesheetsV2Context } from '../../admin-gate';
import { MonthMatrixTable, MonthPicker, monthTitle } from '../../MonthMatrixTable';
import { MonthMatrixEditor } from '../../MonthMatrixEditor';

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
  const [outcome, siteAreas] = await Promise.all([
    loadCustomerMonthMatrix(month, { siteId, workAreaId }, ctx.actor, ctx.todayIso),
    prisma.workArea.findMany({ where: { siteId, active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
  ]);
  // "Перенести часы": the other customers of this site, plus "no customer".
  const moveTargets = [
    ...siteAreas.filter((a) => a.id !== workAreaId).map((a) => ({ workArea: a.id, name: a.name })),
    ...(workAreaId ? [{ workArea: 'none', name: localeText(locale, 'No customer', 'Без заказчика') }] : [])
  ];
  const basePath = `/admin/timesheets-v2/${siteId}/${workArea}`;
  const viewHref = `${basePath}?month=${month}`;
  const editing = sp.edit === '1' && outcome.ok && outcome.matrix.rows.length > 0;

  return (
    <main className="setup-page">
      <div className="setup-card worker-card ledger-card month-matrix-card">
        <Link href={`/admin/timesheets-v2?month=${month}`} className="tv2-back">← {localeText(locale, 'All customers', 'Все заказчики')}</Link>
        <h1>{customerName}</h1>
        <p className="month-matrix-subtitle">{site.name}</p>
        {editing ? <p className="month-matrix-title month-matrix-title-static">{monthTitle(locale, month)}</p> : <MonthPicker locale={locale} month={month} basePath={basePath} editHref={outcome.ok && outcome.matrix.rows.length > 0 ? `${viewHref}&edit=1` : undefined} />}
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
            {editing ? (
              <MonthMatrixEditor locale={locale} matrix={outcome.matrix} siteId={siteId} workArea={workArea} viewHref={viewHref} />
            ) : (
              <>
                <MonthMatrixTable locale={locale} matrix={outcome.matrix} caption={`${customerName} — ${monthTitle(locale, month)}`} move={{ siteId, fromWorkArea: workArea, fromName: customerName, targets: moveTargets }} />
                <div className="month-matrix-actions">
                  <a className="month-matrix-download" href={`/api/admin/timesheets-v2/export?siteId=${siteId}&workArea=${workArea}&month=${month}`} download>
                    ⬇ {localeText(locale, 'Download Excel', 'Скачать Excel')}
                  </a>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
