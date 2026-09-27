import Link from 'next/link';
import type { AppLocale } from '@/lib/i18n/locale';
import { formatWorkedDuration } from '@/lib/reporting/report-format';
import type { ReportWeekDetail, ReportWeekGroupBy, ReportWeekQuery, ReportWeekRow } from '@/lib/reporting/report-week-detail';
import { utcIsoToHelsinkiTime } from '@/lib/helsinki-datetime';

function href(periodId: string, query: ReportWeekQuery, changes: Partial<ReportWeekQuery> = {}): string {
  const next = { ...query, ...changes };
  const params = new URLSearchParams({ view: 'overview', periodId, groupBy: next.groupBy });
  if (next.sort !== 'name_asc') params.set('sort', next.sort);
  if (next.customerId) params.set('customerId', next.customerId);
  if (next.siteId) params.set('reportSiteId', next.siteId);
  if (next.employeeSearch) params.set('employeeSearch', next.employeeSearch);
  if (next.status !== 'all') params.set('reportStatus', next.status);
  if (next.onlyIssues) params.set('onlyIssues', 'true');
  return `/admin/reports?${params.toString()}`;
}

function compactMinutes(minutes: number, confirmedZero = false): string {
  if (minutes <= 0) return confirmedZero ? '0:00' : '—';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}:${String(mins).padStart(2, '0')}`;
}

function dateHeader(date: string, locale: AppLocale): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  const weekday = new Intl.DateTimeFormat(locale === 'RU' ? 'ru-RU' : 'en-GB', { weekday: 'short', timeZone: 'UTC' }).format(parsed).replace('.', '');
  const [, month, day] = date.split('-');
  return `${weekday} ${day}.${month}`;
}

function statusText(status: ReportWeekRow['status'], locale: AppLocale): string {
  const ru = locale === 'RU';
  if (status === 'approved') return ru ? 'Одобрено' : 'Approved';
  if (status === 'attention') return ru ? 'Требует внимания' : 'Needs attention';
  if (status === 'changed') return ru ? 'Изменено' : 'Changed';
  return ru ? 'Готово' : 'Ready';
}

function statusClass(status: ReportWeekRow['status']): string {
  if (status === 'approved') return 'report-week-status-success';
  if (status === 'attention' || status === 'changed') return 'report-week-status-warning';
  return 'report-week-status-neutral';
}

export function ReportWeekDetailView({
  locale,
  periodId,
  detail,
  query,
  truncated
}: {
  locale: AppLocale;
  periodId: string;
  detail: ReportWeekDetail;
  query: ReportWeekQuery;
  truncated: boolean;
}) {
  const ru = locale === 'RU';
  const groupLabels: Record<ReportWeekGroupBy, string> = {
    all: ru ? 'Вся неделя' : 'Whole week',
    customer: ru ? 'По заказчику' : 'By customer',
    site: ru ? 'По объекту' : 'By site',
    worker: ru ? 'По работнику' : 'By worker'
  };

  return (
    <section className="report-week-section" aria-labelledby="report-week-title">
      <div className="report-week-heading">
        <div>
          <h2 id="report-week-title">{ru ? 'Детализация периода' : 'Period detail'}</h2>
          <p>{ru ? 'Только просмотр · канонические данные из Табеля' : 'Read only · canonical Timesheet data'}</p>
        </div>
        <span className="report-week-visible-count">
          {detail.visibleRowCount} {ru ? 'строк' : 'rows'}
        </span>
      </div>

      <div className="report-week-toolbar">
        <div className="report-week-group-switch" aria-label={ru ? 'Группировка отчёта' : 'Report grouping'}>
          <span>{ru ? 'Показать:' : 'Show:'}</span>
          {(['all', 'customer', 'site', 'worker'] as ReportWeekGroupBy[]).map((groupBy) => (
            <Link
              key={groupBy}
              href={href(periodId, query, { groupBy })}
              className={query.groupBy === groupBy ? 'report-week-group-option is-active' : 'report-week-group-option'}
              aria-current={query.groupBy === groupBy ? 'page' : undefined}
            >
              {groupLabels[groupBy]}
            </Link>
          ))}
        </div>

        <form className="report-week-filters" method="GET" action="/admin/reports">
          <input type="hidden" name="view" value="overview" />
          <input type="hidden" name="periodId" value={periodId} />
          <input type="hidden" name="groupBy" value={query.groupBy} />
          <label>
            <span>{ru ? 'Заказчик' : 'Customer'}</span>
            <select name="customerId" defaultValue={query.customerId ?? ''}>
              <option value="">{ru ? 'Все' : 'All'}</option>
              {detail.customerOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{ru ? 'Объект' : 'Site'}</span>
            <select name="reportSiteId" defaultValue={query.siteId ?? ''}>
              <option value="">{ru ? 'Все' : 'All'}</option>
              {detail.siteOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="report-week-search">
            <span>{ru ? 'Работник' : 'Worker'}</span>
            <input name="employeeSearch" defaultValue={query.employeeSearch ?? ''} placeholder={ru ? 'Имя или номер' : 'Name or number'} />
          </label>
          <label>
            <span>{ru ? 'Статус' : 'Status'}</span>
            <select name="reportStatus" defaultValue={query.status}>
              <option value="all">{ru ? 'Все' : 'All'}</option>
              <option value="approved">{ru ? 'Одобрено' : 'Approved'}</option>
              <option value="attention">{ru ? 'Требует внимания' : 'Needs attention'}</option>
              <option value="changed">{ru ? 'Изменено' : 'Changed'}</option>
              <option value="ready">{ru ? 'Готово' : 'Ready'}</option>
              <option value="not_submitted">{ru ? 'Не сдано' : 'Not submitted'}</option>
              <option value="source_error">{ru ? 'Ошибка данных' : 'Data error'}</option>
            </select>
          </label>
          <label>
            <span>{ru ? 'Сортировка' : 'Sort'}</span>
            <select name="sort" defaultValue={query.sort}>
              <option value="name_asc">{ru ? 'По алфавиту' : 'Alphabetical'}</option>
              <option value="hours_desc">{ru ? 'Сначала больше часов' : 'Most hours first'}</option>
              <option value="hours_asc">{ru ? 'Сначала меньше часов' : 'Fewest hours first'}</option>
              <option value="attention_first">{ru ? 'Проблемные сначала' : 'Attention first'}</option>
            </select>
          </label>
          <label className="report-week-only-issues">
            <input type="checkbox" name="onlyIssues" value="true" defaultChecked={query.onlyIssues} />
            <span>{ru ? 'Только с замечаниями' : 'Issues only'}</span>
          </label>
          <div className="report-week-filter-actions">
            <button type="submit" className="report-filter-submit">
              {ru ? 'Применить' : 'Apply'}
            </button>
            <Link href={`/admin/reports?view=overview&periodId=${encodeURIComponent(periodId)}&groupBy=${query.groupBy}`} className="report-filter-reset">
              {ru ? 'Сбросить' : 'Reset'}
            </Link>
          </div>
        </form>
      </div>

      {truncated ? (
        <p className="report-alert" role="alert">
          {ru ? 'В периоде слишком много строк для одного экрана. Уточните фильтры.' : 'This period has too many rows for one screen. Narrow the filters.'}
        </p>
      ) : null}

      {detail.groups.map((group) => (
        <details className="report-week-group" key={group.key} open>
          <summary>
            <span className="report-week-group-title">
              {query.groupBy === 'all' ? (ru ? 'Все работники' : 'All workers') : group.title}
              {group.subtitle && group.subtitle !== group.title ? <small> · {group.subtitle}</small> : null}
            </span>
            <span>
              {group.workerCount} {ru ? 'работников' : 'workers'} · <strong>{formatWorkedDuration(group.workedMinutes, locale)}</strong>
              {group.issueCount > 0 ? ` · ${group.issueCount} ${ru ? 'замеч.' : 'issues'}` : ''}
            </span>
          </summary>
          <WeekTable locale={locale} dates={detail.dates} rows={group.rows} groupDays={group.days} groupWorkedMinutes={group.workedMinutes} />
        </details>
      ))}

      {detail.missing.length > 0 ? (
        <section className="report-week-missing">
          <h3>{ru ? 'Не сдали табель' : 'Not submitted'}</h3>
          <ul>
            {detail.missing.map((row) => (
              <li key={`${row.employeeId}:${row.periodId}`}>
                <span>{row.employeeName} · #{row.employeeNumber}</span>
                <span>{row.timesheetStatus === 'RETURNED' ? (ru ? 'Возвращён работнику' : 'Returned to worker') : ru ? 'Ещё не сдан' : 'Not submitted yet'}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {detail.sourceErrors.length > 0 ? (
        <section className="report-week-errors" role="status">
          <h3>{ru ? 'Ошибки данных' : 'Data errors'}</h3>
          <ul>
            {detail.sourceErrors.map((row) => (
              <li key={row.timesheetId}>{row.employeeName} · #{row.employeeNumber}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {detail.visibleRowCount === 0 ? (
        <div className="report-week-empty">
          <p>{ru ? 'По выбранным условиям строки не найдены.' : 'No rows match these filters.'}</p>
          <Link href={`/admin/reports?view=overview&periodId=${encodeURIComponent(periodId)}&groupBy=${query.groupBy}`}>{ru ? 'Сбросить фильтры' : 'Reset filters'}</Link>
        </div>
      ) : null}
    </section>
  );
}

function WeekTable({
  locale,
  dates,
  rows,
  groupDays,
  groupWorkedMinutes
}: {
  locale: AppLocale;
  dates: string[];
  rows: ReportWeekRow[];
  groupDays: ReportWeekDetail['groups'][number]['days'];
  groupWorkedMinutes: number;
}) {
  const ru = locale === 'RU';
  return (
    <div className="report-week-table-wrap">
      <table className="report-week-table">
        <thead>
          <tr>
            <th scope="col">{ru ? 'Работник' : 'Worker'}</th>
            {dates.map((date) => (
              <th scope="col" key={date}>{dateHeader(date, locale)}</th>
            ))}
            <th scope="col">{ru ? 'Итого' : 'Total'}</th>
            <th scope="col">{ru ? 'Статус' : 'Status'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" className="report-week-worker-cell">
                <span>{row.subjectLabel ?? row.employeeName}</span>
                <small>{row.subjectLabel ? `${row.employeeName} · #${row.employeeNumber}` : `#${row.employeeNumber}`}</small>
                {row.days.some((day) => day.intervals.length > 0) ? (
                  <details className="report-week-row-details">
                    <summary>{ru ? 'Интервалы и перерывы' : 'Intervals and breaks'}</summary>
                    <ul>
                      {row.days.flatMap((day) =>
                        day.intervals.map((interval, index) => (
                          <li key={`${day.date}:${interval.startAt}:${index}`}>
                            <strong>{dateHeader(day.date, locale)}</strong>: {utcIsoToHelsinkiTime(interval.startAt)}–{utcIsoToHelsinkiTime(interval.endAt)} · {interval.customerName} · {interval.siteName}
                          </li>
                        ))
                      )}
                    </ul>
                  </details>
                ) : null}
              </th>
              {row.days.map((day) => (
                <td key={day.date} title={day.dayTypes.join(', ')}>{compactMinutes(day.workedMinutes, day.confirmedZero)}</td>
              ))}
              <td className="report-week-total-cell">
                <strong>{formatWorkedDuration(row.workedMinutes, locale)}</strong>
                <small>{ru ? 'gross' : 'gross'} {compactMinutes(row.grossMinutes)} · {ru ? 'пер.' : 'break'} {compactMinutes(row.breakMinutes)}</small>
              </td>
              <td>
                <span className={`report-week-status ${statusClass(row.status)}`}>{statusText(row.status, locale)}</span>
                {row.issueCount > 0 ? <small className="report-week-issue-count">{row.issueCount} {ru ? 'замеч.' : 'issues'}</small> : null}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">{ru ? 'Итого по группе' : 'Group total'}</th>
            {groupDays.map((day) => <td key={day.date}>{compactMinutes(day.workedMinutes)}</td>)}
            <td><strong>{formatWorkedDuration(groupWorkedMinutes, locale)}</strong></td>
            <td>—</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
