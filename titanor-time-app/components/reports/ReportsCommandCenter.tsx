import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AppLocale } from '@/lib/i18n/locale';
import type { PeriodTimeReport } from '@/lib/period-time-report';
import type { WorkerTimeReport } from '@/lib/worker-time-report';
import type { SiteTimeReport } from '@/lib/site-time-report';
import type { ReportFilesPage } from '@/lib/report-files';
import type { ReportSelectableEmployee } from '@/lib/users';
import { formatWorkedDuration, timesheetStatusLabel } from '@/lib/reporting/report-format';
import { formatHelsinkiDateTime } from '@/lib/helsinki-datetime';
import { ReportExportControls } from '@/components/reports/ReportExportControls';
import { ReportFileDeleteButton } from '@/components/reports/ReportFileDeleteButton';

export type ReportsView = 'overview' | 'worker' | 'site' | 'files';

export type ReportsScreen =
  | { kind: 'period-invalid' }
  | { kind: 'period-not-found' }
  | { kind: 'no-periods' }
  | { kind: 'overview'; report: PeriodTimeReport }
  | { kind: 'worker-picker' }
  | { kind: 'site-picker' }
  | { kind: 'entity-invalid'; entity: 'worker' | 'site' }
  | { kind: 'entity-not-found'; entity: 'worker' | 'site' }
  | { kind: 'worker'; report: WorkerTimeReport }
  | { kind: 'site'; report: SiteTimeReport }
  | { kind: 'files'; filesPage: ReportFilesPage };

interface Props {
  locale: AppLocale;
  view: ReportsView;
  periodOptions: { id: string; label: string; status: string }[];
  employeeOptions: ReportSelectableEmployee[];
  siteOptions: { id: string; name: string }[];
  selectedPeriodId: string | null;
  selectedPeriodLabel: string | null;
  selectedPeriodStatus: string | null;
  selectedEmployeeId: string | null;
  selectedSiteId: string | null;
  detailPage: number;
  filesPage: number;
  screen: ReportsScreen;
}

const OFFICIAL_EXPORT_PATH = '/admin/export';

function href(params: Record<string, string | number | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') qs.set(key, String(value));
  }
  const s = qs.toString();
  return s ? `/admin/reports?${s}` : '/admin/reports';
}

export function ReportsCommandCenter(props: Props) {
  const ru = props.locale === 'RU';
  const { screen, selectedPeriodId, view } = props;
  const periodStatus = props.selectedPeriodStatus;

  const periodStatusText = (status: string | null): string => {
    if (status === 'OPEN') return ru ? 'Открыт' : 'Open';
    if (status === 'LOCKED') return ru ? 'Заблокирован' : 'Locked';
    if (status === 'EXPORTED') return ru ? 'Выгружен' : 'Exported';
    return status ?? '';
  };

  // Tab links never carry the opposite subject id — that is what makes a worker/site conflict
  // structurally impossible (§2.7).
  const tabHref = (target: ReportsView): string => {
    if (!selectedPeriodId) return href({ view: target });
    if (target === 'worker') return href({ view: 'worker', periodId: selectedPeriodId, employeeId: props.selectedEmployeeId });
    if (target === 'site') return href({ view: 'site', periodId: selectedPeriodId, siteId: props.selectedSiteId });
    return href({ view: target, periodId: selectedPeriodId });
  };

  return (
    <div className="report-center">
      <div className="report-center-header">
        <div>
          <p className="report-eyebrow">Titanor Time · {ru ? 'рабочие отчёты' : 'working reports'}</p>
          <h1>{ru ? 'Отчёты' : 'Reports'}</h1>
          <p className="report-center-lead">
            {ru
              ? 'Аналитическая панель по часам и табелям. Файлы, созданные здесь, — рабочие отчёты, а не официальная payroll-выгрузка.'
              : 'An analytics workspace for hours and timesheets. Files created here are working reports, not the official payroll export.'}
          </p>
        </div>
        {screen.kind === 'overview' && selectedPeriodId && (
          <ReportExportControls periodId={selectedPeriodId} reportType="PERIOD_SUMMARY" />
        )}
        {screen.kind === 'worker' && selectedPeriodId && props.selectedEmployeeId && (
          <ReportExportControls periodId={selectedPeriodId} reportType="WORKER_DETAIL" employeeId={props.selectedEmployeeId} />
        )}
        {screen.kind === 'site' && selectedPeriodId && props.selectedSiteId && (
          <ReportExportControls periodId={selectedPeriodId} reportType="SITE_DETAIL" siteId={props.selectedSiteId} />
        )}
      </div>

      <WorkingReportNotice ru={ru} periodStatus={periodStatus} />

      <form className="report-filter-bar" method="GET" action="/admin/reports" aria-label={ru ? 'Фильтр периода' : 'Period filter'}>
        <input type="hidden" name="view" value={view} />
        {view === 'worker' && props.selectedEmployeeId && <input type="hidden" name="employeeId" value={props.selectedEmployeeId} />}
        {view === 'site' && props.selectedSiteId && <input type="hidden" name="siteId" value={props.selectedSiteId} />}
        <div className="report-filter-field">
          <label htmlFor="report-period">{ru ? 'Расчётный период' : 'Payroll period'}</label>
          <select id="report-period" name="periodId" defaultValue={selectedPeriodId ?? ''}>
            {props.periodOptions.length === 0 && <option value="">{ru ? 'Периодов нет' : 'No periods'}</option>}
            {props.periodOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <button className="report-filter-submit" type="submit">
          {ru ? 'Показать' : 'Apply'}
        </button>
        <Link className="report-filter-reset" href="/admin/reports">
          {ru ? 'Сбросить' : 'Reset'}
        </Link>
      </form>

      <nav className="report-tabs" aria-label={ru ? 'Разделы отчёта' : 'Report sections'}>
        {(['overview', 'worker', 'site', 'files'] as ReportsView[]).map((t) => (
          <Link
            key={t}
            className={view === t ? 'report-tab report-tab-active' : 'report-tab'}
            aria-current={view === t ? 'page' : undefined}
            href={tabHref(t)}
          >
            {t === 'overview'
              ? ru
                ? 'Обзор периода'
                : 'Period overview'
              : t === 'worker'
                ? ru
                  ? 'По работнику'
                  : 'By worker'
                : t === 'site'
                  ? ru
                    ? 'По объекту'
                    : 'By site'
                  : ru
                    ? 'Сохранённые файлы'
                    : 'Saved files'}
          </Link>
        ))}
      </nav>

      <ScreenBody {...props} ru={ru} />
    </div>
  );
}

function WorkingReportNotice({ ru, periodStatus }: { ru: boolean; periodStatus: string | null }) {
  return (
    <aside className="report-working-notice">
      <p>
        <strong>{ru ? 'Рабочий отчёт.' : 'Working report.'}</strong>{' '}
        {ru
          ? 'Это аналитический снимок для внутренней проверки недели. Его можно создать при любом статусе периода, сохранить, скачать повторно и удалить. Он не заменяет официальную payroll-выгрузку.'
          : 'This is an analytics snapshot for internal weekly review. It can be created for any period status, saved, re-downloaded and deleted. It does not replace the official payroll export.'}
      </p>
      <p className="report-working-notice-official">
        {periodStatus === 'OPEN'
          ? ru
            ? 'Для официальной payroll-выгрузки период нужно сначала заблокировать. '
            : 'Lock the period before creating an official payroll export. '
          : null}
        <Link href={OFFICIAL_EXPORT_PATH}>{ru ? 'Перейти к официальной payroll-выгрузке' : 'Go to official payroll export'}</Link>
      </p>
    </aside>
  );
}

function ScreenBody(props: Props & { ru: boolean }) {
  const { ru, screen } = props;

  switch (screen.kind) {
    case 'no-periods':
      return (
        <section className="report-panel">
          <p className="report-empty">{ru ? 'Расчётных периодов пока нет.' : 'No payroll periods exist yet.'}</p>
        </section>
      );
    case 'period-invalid':
      return (
        <section className="report-panel">
          <p className="report-alert" role="alert">
            {ru ? 'Идентификатор периода в ссылке некорректен.' : 'The period id in the link is not valid.'}{' '}
            <Link href="/admin/reports">{ru ? 'Открыть отчёты заново' : 'Open reports again'}</Link>
          </p>
        </section>
      );
    case 'period-not-found':
      return (
        <section className="report-panel">
          <p className="report-alert" role="alert">
            {ru ? 'Расчётный период с таким идентификатором не найден.' : 'No payroll period with this id.'}{' '}
            <Link href="/admin/reports">{ru ? 'Выбрать другой период' : 'Pick another period'}</Link>
          </p>
        </section>
      );
    case 'entity-invalid':
      return (
        <EntitySwitcher {...props}>
          <p className="report-alert" role="alert">
            {screen.entity === 'worker'
              ? ru
                ? 'Идентификатор работника в ссылке некорректен.'
                : 'The worker id in the link is not valid.'
              : ru
                ? 'Идентификатор объекта в ссылке некорректен.'
                : 'The site id in the link is not valid.'}
          </p>
        </EntitySwitcher>
      );
    case 'entity-not-found':
      return (
        <EntitySwitcher {...props}>
          <p className="report-alert" role="alert">
            {screen.entity === 'worker'
              ? ru
                ? 'Работник с таким идентификатором не найден.'
                : 'No worker with this id.'
              : ru
                ? 'Объект с таким идентификатором не найден.'
                : 'No site with this id.'}
          </p>
        </EntitySwitcher>
      );
    case 'worker-picker':
      return <EntitySwitcher {...props} />;
    case 'site-picker':
      return <EntitySwitcher {...props} />;
    case 'overview':
      return <PeriodOverview {...props} report={screen.report} />;
    case 'worker':
      return (
        <>
          <EntitySwitcher {...props} />
          <WorkerDetail ru={ru} locale={props.locale} report={screen.report} />
        </>
      );
    case 'site':
      return (
        <>
          <EntitySwitcher {...props} />
          <SiteDetail {...props} report={screen.report} />
        </>
      );
    case 'files':
      return <FilesPanel {...props} filesPage={screen.filesPage} />;
  }
}

function EntitySwitcher(props: Props & { ru: boolean; children?: ReactNode }) {
  const { ru, view, selectedPeriodId } = props;
  const isWorker = view === 'worker';
  return (
    <section className="report-panel report-picker">
      <div className="report-panel-heading">
        <div>
          <h2>{isWorker ? (ru ? 'Выберите работника' : 'Choose a worker') : ru ? 'Выберите объект' : 'Choose a site'}</h2>
          <p>
            {isWorker
              ? ru
                ? 'Откроется отчёт по времени этого работника за выбранный период.'
                : "Opens that worker's time report for the selected period."
              : ru
                ? 'Откроется отчёт по времени этого объекта за выбранный период.'
                : "Opens that site's time report for the selected period."}
          </p>
        </div>
      </div>
      <form className="report-picker-form" method="GET" action="/admin/reports">
        <input type="hidden" name="view" value={isWorker ? 'worker' : 'site'} />
        {selectedPeriodId && <input type="hidden" name="periodId" value={selectedPeriodId} />}
        {isWorker ? (
          <select name="employeeId" defaultValue={props.selectedEmployeeId ?? ''} aria-label={ru ? 'Работник' : 'Worker'}>
            <option value="">{ru ? 'Выберите работника…' : 'Select a worker…'}</option>
            {props.employeeOptions.map((e) => (
              <option key={e.id} value={e.id}>
                {e.lastName} {e.firstName} · {e.employeeNumber}
              </option>
            ))}
          </select>
        ) : (
          <select name="siteId" defaultValue={props.selectedSiteId ?? ''} aria-label={ru ? 'Объект' : 'Site'}>
            <option value="">{ru ? 'Выберите объект…' : 'Select a site…'}</option>
            {props.siteOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <button type="submit" className="report-filter-submit">
          {ru ? 'Открыть отчёт' : 'Open report'}
        </button>
      </form>
      {props.children}
    </section>
  );
}

function Pagination({
  ru,
  page,
  totalPages,
  totalItems,
  pageSize,
  makeHref
}: {
  ru: boolean;
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  makeHref: (page: number) => string;
}) {
  if (totalItems === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(totalItems, page * pageSize);
  return (
    <div className="report-pagination">
      <span className="report-pagination-info">
        {ru
          ? `Показаны ${from}–${to} из ${totalItems} · страница ${page} из ${totalPages}`
          : `Showing ${from}–${to} of ${totalItems} · page ${page} of ${totalPages}`}
      </span>
      <span className="report-pagination-controls">
        {page > 1 ? (
          <Link href={makeHref(page - 1)} rel="prev">
            ← {ru ? 'Назад' : 'Prev'}
          </Link>
        ) : (
          <span className="report-pagination-disabled">← {ru ? 'Назад' : 'Prev'}</span>
        )}
        {page < totalPages ? (
          <Link href={makeHref(page + 1)} rel="next">
            {ru ? 'Вперёд' : 'Next'} →
          </Link>
        ) : (
          <span className="report-pagination-disabled">{ru ? 'Вперёд' : 'Next'} →</span>
        )}
      </span>
    </div>
  );
}

function PeriodOverview(props: Props & { ru: boolean; report: PeriodTimeReport }) {
  const { ru, report, locale } = props;
  const s = report.summary;
  const st = s.timesheetStatusCounts;
  const makeHref = (page: number) => href({ view: 'overview', periodId: report.period.id, page });
  return (
    <>
      <div className="report-period-strip">
        <div>
          <strong>{ru ? 'Расчётный период' : 'Payroll period'}</strong>
          <span>
            {report.period.startDate} – {report.period.endDate} · {ru ? 'обновлено' : 'updated'} {formatHelsinkiDateTime(report.asOf)}
          </span>
        </div>
        <span className={report.period.status === 'OPEN' ? 'report-status report-status-open' : 'report-status'}>{report.period.status}</span>
      </div>

      <div className="report-kpi-grid">
        <Kpi label={ru ? 'Отработано' : 'Worked'} value={formatWorkedDuration(s.workedMinutes, locale)} note={`${s.workedWorkerCount} ${ru ? 'работников с часами' : 'workers with hours'}`} />
        <Kpi label={ru ? 'Всего (gross)' : 'Gross time'} value={formatWorkedDuration(s.grossMinutes, locale)} note={`${s.paidBreakMinutes + s.unpaidBreakMinutes} ${ru ? 'минут перерывов' : 'break minutes'}`} />
        <Kpi label={ru ? 'Работники' : 'Workers'} value={String(s.workerCount)} note={`${s.siteCount} ${ru ? 'объектов' : 'sites'}`} />
        <Kpi label={ru ? 'Окончательно одобрены' : 'Final approved'} value={String(st.FINAL_APPROVED)} note={`${s.withoutTimesheetCount} ${ru ? 'без табеля' : 'without timesheet'}`} />
      </div>

      <section className="report-panel">
        <div className="report-panel-heading">
          <div>
            <h2>{ru ? 'Объекты и часы' : 'Sites and hours'}</h2>
            <p>{ru ? 'Откройте объект для детализации по людям и дням.' : 'Open a site for per-worker and daily detail.'}</p>
          </div>
        </div>
        <div className="report-table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th>{ru ? 'Объект' : 'Site'}</th>
                <th>{ru ? 'Работники (часы/назн.)' : 'Workers (hrs/assigned)'}</th>
                <th>{ru ? 'Дни' : 'Days'}</th>
                <th>{ru ? 'Всего' : 'Gross'}</th>
                <th>{ru ? 'Отработано' : 'Worked'}</th>
                <th>{ru ? 'Интервалы' : 'Segments'}</th>
              </tr>
            </thead>
            <tbody>
              {report.sites.map((site) => (
                <tr key={site.site.id}>
                  <td>
                    <Link href={href({ view: 'site', periodId: report.period.id, siteId: site.site.id })}>{site.site.name}</Link>
                  </td>
                  <td>
                    {site.workedWorkerCount} / {site.assignedWorkerCount}
                  </td>
                  <td>{site.workedDayCount}</td>
                  <td>{formatWorkedDuration(site.grossMinutes, locale)}</td>
                  <td>{formatWorkedDuration(site.workedMinutes, locale)}</td>
                  <td>{site.segmentCount}</td>
                </tr>
              ))}
              {report.sites.length === 0 && (
                <tr>
                  <td colSpan={6} className="report-empty">
                    {ru ? 'В этом периоде нет объектов с часами или назначениями.' : 'No sites with hours or assignments in this period.'}
                  </td>
                </tr>
              )}
            </tbody>
            {report.sites.length > 0 && (
              <tfoot>
                <tr>
                  <td>{ru ? 'Итого' : 'Total'}</td>
                  <td>
                    {s.workedWorkerCount} / {s.assignedWorkerCount}
                  </td>
                  <td>{s.workedDayCount}</td>
                  <td>{formatWorkedDuration(s.grossMinutes, locale)}</td>
                  <td>{formatWorkedDuration(s.workedMinutes, locale)}</td>
                  <td>{s.segmentCount}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <Pagination ru={ru} page={report.page} totalPages={report.totalPages} totalItems={report.totalItems} pageSize={report.pageSize} makeHref={makeHref} />
        <p className="report-fine-print">
          {ru
            ? 'Счётчики работников и дней в строке «Итого» — это компанейские значения без двойного счёта. Только минуты и интервалы являются суммой строк.'
            : 'Worker and day counts on the Total line are deduplicated company figures. Only minutes and segment counts are column sums.'}
        </p>
      </section>
    </>
  );
}

function WorkerDetail({ ru, locale, report }: { ru: boolean; locale: AppLocale; report: WorkerTimeReport }) {
  return (
    <section className="report-panel">
      <div className="report-detail-head">
        <span className="report-avatar">
          {report.employee.firstName[0]}
          {report.employee.lastName[0]}
        </span>
        <div>
          <h2>
            {report.employee.lastName} {report.employee.firstName}
          </h2>
          <p>
            {report.employee.employeeNumber} · {report.period.startDate} – {report.period.endDate} · {ru ? 'табель' : 'timesheet'}:{' '}
            {report.timesheet ? timesheetStatusLabel(report.timesheet.status, locale) : ru ? 'нет' : 'none'}
          </p>
        </div>
      </div>
      {report.participant && !report.participant.expected && (
        <p role="status" className="report-fine-print">
          {ru ? 'Этот работник исключён из данного расчётного периода.' : 'This worker is excluded from this payroll period.'}
        </p>
      )}
      <div className="report-kpi-grid">
        <Kpi label={ru ? 'Отработано' : 'Worked'} value={formatWorkedDuration(report.total.workedMinutes, locale)} note={`${report.total.workedDayCount} ${ru ? 'дней' : 'days'}`} />
        <Kpi label={ru ? 'Объекты' : 'Sites'} value={String(report.total.siteCount)} note={`${report.total.segmentCount} ${ru ? 'интервалов' : 'segments'}`} />
      </div>
      <div className="report-table-wrap">
        <table className="report-table">
          <thead>
            <tr>
              <th>{ru ? 'Объект' : 'Site'}</th>
              <th>{ru ? 'Дни' : 'Days'}</th>
              <th>{ru ? 'Всего' : 'Gross'}</th>
              <th>{ru ? 'Оплач. перерыв' : 'Paid break'}</th>
              <th>{ru ? 'Неоплач. перерыв' : 'Unpaid break'}</th>
              <th>{ru ? 'Отработано' : 'Worked'}</th>
            </tr>
          </thead>
          <tbody>
            {report.sites.map((site) => (
              <tr key={site.siteId}>
                <td>{site.siteName}</td>
                <td>{site.workedDayCount}</td>
                <td>{formatWorkedDuration(site.grossMinutes, locale)}</td>
                <td>{formatWorkedDuration(site.paidBreakMinutes, locale)}</td>
                <td>{formatWorkedDuration(site.unpaidBreakMinutes, locale)}</td>
                <td>
                  <strong>{formatWorkedDuration(site.workedMinutes, locale)}</strong>
                </td>
              </tr>
            ))}
            {report.sites.length === 0 && (
              <tr>
                <td colSpan={6} className="report-empty">
                  {ru ? 'Нет отработанных интервалов в этом периоде.' : 'No worked segments in this period.'}
                </td>
              </tr>
            )}
          </tbody>
          {report.sites.length > 0 && (
            <tfoot>
              <tr>
                <td>{ru ? 'Итого' : 'Total'}</td>
                <td>{report.total.workedDayCount}</td>
                <td>{formatWorkedDuration(report.total.grossMinutes, locale)}</td>
                <td>{formatWorkedDuration(report.total.paidBreakMinutes, locale)}</td>
                <td>{formatWorkedDuration(report.total.unpaidBreakMinutes, locale)}</td>
                <td>{formatWorkedDuration(report.total.workedMinutes, locale)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
}

function SiteDetail(props: Props & { ru: boolean; report: SiteTimeReport }) {
  const { ru, locale, report } = props;
  const makeHref = (page: number) => href({ view: 'site', periodId: report.period.id, siteId: report.site.id, page });
  return (
    <section className="report-panel">
      <div className="report-detail-head">
        <span className="report-avatar">⌂</span>
        <div>
          <h2>{report.site.name}</h2>
          <p>
            {report.period.startDate} – {report.period.endDate} · {report.summary.workerCount} {ru ? 'работников' : 'workers'}
          </p>
        </div>
      </div>
      <div className="report-kpi-grid">
        <Kpi label={ru ? 'Отработано' : 'Worked'} value={formatWorkedDuration(report.summary.workedMinutes, locale)} note={`${report.summary.workedDayCount} ${ru ? 'дней' : 'days'}`} />
        <Kpi label={ru ? 'Всего (gross)' : 'Gross time'} value={formatWorkedDuration(report.summary.grossMinutes, locale)} note={`${report.summary.segmentCount} ${ru ? 'интервалов' : 'segments'}`} />
      </div>
      <div className="report-table-wrap">
        <table className="report-table">
          <thead>
            <tr>
              <th>{ru ? 'Работник' : 'Worker'}</th>
              <th>{ru ? 'Табель' : 'Timesheet'}</th>
              <th>{ru ? 'Дни' : 'Days'}</th>
              <th>{ru ? 'Всего' : 'Gross'}</th>
              <th>{ru ? 'Отработано' : 'Worked'}</th>
            </tr>
          </thead>
          <tbody>
            {report.items.map((item) => (
              <tr key={item.employee.id}>
                <td>
                  <Link href={href({ view: 'worker', periodId: report.period.id, employeeId: item.employee.id })}>
                    {item.employee.lastName} {item.employee.firstName}
                  </Link>
                  <div className="report-muted">{item.employee.employeeNumber}</div>
                </td>
                <td>{item.timesheet ? timesheetStatusLabel(item.timesheet.status, locale) : '—'}</td>
                <td>{item.total.workedDayCount}</td>
                <td>{formatWorkedDuration(item.total.grossMinutes, locale)}</td>
                <td>
                  <strong>{formatWorkedDuration(item.total.workedMinutes, locale)}</strong>
                </td>
              </tr>
            ))}
            {report.items.length === 0 && (
              <tr>
                <td colSpan={5} className="report-empty">
                  {ru ? 'Нет работников с часами или назначениями на этом объекте.' : 'No workers with hours or assignments on this site.'}
                </td>
              </tr>
            )}
          </tbody>
          {report.items.length > 0 && (
            <tfoot>
              <tr>
                <td>{ru ? 'Итого' : 'Total'}</td>
                <td>—</td>
                <td>{report.summary.workedDayCount}</td>
                <td>{formatWorkedDuration(report.summary.grossMinutes, locale)}</td>
                <td>{formatWorkedDuration(report.summary.workedMinutes, locale)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <Pagination ru={ru} page={report.page} totalPages={report.totalPages} totalItems={report.totalItems} pageSize={report.pageSize} makeHref={makeHref} />
      <p className="report-fine-print">
        {ru
          ? 'Значение «дни» в строке «Итого» — число различных дат на объекте без двойного счёта. Минуты и интервалы — сумма строк.'
          : 'The Total “days” value is the count of distinct dates on this site. Minutes and segment counts are column sums.'}
      </p>
    </section>
  );
}

function FilesPanel(props: Omit<Props, 'filesPage'> & { ru: boolean; filesPage: ReportFilesPage }) {
  const { ru, filesPage, selectedPeriodId } = props;
  const makeHref = (page: number) => href({ view: 'files', periodId: selectedPeriodId, filesPage: page });
  return (
    <section className="report-panel">
      <div className="report-panel-heading">
        <div>
          <h2>{ru ? 'Сохранённые рабочие файлы' : 'Saved working report files'}</h2>
          <p>
            {ru
              ? 'PDF и CSV, созданные в этом центре для выбранного периода. Остаются здесь, пока вы их не удалите.'
              : 'PDF and CSV files created here for the selected period. They stay until you remove them.'}
          </p>
        </div>
      </div>
      {filesPage.items.length === 0 ? (
        <p className="report-empty">{ru ? 'Сохранённых файлов для этого периода пока нет.' : 'No saved files for this period yet.'}</p>
      ) : (
        <ul className="report-file-list">
          {filesPage.items.map((file) => (
            <li className="report-file-row" key={file.id}>
              <div className="report-file-main">
                <strong>{file.fileName}</strong>
                <span>
                  {file.format} · {file.reportType} · {Math.max(1, Math.round(file.fileSizeBytes / 1024))} KB
                  {file.rowCount != null ? ` · ${file.rowCount} ${ru ? 'строк' : 'rows'}` : ''} · {formatHelsinkiDateTime(file.createdAt)}
                </span>
              </div>
              <div className="report-file-actions">
                <Link href={file.downloadUrl}>{ru ? 'Скачать' : 'Download'}</Link>
                <ReportFileDeleteButton fileId={file.id} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <Pagination
        ru={ru}
        page={filesPage.page}
        totalPages={filesPage.totalPages}
        totalItems={filesPage.totalItems}
        pageSize={filesPage.pageSize}
        makeHref={makeHref}
      />
    </section>
  );
}

function Kpi({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="report-kpi">
      <p className="report-kpi-label">{label}</p>
      <p className="report-kpi-value">{value}</p>
      <p className="report-kpi-note">{note}</p>
    </div>
  );
}
