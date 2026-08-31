'use client';

// docs/titanor-time/CUSTOMER_REPORT_SCOPE_PICKER_RU.md §5/§7 — a reusable "pick from a long list"
// panel: header + live count, search, "select all / clear" (all pages, not just the visible 20),
// an internally-scrolling list paginated 20 per page, one real <input type=checkbox> + <label> per
// row. Click the checkbox OR anywhere on the row toggles it. Selected row = check + tinted
// background + border. No "x" affordance anywhere. Pure presentational — the parent owns the
// selection Set and the ALL/PICK mode.

import { useId, useMemo, useState } from 'react';

export interface ScopeItem {
  id: string;
  /** first line — e.g. site name, or "Lastname Firstname". */
  primary: string;
  /** optional second line — e.g. employee number + sites + reason chips. */
  secondary?: string;
  /** everything the search box matches against, already lowercased by the caller. */
  searchText: string;
}

interface ScopePickerPanelProps {
  title: string;
  items: ScopeItem[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  labels: {
    count: (selected: number, total: number) => string;
    searchPlaceholder: string;
    selectAll: string;
    clearAll: string;
    empty: string;
    noMatch: string;
    page: (current: number, total: number) => string;
    prev: string;
    next: string;
  };
  idPrefix: string;
  disabled?: boolean;
  pageSize?: number;
}

export function ScopePickerPanel({ title, items, selectedIds, onToggle, onSelectAll, onClearAll, labels, idPrefix, disabled = false, pageSize = 20 }: ScopePickerPanelProps) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const headingId = useId();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    const terms = q.split(/\s+/);
    return items.filter((it) => terms.every((t) => it.searchText.includes(t)));
  }, [items, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize);

  return (
    <section className={`scope-panel${disabled ? ' is-disabled' : ''}`} aria-labelledby={headingId}>
      <div className="scope-panel-head">
        <h3 id={headingId}>{title}</h3>
        <p className="scope-count" aria-live="polite">
          {labels.count(selectedIds.size, items.length)}
        </p>
      </div>

      {!disabled && (
        <>
          <div className="scope-panel-controls">
            <input
              type="search"
              className="scope-search"
              value={query}
              placeholder={labels.searchPlaceholder}
              aria-label={labels.searchPlaceholder}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
            <div className="scope-bulk">
              <button type="button" className="wk-inline-secondary" onClick={onSelectAll}>
                {labels.selectAll}
              </button>
              <button type="button" className="wk-inline-secondary" onClick={onClearAll}>
                {labels.clearAll}
              </button>
            </div>
          </div>

          {items.length === 0 ? (
            <p className="scope-empty">{labels.empty}</p>
          ) : filtered.length === 0 ? (
            <p className="scope-empty">{labels.noMatch}</p>
          ) : (
            <>
              <ul className="scope-list" role="group" aria-labelledby={headingId}>
                {visible.map((it) => {
                  const checked = selectedIds.has(it.id);
                  const cid = `${idPrefix}-${it.id}`;
                  return (
                    <li key={it.id} className={`scope-row${checked ? ' is-selected' : ''}`}>
                      <label htmlFor={cid} className="scope-row-label">
                        <input id={cid} type="checkbox" checked={checked} onChange={() => onToggle(it.id)} />
                        <span className="scope-row-body">
                          <span className="scope-row-primary">{it.primary}</span>
                          {it.secondary ? <span className="scope-row-secondary">{it.secondary}</span> : null}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>

              {pageCount > 1 && (
                <nav className="scope-pager" aria-label={title}>
                  <button type="button" className="wk-inline-secondary" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0}>
                    {labels.prev}
                  </button>
                  <span>{labels.page(safePage + 1, pageCount)}</span>
                  <button type="button" className="wk-inline-secondary" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={safePage >= pageCount - 1}>
                    {labels.next}
                  </button>
                </nav>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
