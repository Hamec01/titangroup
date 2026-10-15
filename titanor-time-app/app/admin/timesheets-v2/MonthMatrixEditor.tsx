'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import type { MonthlyMatrix } from '@/lib/reporting/monthly-matrix';
import { cellInputText, parseCellInput } from '@/lib/timesheet-v2-cell-input';

// Табель v2 → "Редактировать табель": the month grid with one input per day cell, typed like a
// spreadsheet (hours, "10,5", "7:30", "OFF" or empty). Arrows / Enter move between cells. Only
// changed cells are sent; totals update while typing.

const WEEKDAYS_RU = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const WEEKDAYS_EN = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const CSRF_HEADERS = { 'X-Requested-With': 'titanor-time' };

function hoursText(minutes: number): string {
  return minutes > 0 ? String(Math.round((minutes / 60) * 100) / 100) : '0';
}

export function MonthMatrixEditor({ locale, matrix, siteId, workArea, viewHref }: { locale: AppLocale; matrix: MonthlyMatrix; siteId: string; workArea: string; viewHref: string }) {
  const ru = locale === 'RU';
  const weekdays = ru ? WEEKDAYS_RU : WEEKDAYS_EN;
  const initial = useMemo(() => {
    const map: Record<string, string> = {};
    for (const row of matrix.rows) row.cells.forEach((cell) => { map[`${row.employeeId}|${cell.date}`] = cellInputText(cell.kind, cell.workedMinutes); });
    return map;
  }, [matrix]);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());

  const changedKeys = Object.keys(values).filter((key) => values[key].trim().toUpperCase() !== initial[key].toUpperCase());
  const invalidKeys = new Set(Object.keys(values).filter((key) => parseCellInput(values[key]) === null));
  const dirty = changedKeys.length > 0;

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const minutesOf = (key: string) => parseCellInput(values[key])?.minutes ?? 0;
  const rowTotals = matrix.rows.map((row) => row.cells.reduce((sum, cell) => sum + minutesOf(`${row.employeeId}|${cell.date}`), 0));
  const dayTotals = matrix.days.map((day) => matrix.rows.reduce((sum, row) => sum + minutesOf(`${row.employeeId}|${day.date}`), 0));
  const grandTotal = rowTotals.reduce((a, b) => a + b, 0);

  function focusCell(r: number, c: number) {
    const row = matrix.rows[Math.max(0, Math.min(matrix.rows.length - 1, r))];
    const day = matrix.days[Math.max(0, Math.min(matrix.days.length - 1, c))];
    const input = inputs.current.get(`${row.employeeId}|${day.date}`);
    input?.focus();
    input?.select();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>, r: number, c: number) {
    const input = event.currentTarget;
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    const atEnd = input.selectionStart === input.value.length;
    const allSelected = input.selectionStart === 0 && input.selectionEnd === input.value.length;
    if (event.key === 'ArrowDown' || event.key === 'Enter') { event.preventDefault(); focusCell(r + (event.shiftKey && event.key === 'Enter' ? -1 : 1), c); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusCell(r - 1, c); }
    else if (event.key === 'ArrowLeft' && (atStart || allSelected)) { event.preventDefault(); focusCell(r, c - 1); }
    else if (event.key === 'ArrowRight' && (atEnd || allSelected)) { event.preventDefault(); focusCell(r, c + 1); }
    else if (event.key === 'Escape') { setValues((v) => ({ ...v, [input.dataset.key!]: initial[input.dataset.key!] })); }
  }

  async function save() {
    if (!dirty || invalidKeys.size) return;
    setSaving(true); setError(null);
    try {
      const changes = changedKeys.map((key) => { const [employeeId, date] = key.split('|'); return { employeeId, date, value: values[key] }; });
      const res = await fetch('/api/admin/timesheets-v2/cells', { method: 'POST', headers: { ...CSRF_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify({ siteId, workArea, month: matrix.month, changes }) });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        const code = payload?.error?.code ?? payload?.code;
        throw new Error(code === 'CONCURRENT_EDIT' ? (ru ? 'Кто-то только что сохранил эти же ячейки. Обновите страницу и повторите.' : 'Someone saved the same cells just now. Reload and try again.') : (ru ? 'Не удалось сохранить табель.' : 'Could not save the timesheet.'));
      }
      window.location.assign(viewHref);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  async function resetAll() {
    if (!window.confirm(ru ? 'Удалить все ручные правки этого заказчика за месяц и вернуть автоматические значения?' : 'Remove all manual values for this customer and month and return to the computed values?')) return;
    setSaving(true); setError(null);
    try {
      const qs = new URLSearchParams({ siteId, workArea, month: matrix.month });
      const res = await fetch(`/api/admin/timesheets-v2/cells?${qs.toString()}`, { method: 'DELETE', headers: CSRF_HEADERS });
      if (!res.ok) throw new Error(ru ? 'Не удалось вернуть автоматические значения.' : 'Could not reset the values.');
      window.location.assign(viewHref);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  const hasManual = matrix.rows.some((row) => row.cells.some((cell) => cell.manual));

  return (
    <>
      <div className="month-matrix-edit-bar" role="toolbar" aria-label={localeText(locale, 'Edit timesheet', 'Редактирование табеля')}>
        <strong>{ru ? 'Редактирование табеля' : 'Editing timesheet'}</strong>
        <span>{ru ? 'Вписывайте часы (10, 10,5, 7:30), OFF или очищайте ячейку. Стрелки и Enter — переход между ячейками.' : 'Type hours (10, 10.5, 7:30), OFF or clear a cell. Arrows and Enter move between cells.'}</span>
        <span className="month-matrix-edit-actions">
          {hasManual && <button type="button" className="month-matrix-reset" disabled={saving} onClick={() => void resetAll()}>{ru ? 'Вернуть автоматические значения' : 'Reset to computed values'}</button>}
          <a className="month-matrix-cancel" href={viewHref} onClick={(e) => { if (dirty && !window.confirm(ru ? 'Выйти без сохранения?' : 'Leave without saving?')) e.preventDefault(); }}>{ru ? 'Отмена' : 'Cancel'}</a>
          <button type="button" className="month-matrix-save" disabled={saving || !dirty || invalidKeys.size > 0} onClick={() => void save()}>
            {saving ? (ru ? 'Сохранение…' : 'Saving…') : `${ru ? 'Сохранить табель' : 'Save timesheet'}${dirty ? ` (${changedKeys.length})` : ''}`}
          </button>
        </span>
      </div>
      {invalidKeys.size > 0 && <p className="login-error" role="alert">{ru ? `Неверное значение в ячейках: ${invalidKeys.size}. Допустимо: число часов 0–24, «7:30», «OFF» или пусто.` : `Invalid value in ${invalidKeys.size} cell(s). Allowed: hours 0–24, "7:30", "OFF" or empty.`}</p>}
      {error && <p className="login-error" role="alert">{error}</p>}
      <div className="month-matrix-scroll" role="region" aria-label={localeText(locale, 'Editable month timesheet', 'Редактируемый табель за месяц')}>
        <table className="month-matrix is-editing">
          <thead>
            <tr>
              <th className="mm-sticky mm-nr" scope="col">Nr.</th>
              <th className="mm-sticky mm-last" scope="col">{localeText(locale, 'Surname', 'Фамилия')}</th>
              <th className="mm-sticky mm-first" scope="col">{localeText(locale, 'Name', 'Имя')}</th>
              <th className="mm-number" scope="col">{localeText(locale, 'Emp. no.', 'Таб. №')}</th>
              {matrix.days.map((d) => (
                <th key={d.date} scope="col" className={d.weekend ? 'mm-day is-weekend' : 'mm-day'}><span>{d.day}</span><small>{weekdays[d.isoWeekday - 1]}</small></th>
              ))}
              <th className="mm-total" scope="col">{localeText(locale, 'Total', 'Итого')}</th>
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row, r) => (
              <tr key={row.key}>
                <td className="mm-sticky mm-nr">{r + 1}</td>
                <th className="mm-sticky mm-last" scope="row">{row.lastName}</th>
                <td className="mm-sticky mm-first">{row.firstName}</td>
                <td className="mm-number">{row.employeeNumber}</td>
                {row.cells.map((cell, c) => {
                  const key = `${row.employeeId}|${cell.date}`;
                  const parsed = parseCellInput(values[key]);
                  const kind = !parsed ? 'invalid' : parsed.off ? 'off' : parsed.minutes > 0 ? 'work' : matrix.days[c].weekend ? 'weekend' : 'empty';
                  const changed = values[key].trim().toUpperCase() !== initial[key].toUpperCase();
                  return (
                    <td key={cell.date} className={`mm-cell mm-edit-cell is-${kind}${matrix.days[c].weekend ? ' on-weekend' : ''}${changed ? ' is-changed' : ''}`}>
                      <input
                        ref={(el) => { if (el) inputs.current.set(key, el); else inputs.current.delete(key); }}
                        data-key={key}
                        value={values[key]}
                        inputMode="decimal"
                        autoComplete="off"
                        aria-label={`${row.lastName} ${row.firstName}, ${cell.date}`}
                        aria-invalid={!parsed}
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                        onKeyDown={(e) => onKeyDown(e, r, c)}
                      />
                    </td>
                  );
                })}
                <td className="mm-total">{hoursText(rowTotals[r])}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th className="mm-sticky mm-sum-label" colSpan={3} scope="row">{localeText(locale, 'Sum:', 'Сумма:')}</th>
              <td className="mm-number" />
              {dayTotals.map((total, i) => <td key={matrix.days[i].date} className={matrix.days[i].weekend ? 'mm-day-total is-weekend' : 'mm-day-total'}>{hoursText(total)}</td>)}
              <td className="mm-total">{hoursText(grandTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}
