'use client';

import { useState } from 'react';
import { localeText } from '@/lib/i18n/locale';

interface Option {
  id: string;
  label: string;
}
interface Blocker {
  employeeName: string;
  employeeNumber: string;
  periodLabel: string;
  timesheetId: string;
  status: string;
  link: string;
}
interface Preview {
  readiness: { level: string; blockers: Blocker[]; noData: { employeeName: string; periodLabel: string }[]; coveredTimesheetCount: number };
  report: { dailyRows: unknown[]; grandTotal: { workedMinutes: number; workedDays: number }; sites: { name: string }[] };
}

function hoursLabel(minutes: number, ru: boolean): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return ru ? `${h} ч ${m} мин` : `${h} h ${m} min`;
}

export function CustomerHoursForm({ employeeOptions, siteOptions, locale }: { employeeOptions: Option[]; siteOptions: Option[]; locale: 'EN' | 'RU' }) {
  const ru = locale === 'RU';
  const today = new Date().toISOString().slice(0, 10);

  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [customer, setCustomer] = useState('');
  const [projectReference, setProjectReference] = useState('');
  const [employeeIds, setEmployeeIds] = useState<string[]>([]);
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  function params(extra: Record<string, string>): string {
    const p = new URLSearchParams();
    if (dateFrom) p.set('dateFrom', dateFrom);
    if (dateTo) p.set('dateTo', dateTo);
    if (customer.trim()) p.set('customer', customer.trim());
    if (projectReference.trim()) p.set('projectReference', projectReference.trim());
    for (const id of employeeIds) p.append('employeeIds', id);
    for (const id of siteIds) p.append('siteIds', id);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p.toString();
  }

  async function handlePreview() {
    setError(null);
    if (!dateFrom || !dateTo) {
      setError(ru ? 'Укажите обе даты.' : 'Both dates are required.');
      return;
    }
    if (dateFrom > dateTo) {
      setError(ru ? '«Дата с» должна быть не позже «Дата по».' : '"Date from" must be on or before "Date to".');
      return;
    }
    setBusy(true);
    setPreview(null);
    try {
      const r = await fetch(`/api/admin/reports/customer/export?${params({ preview: '1', mode: 'PREVIEW' })}`, { credentials: 'same-origin' });
      if (!r.ok) {
        setError(ru ? 'Не удалось получить предпросмотр.' : 'Could not load the preview.');
        return;
      }
      setPreview(await r.json());
    } catch {
      setError(ru ? 'Ошибка сети.' : 'Network error.');
    } finally {
      setBusy(false);
    }
  }

  const ready = preview?.readiness.level === 'CUSTOMER_FINAL';

  return (
    <div className="ov-filters" style={{ display: 'grid', gap: 12 }}>
      <div className="ov-filter-field">
        <label htmlFor="ch-from">{ru ? 'Дата с' : 'Date from'} *</label>
        <input id="ch-from" type="date" max={today} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
      </div>
      <div className="ov-filter-field">
        <label htmlFor="ch-to">{ru ? 'Дата по' : 'Date to'} *</label>
        <input id="ch-to" type="date" max={today} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
      </div>
      <div className="ov-filter-field">
        <label htmlFor="ch-customer">{ru ? 'Заказчик / получатель' : 'Customer / recipient'}</label>
        <input id="ch-customer" type="text" maxLength={200} value={customer} onChange={(e) => setCustomer(e.target.value)} />
      </div>
      <div className="ov-filter-field">
        <label htmlFor="ch-project">{ru ? 'Проект / ссылка' : 'Project / reference'}</label>
        <input id="ch-project" type="text" maxLength={200} value={projectReference} onChange={(e) => setProjectReference(e.target.value)} />
      </div>
      <div className="ov-filter-field">
        <label htmlFor="ch-employees">{ru ? 'Работники' : 'Workers'}</label>
        <select id="ch-employees" multiple size={6} value={employeeIds} onChange={(e) => setEmployeeIds([...e.target.selectedOptions].map((o) => o.value))}>
          {employeeOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <p className="setup-subtitle">{ru ? 'Ничего не выбрано = все работники' : 'Nothing selected = all workers'}</p>
      </div>
      <div className="ov-filter-field">
        <label htmlFor="ch-sites">{ru ? 'Объекты' : 'Sites'}</label>
        <select id="ch-sites" multiple size={6} value={siteIds} onChange={(e) => setSiteIds([...e.target.selectedOptions].map((o) => o.value))}>
          {siteOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <p className="setup-subtitle">{ru ? 'Ничего не выбрано = все объекты' : 'Nothing selected = all sites'}</p>
      </div>

      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="ov-filter-actions">
        <button type="button" className="exc-apply-button" onClick={handlePreview} disabled={busy}>
          {busy ? (ru ? 'Загрузка…' : 'Loading…') : ru ? 'Показать и проверить' : 'Show & check'}
        </button>
      </div>

      {preview ? (
        <div className="setup-item setup-item-column" style={{ display: 'grid', gap: 8 }}>
          <p>
            <strong>{ru ? 'Готовность: ' : 'Readiness: '}</strong>
            {ready ? (
              <span style={{ color: '#1f7a3d' }}>{ru ? 'все табели окончательно одобрены — можно отправлять заказчику' : 'all timesheets final-approved — ready for the customer'}</span>
            ) : (
              <span style={{ color: '#a34d00' }}>{ru ? 'есть неутверждённые табели — финальная выгрузка заблокирована' : 'some timesheets are not final-approved — final export is blocked'}</span>
            )}
          </p>
          <p className="setup-subtitle">
            {ru ? 'Итого отработано: ' : 'Total worked: '}
            {hoursLabel(preview.report.grandTotal.workedMinutes, ru)} · {preview.report.grandTotal.workedDays} {ru ? 'раб. дн.' : 'worked days'} · {preview.report.dailyRows.length} {ru ? 'строк' : 'rows'}
          </p>

          {preview.readiness.blockers.length > 0 ? (
            <div>
              <p>
                <strong>{ru ? 'Не окончательно одобрены:' : 'Not final-approved:'}</strong>
              </p>
              <ul className="setup-list">
                {preview.readiness.blockers.map((b) => (
                  <li key={b.timesheetId} className="setup-item">
                    <a href={b.link}>
                      {b.employeeName} · {b.periodLabel} · {b.status}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {preview.readiness.noData.length > 0 ? (
            <p className="setup-subtitle">
              {ru ? 'Не сдали табель: ' : 'Not submitted: '}
              {preview.readiness.noData.map((n) => `${n.employeeName} (${n.periodLabel})`).join(', ')}
            </p>
          ) : null}

          <div className="wk-switch-actions">
            <a
              className="login-submit"
              style={{ display: 'inline-block', textAlign: 'center', textDecoration: 'none', opacity: ready ? 1 : 0.5, pointerEvents: ready ? 'auto' : 'none' }}
              href={`/api/admin/reports/customer/export?${params({ mode: 'FINAL', format: 'PDF' })}`}
            >
              {ru ? 'Скачать PDF (финал)' : 'Download PDF (final)'}
            </a>
            <a
              className="wk-inline-secondary"
              style={{ opacity: ready ? 1 : 0.5, pointerEvents: ready ? 'auto' : 'none' }}
              href={`/api/admin/reports/customer/export?${params({ mode: 'FINAL', format: 'CSV' })}`}
            >
              {ru ? 'Скачать CSV (финал)' : 'Download CSV (final)'}
            </a>
            <a className="wk-inline-secondary" href={`/api/admin/reports/customer/export?${params({ mode: 'PREVIEW', format: 'PDF' })}`}>
              {ru ? 'Внутренний предпросмотр PDF (не финал)' : 'Internal preview PDF (not final)'}
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}
