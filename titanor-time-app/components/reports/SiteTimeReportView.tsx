import Link from 'next/link';
import type { SiteTimeReport } from '@/lib/site-time-report';
import { formatWorkedDuration, timesheetStatusLabel, dataSourceLabel, submissionSourceLabel } from '@/lib/reporting/report-format';
import { buildOverviewQueryString } from '@/lib/attendance-overview-ui';
import { AdminReportTabs } from '@/components/reports/AdminReportTabs';
import type { AppLocale } from '@/lib/i18n/locale';

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.2B" §J — the ONLY place the site time report
// is rendered. app/admin/reports/sites/page.tsx and app/foreman/reports/sites/page.tsx are thin
// Server Component wrappers that resolve session/permissions/scope, call getSiteTimeReport()
// directly (no HTTP self-fetch), and pass everything here as props. This component makes zero
// database/API calls of its own and never recomputes/re-sums a single minute — it only formats
// numbers the backend already produced.

export interface SiteOption {
  id: string;
  name: string;
}

export interface PeriodOption {
  id: string;
  label: string;
  status: string;
}

export interface RawSiteReportFilters {
  siteId: string | null;
  periodId: string | null;
  page: string | null;
  pageSize: string | null;
}

export type SiteReportOutcome =
  | { kind: 'prompt' }
  | { kind: 'invalid'; fieldErrors: Record<string, string[]> }
  | { kind: 'site-not-found' }
  | { kind: 'period-not-found' }
  | { kind: 'ok'; report: SiteTimeReport };

export interface SiteTimeReportViewProps {
  role: 'admin' | 'foreman';
  basePath: string;
  rawFilters: RawSiteReportFilters;
  siteOptions: SiteOption[];
  periodOptions: PeriodOption[];
  outcome: SiteReportOutcome;
  locale: AppLocale;
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

export function SiteTimeReportView({ role, basePath, rawFilters, siteOptions, periodOptions, outcome, locale }: SiteTimeReportViewProps) {
  const ru = locale === 'RU';
  return (
    <div>
      <h1>{ru ? 'Отчёт по времени объекта' : 'Site time report'}</h1>
      <ReportTypeTabs role={role} locale={locale} />

      {siteOptions.length === 0 ? (
        <p role="status" className="setup-subtitle">
          {role === 'foreman' ? (ru ? 'У вас пока нет назначенных объектов.' : 'You have no currently assigned sites.') : (ru ? 'Объектов пока нет.' : 'No work sites exist yet.')}
        </p>
      ) : periodOptions.length === 0 ? (
        <p role="status" className="setup-subtitle">
          {ru ? 'Расчётных периодов пока нет.' : 'No payroll periods exist yet.'}
        </p>
      ) : (
        <form method="GET" action={basePath} className="ov-filters" aria-label={ru ? 'Выбор объекта и периода' : 'Select site and period'}>
          <div className="ov-filter-field">
            <label htmlFor="site-report-filter-site">{ru ? 'Объект' : 'Site'}</label>
            <select id="site-report-filter-site" name="siteId" defaultValue={rawFilters.siteId ?? ''}>
              <option value="">{ru ? 'Выберите объект…' : 'Select a site…'}</option>
              {siteOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-field">
            <label htmlFor="site-report-filter-period">{ru ? 'Расчётный период' : 'Payroll period'}</label>
            <select id="site-report-filter-period" name="periodId" defaultValue={rawFilters.periodId ?? ''}>
              <option value="">{ru ? 'Выберите период…' : 'Select a period…'}</option>
              {periodOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-field">
            <label htmlFor="site-report-filter-pagesize">{ru ? 'На странице' : 'Per page'}</label>
            <select id="site-report-filter-pagesize" name="pageSize" defaultValue={rawFilters.pageSize ?? '20'}>
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-actions">
            <button type="submit" className="exc-apply-button">
              {ru ? 'Показать отчёт' : 'Show report'}
            </button>
            <Link href={basePath} className="exc-reset-link">
              {ru ? 'Сбросить' : 'Reset'}
            </Link>
          </div>
        </form>
      )}

      <ReportBody role={role} basePath={basePath} rawFilters={rawFilters} outcome={outcome} locale={locale} />
    </div>
  );
}

function ReportTypeTabs({ role, locale }: { role: 'admin' | 'foreman'; locale: AppLocale }) {
  if (role === 'foreman') {
    return null; // FOREMAN has exactly one report type, zero admin URLs — no switcher to show.
  }
  return <AdminReportTabs active="site" locale={locale} />;
}

function ReportBody({ role, basePath, rawFilters, outcome, locale }: { role: 'admin' | 'foreman'; basePath: string; rawFilters: RawSiteReportFilters; outcome: SiteReportOutcome; locale: AppLocale }) {
  const ru = locale === 'RU';
  if (outcome.kind === 'prompt') {
    return (
      <p role="status" className="setup-subtitle">
        {ru ? 'Выберите объект и расчётный период выше, чтобы увидеть отчёт.' : 'Choose a site and a payroll period above to see the report.'}
      </p>
    );
  }

  if (outcome.kind === 'invalid') {
    const messages = Object.entries(outcome.fieldErrors).map(([field, errors]) => `${field}: ${errors.join(', ')}`);
    return (
      <div className="login-error" role="alert">
        <p>{ru ? 'Некоторые фильтры некорректны:' : 'Some filters are invalid:'}</p>
        <ul>
          {messages.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (outcome.kind === 'site-not-found') {
    return (
      <p className="login-error" role="alert">
        {role === 'admin' ? (ru ? 'Объект с таким идентификатором не найден.' : 'No work site with this id.') : (ru ? 'Отчёт по объекту с таким идентификатором недоступен.' : 'No site report available for this id.')}
      </p>
    );
  }

  if (outcome.kind === 'period-not-found') {
    return (
      <p className="login-error" role="alert">
        {ru ? 'Расчётный период с таким идентификатором не найден.' : 'No payroll period with this id.'}
      </p>
    );
  }

  const { report } = outcome;
  const baseQuery = { siteId: rawFilters.siteId, periodId: rawFilters.periodId, pageSize: rawFilters.pageSize };

  return (
    <div aria-live="polite">
      <h2>
        {report.site.name} <span className="setup-subtitle">({report.site.active ? (ru ? 'Активен' : 'Active') : (ru ? 'Закрыт' : 'Closed')})</span>
      </h2>
      <p className="setup-subtitle">
        {ru ? 'Период' : 'Period'} {report.period.startDate} – {report.period.endDate} · {report.period.status}
      </p>
      <p className="ov-muted">{ru ? 'По состоянию на' : 'As of'} {report.asOf}</p>

      <SummaryPanel summary={report.summary} locale={locale} />

      {report.items.length === 0 ? (
        report.totalItems === 0 ? (
          <p role="status">{ru ? 'В этом отчёте по объекту за этот период нет работников.' : 'No workers in this site report for this period.'}</p>
        ) : (
          <div role="status">
            <p>{ru ? `На этой странице нет работников (всего: ${report.totalItems}, страниц: ${report.totalPages}).` : `This page has no workers (${report.totalItems} total, ${report.totalPages} pages).`}</p>
            <Link href={`${basePath}${buildOverviewQueryString({ ...baseQuery, page: 1 })}`}>{ru ? 'На страницу 1' : 'Back to page 1'}</Link>
          </div>
        )
      ) : (
        <ul className="ov-worker-list">
          {report.items.map((item) => (
            <WorkerCard key={item.employee.id} item={item} locale={locale} />
          ))}
        </ul>
      )}

      <Pagination basePath={basePath} baseQuery={baseQuery} page={report.page} totalPages={report.totalPages} totalItems={report.totalItems} locale={locale} />
    </div>
  );
}

function SummaryPanel({ summary, locale }: { summary: SiteTimeReport['summary']; locale: AppLocale }) {
  const ru = locale === 'RU';
  return (
    <section aria-labelledby="site-report-summary-heading">
      <h3 id="site-report-summary-heading">{ru ? 'Сводка' : 'Summary'}</h3>
      <dl className="ov-worker-grid">
        <div>
          <dt>{ru ? 'Работники' : 'Workers'}</dt>
          <dd>{summary.workerCount}</dd>
        </div>
        <div>
          <dt>{ru ? 'Без табеля' : 'Without timesheet'}</dt>
          <dd>{summary.withoutTimesheetCount}</dd>
        </div>
        <div>
          <dt>{ru ? 'Отработанные дни' : 'Worked days'}</dt>
          <dd>{summary.workedDayCount}</dd>
        </div>
        <div>
          <dt>{ru ? 'Всего' : 'Gross'}</dt>
          <dd>{formatWorkedDuration(summary.grossMinutes, locale)}</dd>
        </div>
        <div>
          <dt>{ru ? 'Оплачиваемые перерывы' : 'Paid breaks'}</dt>
          <dd>{formatWorkedDuration(summary.paidBreakMinutes, locale)}</dd>
        </div>
        <div>
          <dt>{ru ? 'Неоплачиваемые перерывы' : 'Unpaid breaks'}</dt>
          <dd>{formatWorkedDuration(summary.unpaidBreakMinutes, locale)}</dd>
        </div>
        <div>
          <dt>{ru ? 'Отработано всего' : 'Worked total'}</dt>
          <dd>{formatWorkedDuration(summary.workedMinutes, locale)}</dd>
        </div>
        <div>
          <dt>{ru ? 'Интервалы' : 'Segments'}</dt>
          <dd>{summary.segmentCount}</dd>
        </div>
      </dl>
      <h4>{ru ? 'Счётчики статусов табеля' : 'Timesheet status counts'}</h4>
      <ul className="ov-state-badges">
        {(Object.entries(summary.timesheetStatusCounts) as [keyof SiteTimeReport['summary']['timesheetStatusCounts'], number][]).map(([status, count]) => (
          <li key={status} className="ov-badge ov-badge-neutral">
            {timesheetStatusLabel(status, locale)}: {count}
          </li>
        ))}
      </ul>
    </section>
  );
}

function WorkerCard({ item, locale }: { item: SiteTimeReport['items'][number]; locale: AppLocale }) {
  const ru = locale === 'RU';
  return (
    <li className="ov-worker-card">
      <div className="ov-worker-head">
        <h4 className="ov-worker-name">
          {item.employee.lastName} {item.employee.firstName} <span className="ov-muted">({item.employee.employeeNumber})</span>
        </h4>
        <div className="ov-state-badges">
          {item.assignmentInPeriod && <span className="ov-badge ov-badge-neutral">{ru ? 'Назначен в периоде' : 'Assigned in period'}</span>}
          {item.participantExpected === false && <span className="ov-badge ov-badge-issue">{ru ? 'Исключённый участник' : 'Excluded participant'}</span>}
        </div>
      </div>

      {!item.timesheet ? (
        <p role="status" className="setup-subtitle">
          {ru ? 'Нет табеля для этого работника за этот период.' : 'No timesheet for this worker in this period.'}
        </p>
      ) : (
        <p className="setup-subtitle">
          {ru ? 'Статус табеля:' : 'Timesheet status:'} <strong>{timesheetStatusLabel(item.timesheet.status, locale)}</strong> · {dataSourceLabel(item.timesheet.dataSource, item.timesheet.versionNumber, locale)}
          {submissionSourceLabel(item.timesheet.submissionSource, locale) && ` · ${submissionSourceLabel(item.timesheet.submissionSource, locale)}`}
        </p>
      )}

      {item.days.length === 0 ? (
        <p role="status">{ru ? 'Ноль часов на этом объекте за этот период.' : 'Zero hours at this site in this period.'}</p>
      ) : (
        <div className="worker-table-scroll">
          <table className="worker-table">
            <thead>
              <tr>
                <th>{ru ? 'Дата' : 'Date'}</th>
                <th>{ru ? 'Всего' : 'Gross'}</th>
                <th>{ru ? 'Оплач. перерыв' : 'Paid break'}</th>
                <th>{ru ? 'Неоплач. перерыв' : 'Unpaid break'}</th>
                <th>{ru ? 'Отработано' : 'Worked'}</th>
                <th>{ru ? 'Интервалы' : 'Segments'}</th>
              </tr>
            </thead>
            <tbody>
              {item.days.map((d) => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  <td>{formatWorkedDuration(d.grossMinutes, locale)}</td>
                  <td>{formatWorkedDuration(d.paidBreakMinutes, locale)}</td>
                  <td>{formatWorkedDuration(d.unpaidBreakMinutes, locale)}</td>
                  <td>{formatWorkedDuration(d.workedMinutes, locale)}</td>
                  <td>{d.segmentCount}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>{ru ? `Итого (дней: ${item.total.workedDayCount})` : `Total (${item.total.workedDayCount} day${item.total.workedDayCount === 1 ? '' : 's'})`}</th>
                <th>{formatWorkedDuration(item.total.grossMinutes, locale)}</th>
                <th>{formatWorkedDuration(item.total.paidBreakMinutes, locale)}</th>
                <th>{formatWorkedDuration(item.total.unpaidBreakMinutes, locale)}</th>
                <th>{formatWorkedDuration(item.total.workedMinutes, locale)}</th>
                <th>{item.total.segmentCount}</th>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </li>
  );
}

function Pagination({
  basePath,
  baseQuery,
  page,
  totalPages,
  totalItems,
  locale
}: {
  basePath: string;
  baseQuery: Record<string, string | number | null | undefined>;
  page: number;
  totalPages: number;
  totalItems: number;
  locale: AppLocale;
}) {
  const ru = locale === 'RU';
  if (totalItems === 0) {
    return null;
  }
  const pageHref = (p: number) => `${basePath}${buildOverviewQueryString({ ...baseQuery, page: p })}`;
  return (
    <nav className="exc-pagination" aria-label={ru ? 'Постраничная навигация' : 'Pagination'}>
      {page > 1 ? <Link href={pageHref(page - 1)}>{ru ? 'Назад' : 'Previous'}</Link> : <span className="exc-pagination-disabled">{ru ? 'Назад' : 'Previous'}</span>}
      <span>
        {ru ? `Работников: ${totalItems} · страница ${page} из ${totalPages}` : `${totalItems} worker${totalItems === 1 ? '' : 's'} · page ${page} of ${totalPages}`}
      </span>
      {page < totalPages ? <Link href={pageHref(page + 1)}>{ru ? 'Далее' : 'Next'}</Link> : <span className="exc-pagination-disabled">{ru ? 'Далее' : 'Next'}</span>}
    </nav>
  );
}
