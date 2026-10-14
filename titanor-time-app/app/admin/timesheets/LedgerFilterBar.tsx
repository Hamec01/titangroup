'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import type { SiteOption } from '@/lib/attendance-overview-lookups';
import type { CustomerWorkAreaOption } from '@/lib/reporting/customer-workarea-picker';
import { activeFilterCount, type TimeLedgerUiState } from '@/lib/reporting/time-ledger-ui-query';
import type { NormalizedTimeLedgerQuery } from '@/lib/reporting/time-ledger';
import { noCustomerGroupLabel } from '@/lib/reporting/ledger-ui-text';

const STATUS_OPTIONS: NormalizedTimeLedgerQuery['status'][] = ['all', 'ready', 'needs_attention', 'approved', 'changed_after_approval', 'not_submitted', 'source_error'];

function statusOptionLabel(status: NormalizedTimeLedgerQuery['status'], locale: AppLocale): string {
  const map: Record<NormalizedTimeLedgerQuery['status'], { en: string; ru: string }> = {
    all: { en: 'All', ru: 'Все' },
    ready: { en: 'Ready', ru: 'Готовы к подтверждению' },
    needs_attention: { en: 'Needs attention', ru: 'Требуют внимания' },
    approved: { en: 'Approved', ru: 'Подтверждены' },
    changed_after_approval: { en: 'Changed after approval', ru: 'Изменены после подтверждения' },
    not_submitted: { en: 'Not submitted', ru: 'Ещё не сданы' },
    source_error: { en: 'Data errors', ru: 'Ошибки данных' }
  };
  return locale === 'RU' ? map[status].ru : map[status].en;
}

function blankFilters(): Partial<TimeLedgerUiState> {
  return { employeeSearch: null, siteId: null, workAreaId: null, status: 'all', onlyIssues: false, onlyChangedAfterApproval: false, submissionState: 'all', submissionSource: 'all' };
}

// UT4-B — always-visible filters (employee/customer/site/status) plus a "Доп. фильтры" disclosure
// (TZ §5.2). One shared field set serves both desktop (always visible, CSS row) and mobile (a
// "Filters (N)" button opens the SAME fields as an overlay — @media (max-width: 768px) in
// globals.css switches presentation, no duplicated markup). Every control applies instantly via
// onNavigate; there is no separate "Apply" step.
export function LedgerFilterBar({
  locale,
  approvalEnabled,
  state,
  onNavigate,
  siteOptions,
  initialSelectedCustomerOptions
}: {
  locale: AppLocale;
  approvalEnabled: boolean;
  state: TimeLedgerUiState;
  onNavigate: (changes: Partial<TimeLedgerUiState>) => void;
  siteOptions: SiteOption[];
  initialSelectedCustomerOptions: CustomerWorkAreaOption[];
}) {
  const panelId = useId();
  const [mobileOpen, setMobileOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const toggleButtonRef = useRef<HTMLButtonElement | null>(null);

  const [employeeSearchInput, setEmployeeSearchInput] = useState(state.employeeSearch ?? '');
  useEffect(() => {
    setEmployeeSearchInput(state.employeeSearch ?? '');
  }, [state.employeeSearch]);
  useEffect(() => {
    const id = setTimeout(() => {
      const trimmed = employeeSearchInput.trim() || null;
      if (trimmed !== state.employeeSearch) onNavigate({ employeeSearch: trimmed });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeSearchInput]);

  // Customer typeahead — mirrors app/admin/reports/customer/CustomerHoursForm.tsx's own debounced,
  // AbortController-guarded search box. `selectedOption` is independent local state: the currently
  // chosen customer stays displayed even if it drops out of a later, narrower search result.
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerResults, setCustomerResults] = useState<CustomerWorkAreaOption[]>([]);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const listboxId = `${panelId}-customer-listbox`;
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerWorkAreaOption | null>(
    state.workAreaId && state.workAreaId !== 'none' ? (initialSelectedCustomerOptions.find((o) => o.workAreaId === state.workAreaId) ?? null) : null
  );

  // UT4-B-fixup #4 — resync whenever workAreaId changes from OUTSIDE this component's own
  // pickCustomer/pickNoCustomer calls (Back/Forward, a bookmarked/typed URL, Reset elsewhere):
  // without this, selectedCustomer would keep showing a PREVIOUS selection's label even after the
  // URL's real filter moved on. Falls back to null (blank input, never a wrong stale label) when
  // the new workAreaId cannot be resolved from what this component already has in memory.
  useEffect(() => {
    setSelectedCustomer((prev) => {
      if (!state.workAreaId || state.workAreaId === 'none') return null;
      if (prev && prev.workAreaId === state.workAreaId) return prev;
      return initialSelectedCustomerOptions.find((o) => o.workAreaId === state.workAreaId) ?? customerResults.find((o) => o.workAreaId === state.workAreaId) ?? null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.workAreaId]);

  useEffect(() => {
    if (!customerOpen) return;
    const ctrl = new AbortController();
    const id = setTimeout(() => {
      fetch(`/api/admin/time-ledger/filter-options?type=customer&q=${encodeURIComponent(customerQuery)}`, { credentials: 'same-origin', signal: ctrl.signal })
        .then((r) => r.json())
        .then((b: { workAreas?: CustomerWorkAreaOption[] }) => setCustomerResults(b.workAreas ?? []))
        .catch(() => {});
    }, 220);
    return () => {
      clearTimeout(id);
      ctrl.abort();
    };
  }, [customerQuery, customerOpen]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [customerOpen, customerQuery, customerResults.length]);

  function pickCustomer(option: CustomerWorkAreaOption | null) {
    setSelectedCustomer(option);
    setCustomerOpen(false);
    setCustomerQuery('');
    onNavigate({ workAreaId: option ? option.workAreaId : null });
  }
  function pickNoCustomer() {
    setSelectedCustomer(null);
    setCustomerOpen(false);
    setCustomerQuery('');
    onNavigate({ workAreaId: 'none' });
  }

  // UT4-B-fixup #4 — real combobox semantics: one flat option list (the two fixed entries plus the
  // live search results) drives both the rendered listbox and ArrowDown/ArrowUp/Enter navigation,
  // so highlightedIndex always refers to the exact same option in both places.
  const comboOptions: { id: string; label: string; onSelect: () => void }[] = [
    { id: '__any__', label: localeText(locale, 'Any customer', 'Любой заказчик'), onSelect: () => pickCustomer(null) },
    { id: '__none__', label: noCustomerGroupLabel(locale), onSelect: pickNoCustomer },
    ...customerResults.map((o) => ({ id: o.workAreaId, label: o.label, onSelect: () => pickCustomer(o) }))
  ];

  function onCustomerKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (!customerOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCustomerOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((i) => (i + 1) % comboOptions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((i) => (i - 1 + comboOptions.length) % comboOptions.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      comboOptions[highlightedIndex]?.onSelect();
    } else if (e.key === 'Escape') {
      // Closes only the listbox, not the whole mobile drawer (the drawer's own Escape handler is a
      // separate document-level listener that a second Escape press will still reach).
      e.stopPropagation();
      setCustomerOpen(false);
    }
  }

  function openDrawer() {
    setMobileOpen(true);
  }
  function closeDrawer() {
    setMobileOpen(false);
    toggleButtonRef.current?.focus();
  }

  // UT4-B-fixup #2 — a real keyboard focus trap: aria-modal="true" on the panel promises that Tab
  // never escapes it into the page behind. getFocusableInPanel() is re-queried on every keydown
  // (never cached) since the field set itself changes as the user types/opens sub-menus.
  function getFocusableInPanel(): HTMLElement[] {
    const panel = panelRef.current;
    if (!panel) return [];
    return Array.from(panel.querySelectorAll<HTMLElement>('input, select, button, a[href], [tabindex]:not([tabindex="-1"])')).filter(
      (el) => !el.hasAttribute('disabled') && el.offsetParent !== null
    );
  }

  useEffect(() => {
    if (!mobileOpen) return;
    const first = panelRef.current?.querySelector<HTMLElement>('input, select, button');
    first?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        closeDrawer();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = getFocusableInPanel();
      if (focusable.length === 0) return;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === firstEl || !panelRef.current?.contains(active)) {
          e.preventDefault();
          lastEl.focus();
        }
      } else {
        if (active === lastEl || !panelRef.current?.contains(active)) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobileOpen]);

  const count = activeFilterCount(approvalEnabled ? state : { ...state, status: 'all', onlyChangedAfterApproval: false });

  const fields = (
    <div className="ledger-filter-fields">
      <div className="ledger-filter-field">
        <label htmlFor={`${panelId}-employee`}>{localeText(locale, 'Worker', 'Работник')}</label>
        <input id={`${panelId}-employee`} type="text" value={employeeSearchInput} onChange={(e) => setEmployeeSearchInput(e.target.value)} placeholder={localeText(locale, 'Name or number', 'Имя или номер')} />
      </div>

      <div className="ledger-filter-field ledger-combobox">
        <label htmlFor={`${panelId}-customer`}>{localeText(locale, 'Customer', 'Заказчик')}</label>
        <input
          id={`${panelId}-customer`}
          type="text"
          role="combobox"
          aria-expanded={customerOpen}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={customerOpen ? `${listboxId}-opt-${highlightedIndex}` : undefined}
          value={customerOpen ? customerQuery : (selectedCustomer ? selectedCustomer.label : state.workAreaId === 'none' ? noCustomerGroupLabel(locale) : '')}
          onFocus={() => setCustomerOpen(true)}
          onChange={(e) => {
            setCustomerQuery(e.target.value);
            setCustomerOpen(true);
          }}
          onKeyDown={onCustomerKeyDown}
          placeholder={localeText(locale, 'Search customer/site', 'Поиск заказчика/объекта')}
          autoComplete="off"
        />
        {customerOpen && (
          <ul className="ledger-combobox-list" role="listbox" id={listboxId}>
            {comboOptions.map((opt, idx) => (
              <li key={opt.id} role="presentation">
                <button
                  type="button"
                  id={`${listboxId}-opt-${idx}`}
                  role="option"
                  aria-selected={idx === highlightedIndex}
                  className={idx === highlightedIndex ? 'is-active' : undefined}
                  onMouseEnter={() => setHighlightedIndex(idx)}
                  onClick={opt.onSelect}
                >
                  {opt.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="ledger-filter-field">
        <label htmlFor={`${panelId}-site`}>{localeText(locale, 'Site', 'Объект')}</label>
        <select id={`${panelId}-site`} value={state.siteId ?? ''} onChange={(e) => onNavigate({ siteId: e.target.value || null })}>
          <option value="">{localeText(locale, 'Any site', 'Любой объект')}</option>
          {siteOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {approvalEnabled && <div className="ledger-filter-field">
        <label htmlFor={`${panelId}-status`}>{localeText(locale, 'Status', 'Статус')}</label>
        <select id={`${panelId}-status`} value={state.status} onChange={(e) => onNavigate({ status: e.target.value as NormalizedTimeLedgerQuery['status'] })}>
          {STATUS_OPTIONS.map((st) => (
            <option key={st} value={st}>
              {statusOptionLabel(st, locale)}
            </option>
          ))}
        </select>
      </div>}

      <details className="ledger-extra-filters">
        <summary>{localeText(locale, 'More filters', 'Дополнительные фильтры')}</summary>
        <label className="ledger-checkbox-field">
          <input type="checkbox" checked={state.onlyIssues} onChange={(e) => onNavigate({ onlyIssues: e.target.checked })} />
          {localeText(locale, 'Only with issues', 'Только с замечаниями')}
        </label>
        {approvalEnabled && <label className="ledger-checkbox-field">
          <input type="checkbox" checked={state.onlyChangedAfterApproval} onChange={(e) => onNavigate({ onlyChangedAfterApproval: e.target.checked })} />
          {localeText(locale, 'Only changed after approval', 'Только изменённые после подтверждения')}
        </label>}
        <div className="ledger-filter-field">
          <label htmlFor={`${panelId}-source`}>{localeText(locale, 'Submission', 'Отправка')}</label>
          <select id={`${panelId}-source`} value={state.submissionSource} onChange={(e) => onNavigate({ submissionSource: e.target.value as NormalizedTimeLedgerQuery['submissionSource'] })}>
            <option value="all">{localeText(locale, 'Any', 'Любая')}</option>
            <option value="manual">{localeText(locale, 'Manual', 'Вручную')}</option>
            <option value="auto">{localeText(locale, 'Automatic', 'Автоматически')}</option>
          </select>
        </div>
        <div className="ledger-filter-field">
          <label htmlFor={`${panelId}-submitted`}>{localeText(locale, 'Worker submitted?', 'Работник сдал?')}</label>
          <select id={`${panelId}-submitted`} value={state.submissionState} onChange={(e) => onNavigate({ submissionState: e.target.value as NormalizedTimeLedgerQuery['submissionState'] })}>
            <option value="all">{localeText(locale, 'Any', 'Любое')}</option>
            <option value="submitted">{localeText(locale, 'Submitted', 'Сдал')}</option>
            <option value="not_submitted">{localeText(locale, 'Not submitted', 'Ещё не сдал')}</option>
          </select>
        </div>
      </details>

      <div className="ledger-filter-actions">
        <button
          type="button"
          className="ledger-link-button"
          onClick={() => {
            setSelectedCustomer(null);
            onNavigate(blankFilters());
          }}
        >
          {localeText(locale, 'Reset', 'Сброс')}
        </button>
      </div>
    </div>
  );

  return (
    <div className="ledger-filterbar">
      <button
        type="button"
        ref={toggleButtonRef}
        className="ledger-filters-toggle"
        aria-expanded={mobileOpen}
        aria-controls={panelId}
        onClick={openDrawer}
      >
        {localeText(locale, 'Filters', 'Фильтры')}
        {count > 0 && <span className="ledger-filter-count">{count}</span>}
      </button>

      {mobileOpen && <div className="ledger-filter-backdrop" onClick={closeDrawer} />}

      <div
        id={panelId}
        ref={panelRef}
        className={mobileOpen ? 'ledger-filter-panel is-open' : 'ledger-filter-panel'}
        role={mobileOpen ? 'dialog' : undefined}
        aria-modal={mobileOpen ? true : undefined}
        aria-label={localeText(locale, 'Filters', 'Фильтры')}
      >
        {mobileOpen && (
          <div className="ledger-filter-panel-head">
            <h2>{localeText(locale, 'Filters', 'Фильтры')}</h2>
            <button type="button" className="ledger-drawer-close" onClick={closeDrawer} aria-label={localeText(locale, 'Close', 'Закрыть')}>
              ×
            </button>
          </div>
        )}
        {fields}
      </div>
    </div>
  );
}
