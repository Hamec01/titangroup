'use client';

import { useId, useState } from 'react';
import type { AppLocale } from '@/lib/i18n/locale';
import type { HistoricalApprovalRow as HistoricalApprovalRowData } from '@/lib/reporting/customer-hours-history';
import { formatWorkedDuration } from '@/lib/reporting/report-format';
import { formatHelsinkiDateTime } from '@/lib/helsinki-datetime';
import { historicalRemovedStatusLabel, historicalUnreadableStatusLabel, historicalOpenLabel, diffApprovedByLabel } from '@/lib/reporting/ledger-ui-text';
import { StatusBadge } from './StatusBadge';
import { ApprovalDiffPanel } from './ApprovalDiffPanel';

// UT7-B-fixup #2 — one row for a logical key whose approval history exists but whose hours no
// longer show up as a normal WeeklyCustomerSliceRow (the slice was removed, or the timesheet's
// source is currently unreadable). Deliberately much smaller than WorkerSliceRow: no checkbox, no
// mass-approve, no re-confirm action — this row is never approvable, it is purely a visible record
// of what used to be confirmed. Expanding it reuses ApprovalDiffPanel, the exact same "было/стало"
// panel a normal changed row shows, fetched from the same read-only diff endpoint by the same
// logical key — no separate diff logic for this case.
export function HistoricalApprovalRow({ locale, row }: { locale: AppLocale; row: HistoricalApprovalRowData }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const statusLabel = row.reason === 'SLICE_REMOVED' ? historicalRemovedStatusLabel(locale) : historicalUnreadableStatusLabel(locale);

  return (
    <div className="ledger-row ledger-row-historical">
      <div className="ledger-row-summary-wrap">
        <button type="button" className="ledger-row-summary" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}>
          <span className="ledger-row-name">
            {row.employeeName} · #{row.employeeNumber}
          </span>
          <span className="ledger-row-week">{row.weekStart}</span>
          <span className="ledger-row-hours">{formatWorkedDuration(row.lastApproval.workedMinutes, locale)}</span>
          <StatusBadge label={statusLabel} tone="warning" />
          <span className="ledger-row-toggle-label">{historicalOpenLabel(locale, open)}</span>
        </button>
      </div>
      {open && (
        <div id={panelId} className="ledger-expanded">
          <p className="ledger-approval-history">{diffApprovedByLabel(row.lastApproval.approvedByUserName, formatHelsinkiDateTime(row.lastApproval.approvedAt), locale)}</p>
          <ApprovalDiffPanel locale={locale} logicalKey={{ timesheetId: row.timesheetId, siteId: row.siteId, workAreaId: row.workAreaId, weekStart: row.weekStart }} />
        </div>
      )}
    </div>
  );
}
