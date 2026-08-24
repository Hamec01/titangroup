'use client';

import { useState, type FormEvent } from 'react';
import { MAX_CUSTOM_REPORT_DAYS_CLIENT } from './constants';

interface Option {
  id: string;
  label: string;
}

export function CustomReportForm({
  employeeOptions,
  siteOptions,
  locale
}: {
  employeeOptions: Option[];
  siteOptions: Option[];
  locale: 'EN' | 'RU';
}) {
  const ru = locale === 'RU';
  const [error, setError] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    const form = event.currentTarget;
    const dateFrom = (form.elements.namedItem('dateFrom') as HTMLInputElement)?.value;
    const dateTo = (form.elements.namedItem('dateTo') as HTMLInputElement)?.value;
    if (!dateFrom || !dateTo) {
      event.preventDefault();
      setError(ru ? 'Укажите обе даты.' : 'Both dates are required.');
      return;
    }
    if (dateFrom > dateTo) {
      event.preventDefault();
      setError(ru ? '«Дата с» должна быть не позже «Дата по».' : '"Date from" must be on or before "Date to".');
      return;
    }
    const days = Math.round((new Date(dateTo).getTime() - new Date(dateFrom).getTime()) / 86400000) + 1;
    if (days > MAX_CUSTOM_REPORT_DAYS_CLIENT) {
      event.preventDefault();
      setError(ru ? `Диапазон не может превышать ${MAX_CUSTOM_REPORT_DAYS_CLIENT} дней.` : `The range cannot exceed ${MAX_CUSTOM_REPORT_DAYS_CLIENT} days.`);
      return;
    }
    setError(null);
    // No preventDefault — a plain GET form submission navigates to the export endpoint, which
    // responds with Content-Disposition: attachment, so the browser downloads without leaving
    // this page (same convention as /admin/export's plain <a href> downloads, never fetch+Blob).
  }

  return (
    <form method="GET" action="/api/admin/reports/custom/export" className="ov-filters" aria-label={ru ? 'Параметры произвольного отчёта' : 'Custom report parameters'} onSubmit={handleSubmit}>
      <div className="ov-filter-field">
        <label htmlFor="cr-date-from">{ru ? 'Дата с' : 'Date from'} *</label>
        <input id="cr-date-from" type="date" name="dateFrom" max={today} required />
      </div>
      <div className="ov-filter-field">
        <label htmlFor="cr-date-to">{ru ? 'Дата по' : 'Date to'} *</label>
        <input id="cr-date-to" type="date" name="dateTo" max={today} required />
      </div>

      <div className="ov-filter-field">
        <label htmlFor="cr-employees">{ru ? 'Работники' : 'Workers'}</label>
        <select id="cr-employees" name="employeeIds" multiple size={6}>
          {employeeOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <p className="setup-subtitle">{ru ? 'Ничего не выбрано = все работники' : 'Nothing selected = all workers'}</p>
      </div>

      <div className="ov-filter-field">
        <label htmlFor="cr-sites">{ru ? 'Объекты' : 'Sites'}</label>
        <select id="cr-sites" name="siteIds" multiple size={6}>
          {siteOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <p className="setup-subtitle">{ru ? 'Ничего не выбрано = все объекты' : 'Nothing selected = all sites'}</p>
      </div>

      <fieldset className="ov-filter-field">
        <legend>{ru ? 'Данные' : 'Data'}</legend>
        <label>
          <input type="radio" name="dataMode" value="FINAL_APPROVED_ONLY" defaultChecked /> {ru ? 'Только окончательно одобренные' : 'Final approved only'}
        </label>
        <br />
        <label>
          <input type="radio" name="dataMode" value="CURRENT_CANONICAL" /> {ru ? 'Текущие канонические данные' : 'Current canonical data'}
        </label>
      </fieldset>

      <fieldset className="ov-filter-field">
        <legend>{ru ? 'Детализация отчёта' : 'Report detail'}</legend>
        <label>
          <input type="radio" name="detail" value="SUMMARY" defaultChecked /> {ru ? 'Сводка' : 'Summary'}
        </label>
        <br />
        <label>
          <input type="radio" name="detail" value="DETAILED" /> {ru ? 'Детально' : 'Detailed'}
        </label>
      </fieldset>

      <fieldset className="ov-filter-field">
        <legend>{ru ? 'Формат' : 'Format'}</legend>
        <label>
          <input type="radio" name="format" value="PDF" defaultChecked /> PDF
        </label>
        <br />
        <label>
          <input type="radio" name="format" value="CSV" /> CSV
        </label>
      </fieldset>

      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="ov-filter-actions">
        <button type="submit" className="exc-apply-button">
          {ru ? 'Сформировать отчёт' : 'Generate report'}
        </button>
      </div>
    </form>
  );
}
