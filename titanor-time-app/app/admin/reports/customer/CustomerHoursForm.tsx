'use client';

// R15-D7 Deploy F — "Часы заказчику". Flow: dates → pick one or more REAL customers (search by
// customer + site name) → per-customer cards → paginated worker list (20/page, cross-page
// selection) → preview → download PDF / CSV. The URL is the source of truth (reload, Back/Forward,
// shared link all reproduce the selection). The customer name/site for the document come from the
// server by id — never from this component.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { localeText } from '@/lib/i18n/locale';
import type { AppLocale } from '@/lib/i18n/locale';

interface WorkAreaOption {
  workAreaId: string;
  workAreaName: string;
  siteId: string;
  siteName: string;
  active: boolean;
  label: string;
}
interface WorkerRow {
  employee: { id: string; employeeNumber: string; firstName: string; lastName: string };
  workedMinutes: number;
  workDates: string[];
  timesheetStatus: string;
  assignedNow: boolean;
  workedInPeriod: boolean;
}
interface Section {
  workAreaId: string | null;
  workAreaName: string | null;
  siteId: string;
  siteName: string;
  customerActive: boolean;
  assignedNowCount: number;
  workedInPeriodCount: number;
  totalMinutes: number;
  workers: WorkerRow[];
}
interface Report {
  dateFrom: string;
  dateTo: string;
  includesNoCustomer: boolean;
  sections: Section[];
  grandTotalMinutes: number;
  grandWorkerCount: number;
}
interface Blocker {
  employeeName: string;
  employeeNumber: string;
  periodLabel: string;
  timesheetId: string;
  status: string;
  link: string;
}
interface Readiness {
  level: 'CUSTOMER_FINAL' | 'INTERNAL_PREVIEW_ONLY';
  blockers: Blocker[];
  noData: { employeeName: string; employeeNumber: string; periodLabel: string }[];
}

const PAGE_SIZE = 20;
const NO_CUSTOMER = 'none';

function hoursLabel(minutes: number, locale: AppLocale): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return locale === 'RU' ? `${h} ч ${m} мин` : `${h} h ${m} min`;
}

export function CustomerHoursForm({ locale }: { locale: AppLocale }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const ru = locale === 'RU';
  const t = (en: string, r: string) => localeText(locale, en, r);

  // ── URL-backed selection ────────────────────────────────────────────────────────────────────
  const urlDateFrom = searchParams.get('dateFrom') ?? '';
  const urlDateTo = searchParams.get('dateTo') ?? '';
  const urlWaIds = useMemo(
    () => (searchParams.get('waIds') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    [searchParams]
  );
  const urlNoCustomer = searchParams.get('noCustomer') === '1';
  const urlWorkersAll = searchParams.get('workers') === 'all';
  const urlWorkerIds = useMemo(
    () => new Set((searchParams.get('workerIds') ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    [searchParams]
  );

  const pushSelection = useCallback(
    (next: { dateFrom?: string; dateTo?: string; waIds?: string[]; noCustomer?: boolean; workersAll?: boolean; workerIds?: Set<string> }) => {
      const p = new URLSearchParams(searchParams.toString());
      const set = (k: string, v: string | null) => (v ? p.set(k, v) : p.delete(k));
      if (next.dateFrom !== undefined) set('dateFrom', next.dateFrom || null);
      if (next.dateTo !== undefined) set('dateTo', next.dateTo || null);
      if (next.waIds !== undefined) set('waIds', next.waIds.length ? next.waIds.join(',') : null);
      if (next.noCustomer !== undefined) set('noCustomer', next.noCustomer ? '1' : null);
      if (next.workersAll !== undefined || next.workerIds !== undefined) {
        const all = next.workersAll ?? urlWorkersAll;
        const ids = next.workerIds ?? urlWorkerIds;
        if (all || ids.size === 0) {
          p.set('workers', 'all');
          p.delete('workerIds');
        } else {
          p.delete('workers');
          p.set('workerIds', [...ids].join(','));
        }
      }
      router.replace(`${pathname}?${p.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams, urlWorkersAll, urlWorkerIds]
  );

  // ── customer search ─────────────────────────────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WorkAreaOption[]>([]);
  const [selectedLabels, setSelectedLabels] = useState<Map<string, WorkAreaOption>>(new Map());

  useEffect(() => {
    const ctrl = new AbortController();
    const id = setTimeout(() => {
      fetch(`/api/admin/reports/customer/scope?action=search&q=${encodeURIComponent(query)}`, { credentials: 'same-origin', signal: ctrl.signal })
        .then((r) => r.json())
        .then((b: { workAreas?: WorkAreaOption[] }) => setResults(b.workAreas ?? []))
        .catch(() => {});
    }, 220);
    return () => {
      clearTimeout(id);
      ctrl.abort();
    };
  }, [query]);

  // resolve the labels for waIds already in the URL (so a reloaded page shows the chips)
  useEffect(() => {
    const missing = urlWaIds.filter((id) => !selectedLabels.has(id));
    if (missing.length === 0) return;
    fetch(`/api/admin/reports/customer/scope?action=search&q=`, { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((b: { workAreas?: WorkAreaOption[] }) => {
        const byId = new Map((b.workAreas ?? []).map((w) => [w.workAreaId, w]));
        setSelectedLabels((prev) => {
          const nextMap = new Map(prev);
          for (const id of urlWaIds) {
            const w = byId.get(id);
            if (w) nextMap.set(id, w);
          }
          return nextMap;
        });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlWaIds.join(',')]);

  function toggleCustomer(w: WorkAreaOption): void {
    const has = urlWaIds.includes(w.workAreaId);
    const nextIds = has ? urlWaIds.filter((id) => id !== w.workAreaId) : [...urlWaIds, w.workAreaId];
    setSelectedLabels((prev) => {
      const m = new Map(prev);
      if (has) m.delete(w.workAreaId);
      else m.set(w.workAreaId, w);
      return m;
    });
    pushSelection({ waIds: nextIds });
  }
  function selectAllVisible(): void {
    const ids = Array.from(new Set([...urlWaIds, ...results.map((r) => r.workAreaId)]));
    setSelectedLabels((prev) => {
      const m = new Map(prev);
      for (const r of results) m.set(r.workAreaId, r);
      return m;
    });
    pushSelection({ waIds: ids });
  }
  function clearCustomers(): void {
    setSelectedLabels(new Map());
    pushSelection({ waIds: [], noCustomer: false });
  }

  // ── preview ─────────────────────────────────────────────────────────────────────────────────
  const [report, setReport] = useState<Report | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewSeq = useRef(0);

  const canQuery = !!urlDateFrom && !!urlDateTo && (urlWaIds.length > 0 || urlNoCustomer);

  useEffect(() => {
    if (!canQuery) {
      setReport(null);
      setReadiness(null);
      return;
    }
    const seq = ++previewSeq.current;
    setLoading(true);
    setError(null);
    const p = new URLSearchParams({ action: 'preview', dateFrom: urlDateFrom, dateTo: urlDateTo });
    if (urlWaIds.length) p.set('waIds', urlWaIds.join(','));
    if (urlNoCustomer) p.set('noCustomer', '1');
    fetch(`/api/admin/reports/customer/scope?${p.toString()}`, { credentials: 'same-origin' })
      .then(async (r) => {
        const b = await r.json();
        if (seq !== previewSeq.current) return;
        if (!r.ok) {
          setError(b?.error?.message ?? t('Could not load the preview.', 'Не удалось загрузить предпросмотр.'));
          setReport(null);
          return;
        }
        setReport(b.report);
        setReadiness(b.readiness);
      })
      .catch(() => seq === previewSeq.current && setError(t('Network error.', 'Ошибка сети.')))
      .finally(() => seq === previewSeq.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canQuery, urlDateFrom, urlDateTo, urlWaIds.join(','), urlNoCustomer]);

  // ── flattened worker rows (one per worker × customer) ────────────────────────────────────────
  const allRows = useMemo(() => {
    if (!report) return [] as { section: Section; w: WorkerRow }[];
    return report.sections.flatMap((section) => section.workers.map((w) => ({ section, w })));
  }, [report]);

  const [workerSearch, setWorkerSearch] = useState('');
  const [page, setPage] = useState(0);
  const filteredRows = useMemo(() => {
    const q = workerSearch.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter(({ section, w }) => {
      const hay = `${w.employee.lastName} ${w.employee.firstName} ${w.employee.employeeNumber} ${section.siteName} ${section.workAreaName ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [allRows, workerSearch]);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const pageRows = filteredRows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  useEffect(() => {
    if (page >= pageCount) setPage(0);
  }, [page, pageCount]);

  const workerSelected = (id: string) => urlWorkersAll || (!urlWorkersAll && (urlWorkerIds.has(id) || urlWorkerIds.size === 0));
  function toggleWorker(id: string): void {
    const currentAll = urlWorkersAll || urlWorkerIds.size === 0;
    if (currentAll) {
      // switch to explicit "all except this one"
      const ids = new Set(allRows.map((r) => r.w.employee.id));
      ids.delete(id);
      pushSelection({ workersAll: false, workerIds: ids });
    } else {
      const ids = new Set(urlWorkerIds);
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      pushSelection({ workersAll: ids.size === 0, workerIds: ids });
    }
  }
  function selectAllWorkers(): void {
    pushSelection({ workersAll: true, workerIds: new Set() });
  }
  function clearWorkers(): void {
    pushSelection({ workersAll: false, workerIds: new Set(['__none__']) });
  }

  // ── export links ────────────────────────────────────────────────────────────────────────────
  const exportBlockedReason = useMemo(() => {
    if (urlWaIds.length === 0) return t('Select at least one real customer.', 'Выберите хотя бы одного настоящего заказчика.');
    if (urlNoCustomer) return t('Remove "no customer" — it cannot be in a client export.', 'Уберите «Без заказчика» — он не может быть в клиентском экспорте.');
    if (readiness && readiness.level !== 'CUSTOMER_FINAL')
      return t('Some timesheets for this customer are not final-approved.', 'Некоторые табели этого заказчика не утверждены окончательно.');
    return null;
  }, [urlWaIds.length, urlNoCustomer, readiness, locale]);

  function exportHref(format: 'PDF' | 'CSV', mode: 'FINAL' | 'PREVIEW'): string {
    const p = new URLSearchParams({ dateFrom: urlDateFrom, dateTo: urlDateTo, format, mode });
    if (urlWaIds.length) p.set('waIds', urlWaIds.join(','));
    if (urlNoCustomer && mode === 'PREVIEW') p.set('noCustomer', '1');
    if (!urlWorkersAll && urlWorkerIds.size > 0) p.set('workerIds', [...urlWorkerIds].join(','));
    return `/api/admin/reports/customer/export?${p.toString()}`;
  }

  // ── render ──────────────────────────────────────────────────────────────────────────────────
  return (
    <div className="worker-work-setup">
      <fieldset>
        <legend>{t('Period', 'Период')}</legend>
        <label>
          {t('From', 'С')}: <input type="date" value={urlDateFrom} onChange={(e) => pushSelection({ dateFrom: e.target.value })} />
        </label>{' '}
        <label>
          {t('To', 'По')}: <input type="date" value={urlDateTo} onChange={(e) => pushSelection({ dateTo: e.target.value })} />
        </label>
      </fieldset>

      <fieldset>
        <legend>{t('Customers', 'Заказчики')}</legend>
        <input
          type="search"
          value={query}
          placeholder={t('Search by customer or site…', 'Поиск по заказчику или объекту…')}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: '100%', maxWidth: 420 }}
        />
        <div className="activation-actions">
          <button type="button" className="login-submit" onClick={selectAllVisible} disabled={results.length === 0}>
            {t('Select all shown', 'Выбрать всех показанных')}
          </button>
          <button type="button" className="login-submit" onClick={clearCustomers} disabled={urlWaIds.length === 0 && !urlNoCustomer}>
            {t('Clear selection', 'Снять выбор')}
          </button>
        </div>

        {selectedLabels.size > 0 || urlNoCustomer ? (
          <p>
            <strong>{t('Selected', 'Выбрано')}:</strong>{' '}
            {[...selectedLabels.values()].map((w) => (
              <button
                key={w.workAreaId}
                type="button"
                className="setup-action"
                style={{ margin: '2px', background: '#1f7a3d', color: '#fff' }}
                onClick={() => toggleCustomer(w)}
                title={t('Click to remove', 'Нажмите, чтобы убрать')}
              >
                {w.label}
                {w.active ? '' : ` (${t('disabled', 'отключён')})`} ✕
              </button>
            ))}
            {urlNoCustomer ? (
              <button type="button" className="setup-action" style={{ margin: '2px' }} onClick={() => pushSelection({ noCustomer: false })}>
                {t('No customer (internal)', 'Без заказчика (внутр.)')} ✕
              </button>
            ) : null}
          </p>
        ) : null}

        <ul className="setup-list">
          {results.map((w) => {
            const sel = urlWaIds.includes(w.workAreaId);
            return (
              <li key={w.workAreaId} className="setup-item">
                <label style={{ fontWeight: sel ? 700 : 400 }}>
                  <input type="checkbox" checked={sel} onChange={() => toggleCustomer(w)} /> {w.label}
                  {w.active ? '' : ` · ${t('disabled', 'отключён')}`}
                </label>
              </li>
            );
          })}
        </ul>
        <label className="setup-subtitle">
          <input type="checkbox" checked={urlNoCustomer} onChange={(e) => pushSelection({ noCustomer: e.target.checked })} />{' '}
          {t('Also show "no customer" hours (internal preview only — no client PDF)', 'Также показать часы «без заказчика» (только внутренний предпросмотр — без клиентского PDF)')}
        </label>
      </fieldset>

      {error ? <p className="login-error" role="alert">{error}</p> : null}
      {loading ? <p className="setup-subtitle">{t('Loading…', 'Загрузка…')}</p> : null}

      {report ? (
        <>
          {report.sections.map((s) => (
            <div key={`${s.workAreaId ?? 'none'}:${s.siteId}`} className="activation-print-card">
              <p>
                <strong>{t('Customer', 'Заказчик')}:</strong> {s.workAreaName ?? t('(no customer)', '(без заказчика)')}
                {s.customerActive ? '' : ` · ${t('disabled', 'отключён')}`}
                <br />
                <strong>{t('Site', 'Объект')}:</strong> {s.siteName}
                <br />
                <strong>{t('Assigned now', 'Сейчас назначено')}:</strong> {s.assignedNowCount}{' '}
                {t('workers', 'работников')}
                <br />
                <strong>{t('Worked in period', 'Работали за период')}:</strong> {s.workedInPeriodCount} {t('workers', 'работников')}
                <br />
                <strong>{t('Total hours', 'Всего часов')}:</strong> {hoursLabel(s.totalMinutes, locale)}
              </p>
            </div>
          ))}
          {report.sections.length > 1 ? (
            <p>
              <strong>{t('Grand total', 'Общий итог')}:</strong> {hoursLabel(report.grandTotalMinutes, locale)} ·{' '}
              {report.grandWorkerCount} {t('workers', 'работников')}
            </p>
          ) : null}

          {/* worker list */}
          <fieldset>
            <legend>{t('Workers', 'Работники')}</legend>
            <input
              type="search"
              value={workerSearch}
              placeholder={t('Search name, number, site, customer…', 'Поиск по имени, номеру, объекту, заказчику…')}
              onChange={(e) => {
                setWorkerSearch(e.target.value);
                setPage(0);
              }}
              style={{ width: '100%', maxWidth: 420 }}
            />
            <div className="activation-actions">
              <button type="button" className="login-submit" onClick={selectAllWorkers}>
                {t('Select all', 'Выбрать всех')}
              </button>
              <button type="button" className="login-submit" onClick={clearWorkers}>
                {t('Clear', 'Снять выбор')}
              </button>
              <span className="setup-subtitle">
                {urlWorkersAll || urlWorkerIds.size === 0
                  ? t('all workers in scope', 'все работники в выборке')
                  : `${urlWorkerIds.size} ${t('selected', 'выбрано')}`}
              </span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="setup-list" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th></th>
                    <th>{t('Name', 'ФИО')}</th>
                    <th>{t('No.', 'Таб.№')}</th>
                    <th>{t('Site', 'Объект')}</th>
                    <th>{t('Customer', 'Заказчик')}</th>
                    <th>{t('Work dates', 'Даты работы')}</th>
                    <th>{t('Hours', 'Часы')}</th>
                    <th>{t('Timesheet', 'Табель')}</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map(({ section, w }) => (
                    <tr key={`${w.employee.id}:${section.workAreaId ?? section.siteId}`}>
                      <td>
                        <input type="checkbox" checked={workerSelected(w.employee.id)} onChange={() => toggleWorker(w.employee.id)} />
                      </td>
                      <td>
                        {w.employee.lastName} {w.employee.firstName}
                      </td>
                      <td>{w.employee.employeeNumber}</td>
                      <td>{section.siteName}</td>
                      <td>{section.workAreaName ?? t('(no customer)', '(без заказчика)')}</td>
                      <td>{w.workDates.join(', ') || '—'}</td>
                      <td>{hoursLabel(w.workedMinutes, locale)}</td>
                      <td>{w.timesheetStatus || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pageCount > 1 ? (
              <p>
                <button type="button" className="login-submit" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  ‹
                </button>{' '}
                {t('Page', 'Стр.')} {page + 1} / {pageCount}{' '}
                <button type="button" className="login-submit" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>
                  ›
                </button>
              </p>
            ) : null}
          </fieldset>

          {/* readiness */}
          {readiness && readiness.blockers.length > 0 ? (
            <div className="worker-setup-callout">
              <p>
                <strong>{t('Timesheets not final-approved:', 'Табели не утверждены окончательно:')}</strong>
              </p>
              <ul className="setup-list">
                {readiness.blockers.map((b) => (
                  <li key={b.timesheetId}>
                    <a href={b.link}>
                      {b.employeeName} #{b.employeeNumber} — {b.periodLabel} ({b.status})
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* downloads */}
          <fieldset>
            <legend>{t('Download', 'Скачать')}</legend>
            {exportBlockedReason ? <p className="login-error">{exportBlockedReason}</p> : null}
            <div className="activation-actions">
              <a
                className="setup-action"
                aria-disabled={!!exportBlockedReason}
                href={exportBlockedReason ? undefined : exportHref('PDF', 'FINAL')}
                style={exportBlockedReason ? { pointerEvents: 'none', opacity: 0.5 } : undefined}
              >
                {t('Download PDF', 'Скачать PDF')}
              </a>
              <a
                className="setup-action"
                aria-disabled={!!exportBlockedReason}
                href={exportBlockedReason ? undefined : exportHref('CSV', 'FINAL')}
                style={exportBlockedReason ? { pointerEvents: 'none', opacity: 0.5 } : undefined}
              >
                {t('Download CSV', 'Скачать CSV')}
              </a>
              <a className="login-submit" href={exportHref('PDF', 'PREVIEW')}>
                {t('Internal preview PDF', 'Внутренний предпросмотр PDF')}
              </a>
            </div>
          </fieldset>
        </>
      ) : canQuery && !loading && !error ? (
        <p className="setup-subtitle">{t('No hours for this selection.', 'Часов по этой выборке нет.')}</p>
      ) : !canQuery ? (
        <p className="setup-subtitle">{t('Pick a period and at least one customer.', 'Выберите период и хотя бы одного заказчика.')}</p>
      ) : null}
    </div>
  );
}
