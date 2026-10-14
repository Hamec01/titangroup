'use client';

import { useId, useState } from 'react';
import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import type { WeeklyCustomerSliceRow } from '@/lib/reporting/time-ledger';
import { formatWorkedDuration } from '@/lib/reporting/report-format';
import { approvalStateLabel, approvalStateTone, submissionStateLabel, issueCountLabel, selectRowCheckboxLabel } from '@/lib/reporting/ledger-ui-text';
import { StatusBadge } from './StatusBadge';
import { ExpandedWeekPanel } from './ExpandedWeekPanel';

// UT4-B — inline expansion, no navigation (agreed decisions). The expanded/collapsed flag is PURE
// local component state — never written to the URL, so it can never interfere with pagination or
// Back/Forward (explicitly verified by the browser test).
//
// UT6-B — the mass-approval checkbox lives OUTSIDE the expand/collapse <button> (a checkbox is not
// valid nested-interactive-content inside a <button>, and stopPropagation on its own click keeps a
// checkbox click from also toggling the row open/closed). `selected`/`selectionDisabled` are owned
// by TimesheetsLedgerView, not this row — selection must persist across this row unmounting on page
// navigation (UT6-A-R1 §7).
export function WorkerSliceRow({
  locale,
  approvalEnabled,
  row,
  onApproved,
  selected = false,
  selectionDisabled = false,
  onToggleSelect,
  onSelectWholeWeek,
  wholeWeekBusy = false,
  wholeWeekTooMany
}: {
  locale: AppLocale;
  approvalEnabled: boolean;
  row: WeeklyCustomerSliceRow;
  onApproved: () => void;
  selected?: boolean;
  selectionDisabled?: boolean;
  onToggleSelect?: () => void;
  /** UT9-B — "Принять всю неделю" (ExpandedWeekPanel renders the actual button). */
  onSelectWholeWeek?: (row: WeeklyCustomerSliceRow) => void;
  wholeWeekBusy?: boolean;
  wholeWeekTooMany?: { totalItems: number; max: number } | null;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const issueCount = row.blockers.length + row.warnings.length;

  return (
    <div className="ledger-row">
      <div className="ledger-row-summary-wrap">
        {onToggleSelect && (
          <input
            type="checkbox"
            className="ledger-row-checkbox"
            checked={selected}
            disabled={selectionDisabled}
            onChange={onToggleSelect}
            onClick={(e) => e.stopPropagation()}
            aria-label={selectRowCheckboxLabel(locale)}
          />
        )}
        <button type="button" className="ledger-row-summary" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}>
          <span className="ledger-row-name">
            {row.employeeName} · #{row.employeeNumber}
          </span>
          <span className="ledger-row-week">{row.logicalKey.weekStart}</span>
          <span className="ledger-row-hours">{formatWorkedDuration(row.workedMinutes, locale)}</span>
          {approvalEnabled && <StatusBadge label={approvalStateLabel(row.approvalState, locale)} tone={approvalStateTone(row.approvalState)} />}
          <span className="ledger-row-submission">{submissionStateLabel(row.submissionState, locale)}</span>
          {issueCount > 0 && (
            <span className="ledger-row-issue-count">
              {row.blockers.length > 0 ? issueCountLabel(row.blockers.length, 'blocker', locale) : null}
              {row.blockers.length > 0 && row.warnings.length > 0 ? ' · ' : null}
              {row.warnings.length > 0 ? issueCountLabel(row.warnings.length, 'warning', locale) : null}
            </span>
          )}
          <span className="ledger-row-toggle-label">{open ? localeText(locale, 'Close', 'Свернуть') : localeText(locale, 'Open week', 'Открыть неделю')}</span>
        </button>
      </div>
      {open && (
        <div id={panelId}>
          <ExpandedWeekPanel
            locale={locale}
            approvalEnabled={approvalEnabled}
            row={row}
            onApproved={onApproved}
            onSelectWholeWeek={onSelectWholeWeek ? () => onSelectWholeWeek(row) : undefined}
            wholeWeekBusy={wholeWeekBusy}
            wholeWeekTooMany={wholeWeekTooMany}
          />
        </div>
      )}
    </div>
  );
}
