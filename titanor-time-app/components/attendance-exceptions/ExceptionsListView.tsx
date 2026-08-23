import Link from 'next/link';
import type { ExceptionListResult } from '@/lib/attendance-exceptions';
import { EXCEPTION_TYPE_VALUES, EXCEPTION_STATUS_VALUES } from '@/lib/attendance-exceptions';
import {
  exceptionTypeLabel,
  exceptionStatusLabel,
  exceptionStatusBadgeClass,
  channelLabel,
  gpsVerificationLabel,
  formatDateTime,
  buildExceptionsQueryString
} from '@/lib/attendance-exceptions-ui';
import type { AppLocale } from '@/lib/i18n/locale';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §11/§12.1/§12.3 — T7A.8C.1. Pure presentation:
// given already-validated filters and an already-scoped ExceptionListResult (or a validation
// failure), render the list. All scope/filter/pagination logic stays in
// lib/attendance-exceptions.ts — this component never queries the database itself. Shared verbatim
// by the admin and foreman list pages, which differ only in basePath/permission/scope.

export interface ExceptionsListRawQuery {
  status: string | null;
  type: string | null;
  from: string | null;
  to: string | null;
  /** Supported as a URL filter (no picker UI this slice, per T7A.8C.1 scope) — carried through as
   * hidden fields so submitting the visible filter form or paging doesn't silently drop it. */
  siteId: string | null;
  employeeId: string | null;
  payrollPeriodId: string | null;
}

export type ExceptionsListOutcome =
  | { kind: 'invalid'; fieldErrors: Record<string, string[]> }
  | { kind: 'ok'; result: ExceptionListResult; emptyNoAssignedSites?: boolean };

interface Props {
  basePath: string;
  title: string;
  rawQuery: ExceptionsListRawQuery;
  outcome: ExceptionsListOutcome;
  locale: AppLocale;
}

export function ExceptionsListView({ basePath, title, rawQuery, outcome, locale }: Props) {
  const ru = locale === 'RU';
  const statusValue = rawQuery.status ?? 'OPEN';

  return (
    <div className="setup-card worker-card exc-card">
      <h1>{title}</h1>

      <form method="GET" action={basePath} className="exc-filters" aria-label={ru ? 'Фильтр исключений' : 'Filter exceptions'}>
        {rawQuery.siteId && <input type="hidden" name="siteId" value={rawQuery.siteId} />}
        {rawQuery.employeeId && <input type="hidden" name="employeeId" value={rawQuery.employeeId} />}
        {rawQuery.payrollPeriodId && <input type="hidden" name="payrollPeriodId" value={rawQuery.payrollPeriodId} />}
        <div className="exc-filter-field">
          <label htmlFor="exc-filter-status">{ru ? 'Статус' : 'Status'}</label>
          <select id="exc-filter-status" name="status" defaultValue={statusValue}>
            {EXCEPTION_STATUS_VALUES.map((s) => (
              <option key={s} value={s}>
                {exceptionStatusLabel(s, locale)}
              </option>
            ))}
          </select>
        </div>
        <div className="exc-filter-field">
          <label htmlFor="exc-filter-type">{ru ? 'Тип' : 'Type'}</label>
          <select id="exc-filter-type" name="type" defaultValue={rawQuery.type ?? ''}>
            <option value="">{ru ? 'Все типы' : 'All types'}</option>
            {EXCEPTION_TYPE_VALUES.map((t) => (
              <option key={t} value={t}>
                {exceptionTypeLabel(t, locale)}
              </option>
            ))}
          </select>
        </div>
        <div className="exc-filter-field">
          <label htmlFor="exc-filter-from">{ru ? 'С' : 'From'}</label>
          <input id="exc-filter-from" type="date" name="from" defaultValue={rawQuery.from ?? ''} />
        </div>
        <div className="exc-filter-field">
          <label htmlFor="exc-filter-to">{ru ? 'По' : 'To'}</label>
          <input id="exc-filter-to" type="date" name="to" defaultValue={rawQuery.to ?? ''} />
        </div>
        <div className="exc-filter-actions">
          <button type="submit" className="exc-apply-button">
            {ru ? 'Применить фильтры' : 'Apply filters'}
          </button>
          <Link href={basePath} className="exc-reset-link">
            {ru ? 'Сбросить' : 'Reset'}
          </Link>
        </div>
      </form>

      {outcome.kind === 'invalid' ? (
        <p className="login-error" role="alert">
          {ru ? 'Эти фильтры некорректны:' : "These filters aren't valid:"} {Object.entries(outcome.fieldErrors).map(([field, msgs]) => `${field} ${msgs.join(', ')}`).join('; ')}
        </p>
      ) : (
        <ExceptionsListBody basePath={basePath} rawQuery={rawQuery} result={outcome.result} emptyNoAssignedSites={outcome.emptyNoAssignedSites ?? false} locale={locale} />
      )}
    </div>
  );
}

function ExceptionsListBody({
  basePath,
  rawQuery,
  result,
  emptyNoAssignedSites,
  locale
}: {
  basePath: string;
  rawQuery: ExceptionsListRawQuery;
  result: ExceptionListResult;
  emptyNoAssignedSites: boolean;
  locale: AppLocale;
}) {
  const ru = locale === 'RU';
  if (result.totalItems === 0) {
    return (
      <p className="wk-empty" role="status" aria-live="polite">
        {emptyNoAssignedSites
          ? (ru ? 'У вас пока нет текущих назначений на объекты как у прораба.' : 'You have no current site assignments as a foreman yet.')
          : (ru ? 'Нет исключений, соответствующих этим фильтрам.' : 'No exceptions match these filters.')}
      </p>
    );
  }

  const pageHref = (page: number) =>
    `${basePath}${buildExceptionsQueryString({
      status: rawQuery.status,
      type: rawQuery.type,
      from: rawQuery.from,
      to: rawQuery.to,
      siteId: rawQuery.siteId,
      employeeId: rawQuery.employeeId,
      payrollPeriodId: rawQuery.payrollPeriodId,
      page
    })}`;

  return (
    <>
      <p className="setup-subtitle" role="status" aria-live="polite">
        {ru
          ? `Исключений: ${result.totalItems} · страница ${result.page} из ${result.totalPages}`
          : `${result.totalItems} exception${result.totalItems === 1 ? '' : 's'} · page ${result.page} of ${result.totalPages}`}
      </p>

      <div className="exc-row-head" aria-hidden="true">
        <span>{ru ? 'Тип' : 'Type'}</span>
        <span>{ru ? 'Статус' : 'Status'}</span>
        <span>{ru ? 'Работник' : 'Employee'}</span>
        <span>{ru ? 'Объект' : 'Site'}</span>
        <span>{ru ? 'Произошло' : 'Occurred'}</span>
        <span>{ru ? 'Источник' : 'Source'}</span>
        <span>{ru ? 'Период' : 'Period'}</span>
      </div>

      <ul className="exc-list">
        {result.items.map((item) => (
          <li key={item.id}>
            <Link href={`${basePath}/${item.id}`} className="exc-row">
              <span className="exc-cell exc-cell-type">
                <span className="exc-field-label">{ru ? 'Тип' : 'Type'}</span>
                <span className="exc-type-name">{exceptionTypeLabel(item.type, locale)}</span>
                <span className="exc-summary">{item.summary}</span>
              </span>
              <span className="exc-cell">
                <span className="exc-field-label">{ru ? 'Статус' : 'Status'}</span>
                <span className={exceptionStatusBadgeClass(item.status)}>{exceptionStatusLabel(item.status, locale)}</span>
              </span>
              <span className="exc-cell">
                <span className="exc-field-label">{ru ? 'Работник' : 'Employee'}</span>
                {item.employee.name}
              </span>
              <span className="exc-cell">
                <span className="exc-field-label">{ru ? 'Объект' : 'Site'}</span>
                {item.site ? item.site.name : '—'}
              </span>
              <span className="exc-cell">
                <span className="exc-field-label">{ru ? 'Произошло' : 'Occurred'}</span>
                {formatDateTime(item.occurredAt)}
              </span>
              <span className="exc-cell">
                <span className="exc-field-label">{ru ? 'Источник' : 'Source'}</span>
                {item.clockEventSummary ? (
                  <>
                    {channelLabel(item.clockEventSummary.channel, locale)}
                    <br />
                    <span className="exc-muted">{gpsVerificationLabel(item.clockEventSummary.gpsVerification, locale)}</span>
                  </>
                ) : (
                  '—'
                )}
              </span>
              <span className="exc-cell">
                <span className="exc-field-label">{ru ? 'Период' : 'Period'}</span>
                {item.payrollPeriod ? `${item.payrollPeriod.startDate} – ${item.payrollPeriod.endDate}` : '—'}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <nav className="exc-pagination" aria-label={ru ? 'Постраничная навигация' : 'Pagination'}>
        {result.page > 1 ? (
          <Link href={pageHref(result.page - 1)}>{ru ? 'Назад' : 'Previous'}</Link>
        ) : (
          <span className="exc-pagination-disabled">{ru ? 'Назад' : 'Previous'}</span>
        )}
        <span>
          {ru ? `Страница ${result.page} из ${result.totalPages}` : `Page ${result.page} of ${result.totalPages}`}
        </span>
        {result.page < result.totalPages ? (
          <Link href={pageHref(result.page + 1)}>{ru ? 'Далее' : 'Next'}</Link>
        ) : (
          <span className="exc-pagination-disabled">{ru ? 'Далее' : 'Next'}</span>
        )}
      </nav>
    </>
  );
}
