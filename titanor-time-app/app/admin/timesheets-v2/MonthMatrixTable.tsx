import Link from 'next/link';
import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import { formatMatrixHours, shiftMonth, type MatrixCell, type MonthlyMatrix } from '@/lib/reporting/monthly-matrix';
import { MoveHoursButton, type MoveTarget } from './MoveHoursButton';

// Табель v2 — shared month UI: the month picker and the customer-style month grid (workers down,
// days across, per-day sums underneath; scrolls sideways with the worker columns pinned). Cell
// colours mirror the customer's own spreadsheet and stay the same in every admin theme.

const WEEKDAYS_RU = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const WEEKDAYS_EN = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function monthTitle(locale: AppLocale, month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return `${(locale === 'RU' ? MONTHS_RU : MONTHS_EN)[monthNumber - 1]} ${year}`;
}

export function formatHoursLabel(locale: AppLocale, minutes: number): string {
  return `${formatMatrixHours(minutes) || '0'} ${localeText(locale, 'h', 'ч')}`;
}

function dayTypeLabel(locale: AppLocale, dayType: string | null): string {
  switch (dayType) {
    case 'SICK_LEAVE': return localeText(locale, 'Sick leave', 'Больничный');
    case 'VACATION': return localeText(locale, 'Vacation', 'Отпуск');
    case 'UNPAID_LEAVE': return localeText(locale, 'Unpaid leave', 'Отпуск за свой счёт');
    case 'PUBLIC_HOLIDAY': return localeText(locale, 'Public holiday', 'Праздник');
    case 'OTHER': return localeText(locale, 'Other absence', 'Другое отсутствие');
    default: return localeText(locale, 'Did not work', 'Не вышел');
  }
}

function cellTitle(locale: AppLocale, cell: MatrixCell): string {
  const date = `${cell.date.slice(8, 10)}.${cell.date.slice(5, 7)}.${cell.date.slice(0, 4)}`;
  if (cell.manual) return `${date} · ${cell.kind === 'OFF' ? 'OFF' : formatHoursLabel(locale, cell.workedMinutes)} · ${localeText(locale, 'entered manually', 'вписано вручную')}`;
  if (cell.kind === 'WORK') {
    const capped = cell.capped ? ` · ${localeText(locale, 'recorded', 'по факту')} ${formatHoursLabel(locale, cell.recordedMinutes)}, ${localeText(locale, 'counted by the schedule', 'засчитано по графику')}` : '';
    return `${date} · ${formatHoursLabel(locale, cell.workedMinutes)}${capped}${cell.draft ? ` · ${localeText(locale, 'not submitted yet', 'ещё не отправлено')}` : ''}`;
  }
  if (cell.kind === 'OFF') return `${date} · ${dayTypeLabel(locale, cell.dayType)}`;
  if (cell.kind === 'WEEKEND') return `${date} · ${cell.dayType ? dayTypeLabel(locale, cell.dayType) : localeText(locale, 'Weekend', 'Выходной')}`;
  return date;
}

/** Plain GET form: ‹ month › plus a month input; `basePath` keeps the customer the user is on. */
export function MonthPicker({ locale, month, basePath, editHref }: { locale: AppLocale; month: string; basePath: string; editHref?: string }) {
  return (
    <form method="GET" action={basePath} className="month-matrix-toolbar">
      <Link href={`${basePath}?month=${shiftMonth(month, -1)}`} className="month-matrix-step" aria-label={localeText(locale, 'Previous month', 'Предыдущий месяц')}>‹</Link>
      <strong className="month-matrix-title">{monthTitle(locale, month)}</strong>
      <Link href={`${basePath}?month=${shiftMonth(month, 1)}`} className="month-matrix-step" aria-label={localeText(locale, 'Next month', 'Следующий месяц')}>›</Link>
      <label>
        <span className="sr-only">{localeText(locale, 'Month', 'Месяц')}</span>
        <input type="month" name="month" defaultValue={month} />
      </label>
      <button type="submit" className="exc-apply-button">{localeText(locale, 'Show', 'Показать')}</button>
      {editHref && <a href={editHref} className="month-matrix-edit-link">✎ {localeText(locale, 'Edit timesheet', 'Редактировать табель')}</a>}
    </form>
  );
}

export interface MoveHoursConfig { siteId: string; fromWorkArea: string; fromName: string; targets: MoveTarget[] }

export function MonthMatrixTable({ locale, matrix, caption, move }: { locale: AppLocale; matrix: MonthlyMatrix; caption: string; move?: MoveHoursConfig }) {
  const weekdays = locale === 'RU' ? WEEKDAYS_RU : WEEKDAYS_EN;
  return (
    <>
      <div className="month-matrix-scroll" tabIndex={0} role="region" aria-label={caption}>
        <table className="month-matrix">
          <thead>
            <tr>
              <th className="mm-sticky mm-nr" scope="col">Nr.</th>
              <th className="mm-sticky mm-last" scope="col">{localeText(locale, 'Surname', 'Фамилия')}</th>
              <th className="mm-sticky mm-first" scope="col">{localeText(locale, 'Name', 'Имя')}</th>
              <th className="mm-number" scope="col">{localeText(locale, 'Emp. no.', 'Таб. №')}</th>
              {matrix.days.map((d) => (
                <th key={d.date} scope="col" className={d.weekend ? 'mm-day is-weekend' : 'mm-day'}>
                  <span>{d.day}</span>
                  <small>{weekdays[d.isoWeekday - 1]}</small>
                </th>
              ))}
              <th className="mm-total" scope="col">{localeText(locale, 'Total', 'Итого')}</th>
              {move && <th className="mm-actions" scope="col"><span className="sr-only">{localeText(locale, 'Actions', 'Действия')}</span></th>}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row, index) => (
              <tr key={row.key}>
                <td className="mm-sticky mm-nr">{index + 1}</td>
                <th className="mm-sticky mm-last" scope="row">{row.lastName}</th>
                <td className="mm-sticky mm-first">{row.firstName}</td>
                <td className="mm-number">{row.employeeNumber}</td>
                {row.cells.map((cell, i) => (
                  <td key={cell.date} className={`mm-cell is-${cell.kind.toLowerCase()}${matrix.days[i].weekend ? ' on-weekend' : ''}${cell.draft && !cell.manual ? ' is-draft' : ''}${cell.manual ? ' is-manual' : ''}`} title={cellTitle(locale, cell)}>
                    {cell.kind === 'WORK' ? formatMatrixHours(cell.workedMinutes) : cell.kind === 'OFF' ? 'OFF' : ''}
                  </td>
                ))}
                <td className="mm-total">{formatMatrixHours(row.totalMinutes)}</td>
                {move && (
                  <td className="mm-actions">
                    <MoveHoursButton locale={locale} employeeId={row.employeeId} workerName={`${row.lastName} ${row.firstName}`} siteId={move.siteId} fromWorkArea={move.fromWorkArea} fromName={move.fromName} targets={move.targets} days={row.cells.filter((c) => c.recordedMinutes > 0).map((c) => ({ date: c.date, minutes: c.recordedMinutes }))} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th className="mm-sticky mm-sum-label" colSpan={3} scope="row">{localeText(locale, 'Sum:', 'Сумма:')}</th>
              <td className="mm-number" />
              {matrix.dayTotals.map((total, i) => (
                <td key={matrix.days[i].date} className={matrix.days[i].weekend ? 'mm-day-total is-weekend' : 'mm-day-total'}>{formatMatrixHours(total) || '0'}</td>
              ))}
              <td className="mm-total">{formatMatrixHours(matrix.totalMinutes)}</td>
              {move && <td className="mm-actions" />}
            </tr>
          </tfoot>
        </table>
      </div>
      <ul className="month-matrix-legend">
        <li><span className="mm-swatch is-work" />{localeText(locale, 'Hours worked', 'Отработанные часы')}</li>
        <li><span className="mm-swatch is-weekend" />{localeText(locale, 'Weekend / public holiday', 'Выходной / праздник')}</li>
        <li><span className="mm-swatch is-off">OFF</span>{localeText(locale, 'Did not work (absence, sick leave, vacation)', 'Не вышел (отсутствие, больничный, отпуск)')}</li>
        <li><span className="mm-swatch is-work is-draft" />{localeText(locale, 'Week not submitted by the worker yet', 'Неделя ещё не отправлена работником')}</li>
        <li><span className="mm-swatch is-work is-manual" />{localeText(locale, 'Entered manually', 'Вписано вручную')}</li>
        <li className="month-matrix-legend-note">{localeText(locale, 'Hours count within the schedule template (overtime is entered manually).', 'Часы засчитываются в пределах графика шаблона (переработку вписывают вручную).')}</li>
      </ul>
    </>
  );
}
