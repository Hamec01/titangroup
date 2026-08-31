'use client';

// docs/titanor-time/CUSTOMER_REPORT_SCOPE_PICKER_RU.md — the scope picker for the customer hours
// report. Flow: dates -> choose by Sites or Workers -> selection panel(s) -> selection summary ->
// "Show & check" -> result. URL is the source of truth (reload / Back-Forward / shared link
// reproduce the selection). Explicit ALL / PICK modes — an empty list never silently means "the
// whole company". Serializes back onto the EXISTING export API params (absent list = "all"), so the
// report itself, PDF and CSV are byte-identical for the same effective scope.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { localeText } from '@/lib/i18n/locale';
import { ScopePickerPanel, type ScopeItem } from '@/components/reports/ScopePickerPanel';
import { serializeScopeToExportParams, type CustomerReportScope, type ScopeBasis } from '@/lib/reporting/customer-report-scope';

interface SiteOption {
  id: string;
  name: string;
}
interface ScopeWorker {
  employeeId: string;
  firstName: string;
  lastName: string;
  employeeNumber: string;
  siteIds: string[];
  assigned: boolean;
  hasHours: boolean;
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

export function CustomerHoursForm({ allSites, initial, locale }: { allSites: SiteOption[]; initial: CustomerReportScope; locale: 'EN' | 'RU' }) {
  const ru = locale === 'RU';
  const t = (en: string, r: string) => localeText(locale, en, r);
  const router = useRouter();
  const pathname = usePathname();
  const today = new Date().toISOString().slice(0, 10);
  const siteName = useMemo(() => new Map(allSites.map((s) => [s.id, s.name])), [allSites]);

  const [dateFrom, setDateFrom] = useState(initial.dateFrom ?? '');
  const [dateTo, setDateTo] = useState(initial.dateTo ?? '');
  const [customer, setCustomer] = useState(initial.customer);
  const [projectReference, setProjectReference] = useState(initial.projectReference);
  const [scopeBasis, setScopeBasis] = useState<ScopeBasis>(initial.scopeBasis);

  // The picker only offers two visible modes: "Choose sites" (PICK) and "All sites" (ALL). A URL
  // that carried neither (siteMode NONE) opens in PICK with nothing selected — the report button
  // then stays disabled with a hint, so an empty list still never means "the whole company".
  const [siteMode, setSiteMode] = useState<'ALL' | 'PICK'>(initial.siteMode === 'ALL' ? 'ALL' : 'PICK');
  const [siteIds, setSiteIds] = useState<Set<string>>(() => new Set(initial.siteIds));

  // Worker selection: `workersAllMode` is flipped by the "select all / clear" buttons only; single
  // toggles don't change it. ALL -> serialize as workers=all (+ wx for manual removals); PICK ->
  // workerIds. `pendingWorkerSel` seeds the selection once the scope list arrives.
  const [workersAllMode, setWorkersAllMode] = useState(initial.workerMode === 'ALL');
  const [workerIds, setWorkerIds] = useState<Set<string>>(() => new Set(initial.workerIds));
  const workerIdsRef = useRef(workerIds);
  workerIdsRef.current = workerIds;
  const workersAllModeRef = useRef(workersAllMode);
  workersAllModeRef.current = workersAllMode;
  const workerExcludeRef = useRef<Set<string>>(new Set(initial.workerExcludeIds));

  const [scopeWorkers, setScopeWorkers] = useState<ScopeWorker[] | null>(null);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [prunedCount, setPrunedCount] = useState(0);

  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  const datesValid = !!dateFrom && !!dateTo && dateFrom <= dateTo;
  const siteScopeReady = datesValid && (scopeBasis === 'WORKERS' || siteMode === 'ALL' || (siteMode === 'PICK' && siteIds.size > 0));
  const sortedSiteIds = useMemo(() => [...siteIds].sort(), [siteIds]);
  const scopeKey = `${scopeBasis}|${siteMode}|${sortedSiteIds.join(',')}|${dateFrom}|${dateTo}`;

  // ---- fetch the in-scope worker list whenever sites / dates change --------------------------
  useEffect(() => {
    if (!siteScopeReady) {
      setScopeWorkers(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setScopeLoading(true);
      setScopeError(null);
      try {
        const q = new URLSearchParams({ dateFrom, dateTo, siteMode: scopeBasis === 'WORKERS' ? 'ALL' : siteMode, scopeBasis });
        if (scopeBasis === 'SITES') for (const id of sortedSiteIds) q.append('siteIds', id);
        const r = await fetch(`/api/admin/reports/customer/scope?${q.toString()}`, { credentials: 'same-origin' });
        if (cancelled) return;
        if (!r.ok) {
          setScopeError(t('Could not load the worker list.', 'Не удалось загрузить список работников.'));
          setScopeWorkers([]);
          return;
        }
        const body = (await r.json()) as { workers: ScopeWorker[] };
        if (cancelled) return;
        setScopeWorkers(body.workers);
      } catch {
        if (!cancelled) {
          setScopeError(t('Network error.', 'Ошибка сети.'));
          setScopeWorkers([]);
        }
      } finally {
        if (!cancelled) setScopeLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, siteScopeReady]);

  // ---- reconcile the worker selection against a freshly-arrived scope list ------------------
  useEffect(() => {
    if (!scopeWorkers) return;
    const inScope = new Set(scopeWorkers.map((w) => w.employeeId));
    // Keep the exclude set trimmed to what is actually in scope so it can never hide a selected
    // worker outside the visible list (ТЗ §5).
    const trimmedExcludes = new Set<string>();
    for (const id of workerExcludeRef.current) if (inScope.has(id)) trimmedExcludes.add(id);
    workerExcludeRef.current = trimmedExcludes;

    const prev = workerIdsRef.current;
    const next = workersAllModeRef.current
      ? new Set(scopeWorkers.filter((w) => !trimmedExcludes.has(w.employeeId)).map((w) => w.employeeId))
      : new Set([...prev].filter((id) => inScope.has(id)));
    setPrunedCount([...prev].filter((id) => !inScope.has(id)).length);
    if (next.size !== prev.size || [...next].some((id) => !prev.has(id))) setWorkerIds(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeWorkers]);

  // ---- keep the URL in sync (source of truth) ----------------------------------------------
  const buildUrl = useCallback(() => {
    const p = new URLSearchParams();
    if (dateFrom) p.set('dateFrom', dateFrom);
    if (dateTo) p.set('dateTo', dateTo);
    if (customer.trim()) p.set('customer', customer.trim());
    if (projectReference.trim()) p.set('projectReference', projectReference.trim());
    if (scopeBasis === 'WORKERS') {
      p.set('scopeBy', 'workers');
    } else if (siteMode === 'ALL') p.set('sites', 'all');
    else for (const id of sortedSiteIds) p.append('siteIds', id);
    if (workersAllMode) {
      p.set('workers', 'all');
      for (const id of [...workerExcludeRef.current].sort()) p.append('wx', id);
    } else {
      for (const id of [...workerIds].sort()) p.append('workerIds', id);
    }
    return `${pathname}?${p.toString()}`;
  }, [dateFrom, dateTo, customer, projectReference, scopeBasis, siteMode, sortedSiteIds, workersAllMode, workerIds, pathname]);

  useEffect(() => {
    const handle = setTimeout(() => {
      router.replace(buildUrl(), { scroll: false });
    }, 400);
    return () => clearTimeout(handle);
  }, [buildUrl, router]);

  // ---- site panel ------------------------------------------------------------------------
  const siteItems: ScopeItem[] = useMemo(
    () => allSites.map((s) => ({ id: s.id, primary: s.name, searchText: s.name.toLowerCase() })),
    [allSites]
  );
  const toggleSite = (id: string) =>
    setSiteIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // ---- worker panel --------------------------------------------------------------------
  const workerItems: ScopeItem[] = useMemo(() => {
    if (!scopeWorkers) return [];
    return scopeWorkers.map((w) => {
      const sites = w.siteIds.map((id) => siteName.get(id) ?? '—');
      const chips: string[] = [];
      if (w.hasHours) chips.push(t('has hours in period', 'есть часы за период'));
      else if (w.assigned) chips.push(t('assigned to site', 'назначен на объект'));
      const secondaryParts = [`#${w.employeeNumber}`];
      if (sites.length) secondaryParts.push(sites.join(', '));
      else if (scopeBasis === 'WORKERS') secondaryParts.push(t('No site assigned in this period', 'Объект за этот период не назначен'));
      if (chips.length) secondaryParts.push(chips.join(', '));
      return {
        id: w.employeeId,
        primary: `${w.lastName} ${w.firstName}`,
        secondary: secondaryParts.join(' · '),
        searchText: `${w.lastName} ${w.firstName} ${w.employeeNumber} ${sites.join(' ')}`.toLowerCase()
      };
    });
  }, [scopeWorkers, siteName, locale, scopeBasis]);

  const changeScopeBasis = (next: ScopeBasis) => {
    if (next === scopeBasis) return;
    setScopeBasis(next);
    setScopeWorkers(null);
    setWorkersAllMode(false);
    workersAllModeRef.current = false;
    workerExcludeRef.current = new Set();
    setWorkerIds(new Set());
    setPrunedCount(0);
    setPreview(null);
  };

  const toggleWorker = (id: string) => {
    setPrunedCount(0);
    setWorkerIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        workerExcludeRef.current.add(id);
      } else {
        next.add(id);
        workerExcludeRef.current.delete(id);
      }
      return next;
    });
  };
  const selectAllWorkers = () => {
    setPrunedCount(0);
    setWorkersAllMode(true);
    workerExcludeRef.current = new Set();
    setWorkerIds(new Set((scopeWorkers ?? []).map((w) => w.employeeId)));
  };
  const clearAllWorkers = () => {
    setPrunedCount(0);
    setWorkersAllMode(false);
    workerExcludeRef.current = new Set((scopeWorkers ?? []).map((w) => w.employeeId));
    setWorkerIds(new Set());
  };

  // ---- current explicit scope (for serialization + summary) ---------------------------------
  const currentScope: CustomerReportScope = {
    scopeBasis,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    customer,
    projectReference,
    siteMode: scopeBasis === 'WORKERS' ? 'ALL' : siteMode,
    siteIds: scopeBasis === 'SITES' && siteMode === 'PICK' ? sortedSiteIds : [],
    workerMode: workersAllMode ? 'ALL' : workerIds.size > 0 ? 'PICK' : 'NONE',
    workerIds: workersAllMode ? [] : [...workerIds],
    workerExcludeIds: workersAllMode ? [...workerExcludeRef.current] : []
  };
  const scopeWorkerIds = (scopeWorkers ?? []).map((w) => w.employeeId);
  const exportParams = (extra: Record<string, string>) => serializeScopeToExportParams(currentScope, scopeWorkerIds, extra);
  const canRun = siteScopeReady && !!scopeWorkers && !scopeLoading && exportParams({}) !== null;

  async function handlePreview() {
    setFormError(null);
    if (!datesValid) {
      setFormError(t('Both dates are required and "from" must be on or before "to".', 'Укажите обе даты; «с» — не позже «по».'));
      return;
    }
    const p = exportParams({ preview: '1', mode: 'PREVIEW' });
    if (!p) {
      setFormError(t('Choose sites and workers first.', 'Сначала выберите объекты и работников.'));
      return;
    }
    setBusy(true);
    setPreview(null);
    try {
      const r = await fetch(`/api/admin/reports/customer/export?${p.toString()}`, { credentials: 'same-origin' });
      if (!r.ok) {
        setFormError(t('Could not load the preview.', 'Не удалось получить предпросмотр.'));
        return;
      }
      setPreview(await r.json());
    } catch {
      setFormError(t('Network error.', 'Ошибка сети.'));
    } finally {
      setBusy(false);
    }
  }

  const ready = preview?.readiness.level === 'CUSTOMER_FINAL';

  // ---- selection summary (ТЗ §7) --------------------------------------------------------
  const sitesSummary =
    scopeBasis === 'WORKERS'
      ? t('all sites where the selected workers recorded hours', 'все объекты, где выбранные работники записали часы')
      : siteMode === 'ALL'
      ? t('all', 'все')
      : siteIds.size === 1
        ? siteName.get([...siteIds][0]) ?? t('1 selected', 'выбран 1')
        : t(`${siteIds.size} selected`, `выбрано ${siteIds.size}`);
  const workersSummary = !scopeWorkers
    ? '—'
    : workersAllMode && workerExcludeRef.current.size === 0
      ? scopeBasis === 'WORKERS'
        ? t('all workers', 'все работники')
        : t('all workers of the selected sites', 'все работники выбранных объектов')
      : t(`${workerIds.size} of ${scopeWorkers.length} selected`, `выбрано ${workerIds.size} из ${scopeWorkers.length}`);

  return (
    <div className="ch-form" style={{ display: 'grid', gap: 16 }}>
      <div className="ov-filters" style={{ display: 'grid', gap: 12 }}>
        <div className="ov-filter-field">
          <label htmlFor="ch-from">{t('Date from', 'Дата с')} *</label>
          <input id="ch-from" type="date" max={today} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </div>
        <div className="ov-filter-field">
          <label htmlFor="ch-to">{t('Date to', 'Дата по')} *</label>
          <input id="ch-to" type="date" max={today} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </div>
        <div className="ov-filter-field">
          <label htmlFor="ch-customer">{t('Customer / recipient', 'Заказчик / получатель')}</label>
          <input id="ch-customer" type="text" maxLength={200} value={customer} onChange={(e) => setCustomer(e.target.value)} />
        </div>
        <div className="ov-filter-field">
          <label htmlFor="ch-project">{t('Project / reference', 'Проект / ссылка')}</label>
          <input id="ch-project" type="text" maxLength={200} value={projectReference} onChange={(e) => setProjectReference(e.target.value)} />
        </div>
      </div>

      <fieldset className="scope-mode">
        <legend>{t('How to choose', 'Как выбрать')}</legend>
        <label>
          <input type="radio" name="ch-scope-basis" checked={scopeBasis === 'SITES'} onChange={() => changeScopeBasis('SITES')} /> {t('By sites', 'По объектам')}
        </label>
        <label>
          <input type="radio" name="ch-scope-basis" checked={scopeBasis === 'WORKERS'} onChange={() => changeScopeBasis('WORKERS')} /> {t('By workers', 'По работникам')}
        </label>
        <p className="setup-subtitle">
          {scopeBasis === 'WORKERS'
            ? t('Choose workers directly, even if they have no current site or changed sites.', 'Выберите работников напрямую — даже если объект не назначен или работник сменил объект.')
            : t('Choose sites first, then their workers.', 'Сначала выберите объекты, затем их работников.')}
        </p>
      </fieldset>

      {/* ---- 1. Sites ---- */}
      {scopeBasis === 'SITES' && <fieldset className="scope-mode">
        <legend>{t('Sites', 'Объекты')}</legend>
        <label>
          <input type="radio" name="ch-site-mode" checked={siteMode === 'PICK'} onChange={() => setSiteMode('PICK')} /> {t('Choose sites', 'Выбрать объекты')}
        </label>
        <label>
          <input type="radio" name="ch-site-mode" checked={siteMode === 'ALL'} onChange={() => setSiteMode('ALL')} /> {t('All sites', 'Все объекты')}
        </label>
      </fieldset>}

      {scopeBasis === 'SITES' && siteMode === 'PICK' && (
        <ScopePickerPanel
          title={t('Sites', 'Объекты')}
          items={siteItems}
          selectedIds={siteIds}
          onToggle={toggleSite}
          onSelectAll={() => setSiteIds(new Set(allSites.map((s) => s.id)))}
          onClearAll={() => setSiteIds(new Set())}
          idPrefix="ch-site"
          labels={{
            count: (n) => t(`Sites selected: ${n}`, `Выбрано объектов: ${n}`),
            searchPlaceholder: t('Search by site name', 'Поиск по названию объекта'),
            selectAll: t('Select all', 'Выбрать все'),
            clearAll: t('Clear selection', 'Снять выбор'),
            empty: t('No sites.', 'Объектов нет.'),
            noMatch: t('No sites match the search.', 'Нет объектов по запросу.'),
            page: (c, tot) => t(`Page ${c} of ${tot}`, `Страница ${c} из ${tot}`),
            prev: t('Previous', 'Назад'),
            next: t('Next', 'Далее')
          }}
        />
      )}

      {/* ---- 2. Workers of the selected sites ---- */}
      {siteScopeReady && (
        <div className="scope-workers-wrap">
          {scopeLoading && !scopeWorkers ? (
            <p className="setup-subtitle">{t('Loading workers…', 'Загрузка работников…')}</p>
          ) : scopeError ? (
            <p className="login-error" role="alert">
              {scopeError}
            </p>
          ) : (
            <>
              {prunedCount > 0 && (
                <p className="scope-notice" role="status">
                  {t(
                    `${prunedCount} worker(s) removed — they are not on the selected sites.`,
                    `Снято ${prunedCount} работник(а/ов), которые не относятся к выбранным объектам.`
                  )}
                </p>
              )}
              <ScopePickerPanel
                title={scopeBasis === 'WORKERS' ? t('Workers', 'Работники') : t('Workers of the selected sites', 'Работники выбранных объектов')}
                items={workerItems}
                selectedIds={workerIds}
                onToggle={toggleWorker}
                onSelectAll={selectAllWorkers}
                onClearAll={clearAllWorkers}
                idPrefix="ch-worker"
                labels={{
                  count: (n, tot) => t(`Workers selected: ${n} of ${tot}`, `Выбрано работников: ${n} из ${tot}`),
                  searchPlaceholder: t('Search by name or employee number', 'Поиск по имени, фамилии, табельному номеру'),
                  selectAll:
                    scopeBasis === 'WORKERS'
                      ? t('Select all workers', 'Выбрать всех работников')
                      : siteMode === 'PICK' && siteIds.size === 1
                      ? t(`Select all workers of "${siteName.get([...siteIds][0]) ?? ''}"`, `Выбрать всех работников объекта «${siteName.get([...siteIds][0]) ?? ''}»`)
                      : t('Select all workers of the selected sites', 'Выбрать всех работников выбранных объектов'),
                  clearAll: t('Clear all', 'Снять выбор со всех'),
                  empty: scopeBasis === 'WORKERS'
                    ? t('No workers in this period.', 'За этот период работников нет.')
                    : t('No workers on the selected sites in this period.', 'На выбранных объектах за период работников нет.'),
                  noMatch: t('No workers match the search.', 'Нет работников по запросу.'),
                  page: (c, tot) => t(`Page ${c} of ${tot}`, `Страница ${c} из ${tot}`),
                  prev: t('Previous', 'Назад'),
                  next: t('Next', 'Далее')
                }}
              />
            </>
          )}
        </div>
      )}

      {/* ---- 3. Selection summary ---- */}
      <div className="scope-summary">
        <p>
          <strong>{t('Sites: ', 'Объекты: ')}</strong>
          {sitesSummary}
        </p>
        <p>
          <strong>{t('Workers: ', 'Работники: ')}</strong>
          {workersSummary}
        </p>
      </div>

      {formError ? (
        <p className="login-error" role="alert">
          {formError}
        </p>
      ) : null}

      {/* ---- 4. Show & check ---- */}
      <div className="ov-filter-actions">
        <button type="button" className="exc-apply-button" onClick={handlePreview} disabled={busy || !canRun}>
          {busy ? t('Loading…', 'Загрузка…') : t('Show & check', 'Показать и проверить')}
        </button>
        {!canRun && !busy ? (
          <span className="setup-subtitle">
            {!datesValid
              ? t('Set both dates.', 'Укажите обе даты.')
              : scopeBasis === 'SITES' && siteMode === 'PICK' && siteIds.size === 0
                ? t('Choose sites or "All sites".', 'Выберите объекты или режим «Все объекты».')
                : !scopeWorkers
                  ? t('Loading…', 'Загрузка…')
                  : currentScope.workerMode === 'NONE'
                    ? t('Choose workers or "Select all…".', 'Выберите работников или «Выбрать всех…».')
                    : ''}
          </span>
        ) : null}
      </div>

      {/* ---- 5. Result ---- */}
      {preview ? (
        <div className="setup-item setup-item-column" style={{ display: 'grid', gap: 8 }}>
          <p>
            <strong>{t('Readiness: ', 'Готовность: ')}</strong>
            {ready ? (
              <span style={{ color: '#1f7a3d' }}>{t('all timesheets final-approved — ready for the customer', 'все табели окончательно одобрены — можно отправлять заказчику')}</span>
            ) : (
              <span style={{ color: '#a34d00' }}>{t('some timesheets are not final-approved — final export is blocked', 'есть неутверждённые табели — финальная выгрузка заблокирована')}</span>
            )}
          </p>
          <p className="setup-subtitle">
            {t('Total worked: ', 'Итого отработано: ')}
            {hoursLabel(preview.report.grandTotal.workedMinutes, ru)} · {preview.report.grandTotal.workedDays} {t('worked days', 'раб. дн.')} · {preview.report.dailyRows.length} {t('rows', 'строк')}
          </p>

          {preview.readiness.blockers.length > 0 ? (
            <div>
              <p>
                <strong>{t('Not final-approved:', 'Не окончательно одобрены:')}</strong>
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
              {t('Not submitted: ', 'Не сдали табель: ')}
              {preview.readiness.noData.map((n) => `${n.employeeName} (${n.periodLabel})`).join(', ')}
            </p>
          ) : null}

          <div className="wk-switch-actions">
            <a
              className="login-submit"
              style={{ display: 'inline-block', textAlign: 'center', textDecoration: 'none', opacity: ready ? 1 : 0.5, pointerEvents: ready ? 'auto' : 'none' }}
              href={`/api/admin/reports/customer/export?${(exportParams({ mode: 'FINAL', format: 'PDF' }) ?? new URLSearchParams()).toString()}`}
            >
              {t('Download PDF (final)', 'Скачать PDF (финал)')}
            </a>
            <a
              className="wk-inline-secondary"
              style={{ opacity: ready ? 1 : 0.5, pointerEvents: ready ? 'auto' : 'none' }}
              href={`/api/admin/reports/customer/export?${(exportParams({ mode: 'FINAL', format: 'CSV' }) ?? new URLSearchParams()).toString()}`}
            >
              {t('Download CSV (final)', 'Скачать CSV (финал)')}
            </a>
            <a className="wk-inline-secondary" href={`/api/admin/reports/customer/export?${(exportParams({ mode: 'PREVIEW', format: 'PDF' }) ?? new URLSearchParams()).toString()}`}>
              {t('Internal preview PDF (not final)', 'Внутренний предпросмотр PDF (не финал)')}
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}
