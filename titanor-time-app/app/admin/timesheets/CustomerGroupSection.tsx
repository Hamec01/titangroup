import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import type { CustomerGroup, WeeklyCustomerSliceRow } from '@/lib/reporting/time-ledger';
import type { HistoricalApprovalRow as HistoricalApprovalRowData } from '@/lib/reporting/customer-hours-history';
import { formatWorkedDuration } from '@/lib/reporting/report-format';
import { noCustomerGroupLabel, selectVisibleLabel, confirmAllMatchingLabel, massDifferentCustomerNote, massTooManyLabel, massSelectionLockedNote, historicalSectionNoteLabel } from '@/lib/reporting/ledger-ui-text';
import { WorkerSliceRow } from './WorkerSliceRow';
import { HistoricalApprovalRow } from './HistoricalApprovalRow';

export function rowLogicalKey(row: WeeklyCustomerSliceRow): string {
  return `${row.logicalKey.timesheetId}:${row.logicalKey.siteId}:${row.logicalKey.workAreaId ?? ''}:${row.logicalKey.weekStart}`;
}
export function customerKeyOf(siteId: string, workAreaId: string | null): string {
  return `${siteId}::${workAreaId ?? ''}`;
}

// UT4-B point 3 — the API never returns a global total per customer group (only global summary +
// the current page's rows), so this heading explicitly labels its number as page-scoped ("На этой
// странице: …") rather than presenting a page subtotal as if it were the customer's full total.
//
// UT6-B — "Выбрать видимые" and "Подтвердить все подходящие часы <Заказчика>" are both scoped to
// THIS group's own (siteId, workAreaId) — UT6-A-R1 §4/§7's "one operation, one customer" rule is
// enforced structurally here (each group can only ever add rows of its OWN customer to the shared
// selection), not just re-checked server-side.
export function CustomerGroupSection({
  locale,
  group,
  onApproved,
  selectedKeys,
  selectedCustomerKey,
  onToggleSelect,
  onSelectVisible,
  onConfirmAllMatching,
  allMatchingBusy,
  allMatchingTooMany,
  selectionLocked,
  historicalRows,
  editReturnTo,
  onSelectWholeWeek,
  wholeWeekBusyKey,
  wholeWeekTooMany
}: {
  locale: AppLocale;
  group: CustomerGroup;
  onApproved: () => void;
  selectedKeys?: Set<string>;
  selectedCustomerKey?: string | null;
  onToggleSelect?: (row: WeeklyCustomerSliceRow) => void;
  onSelectVisible?: (group: CustomerGroup) => void;
  onConfirmAllMatching?: (group: CustomerGroup) => void;
  allMatchingBusy?: boolean;
  allMatchingTooMany?: { totalItems: number; max: number } | null;
  /** UT6-B-fixup #1 — true while the mass-approval bar has a live preview/attempt open (any phase
   *  other than 'idle'). Selection must be frozen for as long as a confirmationToken is bound to it,
   *  so every selection control in this group is disabled, exactly like a different-customer lock. */
  selectionLocked?: boolean;
  /** UT7-B-fixup #2 — this customer's (siteId, workAreaId) historical approval-issue rows (removed
   *  slice / unreadable source), matched by TimesheetsLedgerView. Rendered below the normal rows,
   *  never counted in pageMinutes/distinctWorkers, never selectable for mass approval. */
  historicalRows?: HistoricalApprovalRowData[];
  /** Exact reactive ledger URL to return to after using the existing correction editor. */
  editReturnTo?: string;
  /** UT9-B — "Принять всю неделю" (ExpandedWeekPanel's own button, threaded down here just to reach
   *  WorkerSliceRow). Undefined for the orphan-historical render (no live rows to select from). */
  onSelectWholeWeek?: (row: WeeklyCustomerSliceRow) => void;
  wholeWeekBusyKey?: string | null;
  /** UT9-B-fixup #1 — set only for the ONE row whose whole-week attempt exceeded the cap. */
  wholeWeekTooMany?: { rowKey: string; totalItems: number; max: number } | null;
}) {
  const distinctWorkers = new Set(group.rows.map((r) => r.logicalKey.employeeId)).size;
  const pageMinutes = group.rows.reduce((sum, r) => sum + r.workedMinutes, 0);
  const customerName = group.workAreaId === null ? noCustomerGroupLabel(locale) : (group.workAreaName ?? group.workAreaId);
  const title = group.workAreaId === null ? customerName : `${customerName} · ${group.siteName}`;
  const groupCustomerKey = customerKeyOf(group.siteId, group.workAreaId);
  const differentCustomer = selectedCustomerKey != null && selectedCustomerKey !== groupCustomerKey;
  const massDisabled = differentCustomer || !!selectionLocked;

  return (
    <section className="ledger-group">
      <div className="ledger-group-head">
        <div>
          <h2 className="ledger-group-title">{title}</h2>
          <p className="ledger-group-subtotal">
            {localeText(locale, 'On this page', 'На этой странице')}: {distinctWorkers} {localeText(locale, 'workers', 'работников')} · {formatWorkedDuration(pageMinutes, locale)}
          </p>
        </div>
        {onToggleSelect && (
          <div className="ledger-group-mass-actions">
            <button type="button" className="ledger-link-button" disabled={massDisabled} onClick={() => onSelectVisible?.(group)}>
              {selectVisibleLabel(locale)}
            </button>
            <button type="button" className="ledger-link-button" disabled={massDisabled || allMatchingBusy} onClick={() => onConfirmAllMatching?.(group)}>
              {confirmAllMatchingLabel(customerName, locale)}
            </button>
          </div>
        )}
      </div>
      {differentCustomer && <p className="ledger-group-mass-note">{massDifferentCustomerNote(locale)}</p>}
      {selectionLocked && !differentCustomer && <p className="ledger-group-mass-note">{massSelectionLockedNote(locale)}</p>}
      {allMatchingTooMany && <p className="ledger-group-mass-note">{massTooManyLabel(allMatchingTooMany.totalItems, allMatchingTooMany.max, locale)}</p>}
      <ul className="ledger-row-list">
        {group.rows.map((row) => {
          const key = rowLogicalKey(row);
          return (
            <li key={key}>
              <WorkerSliceRow
                locale={locale}
                row={row}
                onApproved={onApproved}
                selected={selectedKeys?.has(key) ?? false}
                selectionDisabled={massDisabled}
                onToggleSelect={onToggleSelect ? () => onToggleSelect(row) : undefined}
                onSelectWholeWeek={onSelectWholeWeek}
                wholeWeekBusy={wholeWeekBusyKey === key}
                wholeWeekTooMany={wholeWeekTooMany?.rowKey === key ? wholeWeekTooMany : null}
                editReturnTo={editReturnTo}
              />
            </li>
          );
        })}
      </ul>
      {/* UT7-B-fixup-2 #5 — a separate list (not appended to the one above) so the explanatory note
          can sit between the two without breaking <ul>'s "only <li> children" rule; also keeps the
          "these do not count toward the current total" distinction visually unambiguous. */}
      {historicalRows && historicalRows.length > 0 && (
        <>
          <p className="ledger-historical-note">{historicalSectionNoteLabel(locale)}</p>
          <ul className="ledger-row-list ledger-historical-list">
            {historicalRows.map((row) => (
              <li key={`hist:${row.timesheetId}:${row.siteId}:${row.workAreaId ?? ''}:${row.weekStart}`}>
                <HistoricalApprovalRow locale={locale} row={row} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
