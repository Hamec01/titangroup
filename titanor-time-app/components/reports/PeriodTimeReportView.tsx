import Link from 'next/link';
import type { PeriodTimeReport, PeriodTimeReportSite, TimesheetStatusCounts } from '@/lib/period-time-report';
import { formatWorkedDuration, timesheetStatusLabel } from '@/lib/reporting/report-format';
import { buildOverviewQueryString } from '@/lib/attendance-overview-ui';
import { AdminReportTabs } from '@/components/reports/AdminReportTabs';
import type { AppLocale } from '@/lib/i18n/locale';

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.3B" §AD — the ONLY place the payroll period
// report is rendered. app/admin/reports/periods/page.tsx is a thin Server Component wrapper that
// resolves session/permissions, parses searchParams, calls getPeriodTimeReport() directly (no
// HTTP self-fetch), gets the period lookup list, and passes everything here as props. This
// component makes zero database/API calls of its own and never recomputes/re-sums a single
// minute or status count — it only formats numbers the backend already produced.

export interface PeriodOption {
  id: string;
  label: string;
  status: string;
}

export interface RawPeriodReportFilters {
  periodId: string | null;
  page: string | null;
  pageSize: string | null;
}

export type PeriodReportOutcome =
  | { kind: 'prompt' }
  | { kind: 'invalid'; fieldErrors: Record<string, string[]> }
  | { kind: 'period-not-found' }
  | { kind: 'ok'; report: PeriodTimeReport };

export interface PeriodTimeReportViewProps {
  basePath: string;
  rawFilters: RawPeriodReportFilters;
  periodOptions: PeriodOption[];
  outcome: PeriodReportOutcome;
  locale: AppLocale;
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
const STATUS_ORDER: (keyof TimesheetStatusCounts)[] = ['DRAFT', 'SUBMITTED', 'RETURNED', 'FOREMAN_APPROVED', 'FINAL_APPROVED'];

export function PeriodTimeReportView({ basePath, rawFilters, periodOptions, outcome, locale }: PeriodTimeReportViewProps) {
  const ru = locale === 'RU';
  return (
    <div>
      <h1>{ru ? 'Отчёт по расчётному периоду' : 'Payroll period report'}</h1>
      <AdminReportTabs active="period" locale={locale} />
      <p className="setup-subtitle">{ru ? 'Только часы — без расчёта зарплаты.' : 'Hours only — no salary or payroll calculation.'}</p>

      {periodOptions.length === 0 ? (
        <p role="status" className="setup-subtitle">
          {ru ? 'Расчётных периодов пока нет.' : 'No payroll periods exist yet.'}
        </p>
      ) : (
        <form method="GET" action={basePath} className="ov-filters" aria-label={ru ? 'Выбор расчётного периода' : 'Select payroll period'}>
          <div className="ov-filter-field">
            <label htmlFor="period-report-filter-period">{ru ? 'Расчётный период' : 'Payroll period'}</label>
            <select id="period-report-filter-period" name="periodId" defaultValue={rawFilters.periodId ?? ''}>
              <option value="">{ru ? 'Выберите период…' : 'Select a period…'}</option>
              {periodOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="ov-filter-field">
            <label htmlFor="period-report-filter-pagesize">{ru ? 'На странице' : 'Per page'}</label>
            <select id="period-report-filter-pagesize" name="pageSize" defaultValue={rawFilters.pageSize ?? '20'}>
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

      <ReportBody basePath={basePath} rawFilters={rawFilters} outcome={outcome} locale={locale} />
    </div>
  );
}

function ReportBody({ basePath, rawFilters, outcome, locale }: { basePath: string; rawFilters: RawPeriodReportFilters; outcome: PeriodReportOutcome; locale: AppLocale }) {
  const ru = locale === 'RU';
  if (outcome.kind === 'prompt') {
    return (
      <p role="status" className="setup-subtitle">
        {ru ? 'Выберите расчётный период выше, чтобы увидеть отчёт по компании.' : 'Choose a payroll period above to see the company report.'}
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

  if (outcome.kind === 'period-not-found') {
    return (
      <p className="login-error" role="alert">
        {ru ? 'Расчётный период с таким идентификатором не найден.' : 'No payroll period with this id.'}
      </p>
    );
  }

  const { report } = outcome;
  const baseQuery = { periodId: rawFilters.periodId, pageSize: rawFilters.pageSize };

  return (
    <div aria-live="polite">
      <h2>
        {report.period.startDate} – {report.period.endDate} <span className="setup-subtitle">({report.period.status})</span>
      </h2>
      <p className="ov-muted">{ru ? 'По состоянию на' : 'As of'} {report.asOf}</p>
      <p>
        <Link href={`/admin/export?periodId=${report.period.id}`}>{ru ? 'Выгрузки CSV для этого периода' : 'View CSV exports for this period'}</Link>
      </p>

      <SummaryPanel summary={report.summary} locale={locale} />

      {report.sites.length === 0 ? (
        report.totalItems === 0 ? (
          <p role="status">
            {report.summary.workerCount === 0
              ? (ru ? 'В этом расчётном периоде нет работников.' : 'No workers in this payroll period.')
              : (ru ? 'В этом периоде есть работники, но ни один пока не привязан к объекту.' : 'This period has workers, but none are connected to a work site yet.')}
          </p>
        ) : (
          <div role="status">
            <p>
              {ru ? `На этой странице нет объектов (всего: ${report.totalItems}, страниц: ${report.totalPages}).` : `This page has no sites (${report.totalItems} total, ${report.totalPages} pages).`}
            </p>
            <Link href={`${basePath}${buildOverviewQueryString({ ...baseQuery, page: 1 })}`}>{ru ? 'На страницу 1' : 'Back to page 1'}</Link>
          </div>
        )
      ) : (
        <ul className="ov-worker-list">
          {report.sites.map((site) => (
            <SiteRow key={site.site.id} site={site} periodId={report.period.id} locale={locale} />
          ))}
        </ul>
      )}

      <Pagination basePath={basePath} baseQuery={baseQuery} page={report.page} totalPages={report.totalPages} totalItems={report.totalItems} locale={locale} />
    </div>
  );
}

function SummaryPanel({ summary, locale }: { summary: PeriodTimeReport['summary']; locale: AppLocale }) {
  const ru = locale === 'RU';
  return (
    <section aria-labelledby="period-report-summary-heading">
      <h3 id="period-report-summary-heading">{ru ? 'Сводка по компании' : 'Company summary'}</h3>
      <dl className="ov-worker-grid">
        <div>
          <dt>{ru ? 'Работники' : 'Workers'}</dt>
          <dd>{summary.workerCount}</dd>
        </div>
        <div>
          <dt>{ru ? 'Участники' : 'Participants'}</dt>
          <dd>{summary.participantCount}</dd>
        </div>
        <div>
          <dt>{ru ? 'Ожидается' : 'Expected'}</dt>
          <dd>{summary.expectedParticipantCount}</dd>
        </div>
        <div>
          <dt>{ru ? 'Исключено' : 'Excluded'}</dt>
          <dd>{summary.excludedParticipantCount}</dd>
        </div>
        <div>
          <dt>{ru ? 'Назначенных работников' : 'Assigned workers'}</dt>
          <dd>{summary.assignedWorkerCount}</dd>
        </div>
        <div>
          <dt>{ru ? 'Работавших работников' : 'Worked workers'}</dt>
          <dd>{summary.workedWorkerCount}</dd>
        </div>
        <div>
          <dt>{ru ? 'Без табеля' : 'Without timesheet'}</dt>
          <dd>{summary.withoutTimesheetCount}</dd>
        </div>
        <div>
          <dt>{ru ? 'Без объекта' : 'Without site'}</dt>
          <dd>{summary.withoutSiteCount}</dd>
        </div>
        <div>
          <dt>{ru ? 'Объекты' : 'Sites'}</dt>
          <dd>{summary.siteCount}</dd>
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
      <StatusCountsList counts={summary.timesheetStatusCounts} headingId="period-report-status-heading" heading={ru ? 'Счётчики статусов табеля' : 'Timesheet status counts'} locale={locale} />
    </section>
  );
}

function StatusCountsList({ counts, headingId, heading, locale }: { counts: TimesheetStatusCounts; headingId: string; heading: string; locale: AppLocale }) {
  return (
    <>
      <h4 id={headingId}>{heading}</h4>
      <ul className="ov-state-badges" aria-labelledby={headingId}>
        {STATUS_ORDER.map((status) => (
          <li key={status} className="ov-badge ov-badge-neutral">
            {timesheetStatusLabel(status, locale)}: {counts[status]}
          </li>
        ))}
      </ul>
    </>
  );
}

function SiteRow({ site, periodId, locale }: { site: PeriodTimeReportSite; periodId: string; locale: AppLocale }) {
  const ru = locale === 'RU';
  const drillDownHref = `/admin/reports/sites${buildOverviewQueryString({ siteId: site.site.id, periodId })}`;
  return (
    <li className="ov-worker-card">
      <div className="ov-worker-head">
        <h4 className="ov-worker-name">
          <Link href={drillDownHref}>{site.site.name}</Link> <span className="ov-muted">({site.site.active ? (ru ? 'Активен' : 'Active') : (ru ? 'Закрыт' : 'Closed')})</span>
        </h4>
      </div>

      <dl className="ov-worker-grid">
        <div>
          <dt>{ru ? 'Назначенных работников' : 'Assigned workers'}</dt>
          <dd>{site.assignedWorkerCount}</dd>
        </div>
        <div>
          <dt>{ru ? 'Работавших работников' : 'Worked workers'}</dt>
          <dd>{site.workedWorkerCount}</dd>
        </div>
        <div>
          <dt>{ru ? 'Без табеля' : 'Without timesheet'}</dt>
          <dd>{site.withoutTimesheetCount}</dd>
        </div>
        <div>
          <dt>{ru ? 'Отработанные дни' : 'Worked days'}</dt>
          <dd>{site.workedDayCount}</dd>
        </div>
        <div>
          <dt>{ru ? 'Всего' : 'Gross'}</dt>
          <dd>{formatWorkedDuration(site.grossMinutes, locale)}</dd>
        </div>
        <div>
          <dt>{ru ? 'Оплачиваемые перерывы' : 'Paid breaks'}</dt>
          <dd>{formatWorkedDuration(site.paidBreakMinutes, locale)}</dd>
        </div>
        <div>
          <dt>{ru ? 'Неоплачиваемые перерывы' : 'Unpaid breaks'}</dt>
          <dd>{formatWorkedDuration(site.unpaidBreakMinutes, locale)}</dd>
        </div>
        <div>
          <dt>{ru ? 'Отработано' : 'Worked'}</dt>
          <dd>{formatWorkedDuration(site.workedMinutes, locale)}</dd>
        </div>
        <div>
          <dt>{ru ? 'Интервалы' : 'Segments'}</dt>
          <dd>{site.segmentCount}</dd>
        </div>
      </dl>
      <StatusCountsList counts={site.timesheetStatusCounts} headingId={`period-report-site-status-${site.site.id}`} heading={ru ? 'Счётчики статусов' : 'Status counts'} locale={locale} />
      <p>
        <Link href={drillDownHref}>{ru ? 'Отчёт по этому объекту' : "View this site's report"}</Link>
      </p>
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
        {ru ? `Объектов: ${totalItems} · страница ${page} из ${totalPages}` : `${totalItems} site${totalItems === 1 ? '' : 's'} · page ${page} of ${totalPages}`}
      </span>
      {page < totalPages ? <Link href={pageHref(page + 1)}>{ru ? 'Далее' : 'Next'}</Link> : <span className="exc-pagination-disabled">{ru ? 'Далее' : 'Next'}</span>}
    </nav>
  );
}
