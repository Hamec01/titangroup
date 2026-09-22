'use client';

import { useId, useState } from 'react';
import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import type { WeeklyCustomerSliceRow } from '@/lib/reporting/time-ledger';
import { formatWorkedDuration } from '@/lib/reporting/report-format';
import { approvalStateLabel, approvalStateTone, submissionStateLabel, issueCountLabel } from '@/lib/reporting/ledger-ui-text';
import { StatusBadge } from './StatusBadge';
import { ExpandedWeekPanel } from './ExpandedWeekPanel';

// UT4-B — inline expansion, no navigation, no checkbox, no confirm button (agreed decisions). The
// expanded/collapsed flag is PURE local component state — never written to the URL, so it can
// never interfere with pagination or Back/Forward (explicitly verified by the browser test).
export function WorkerSliceRow({ locale, row }: { locale: AppLocale; row: WeeklyCustomerSliceRow }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const issueCount = row.blockers.length + row.warnings.length;

  return (
    <div className="ledger-row">
      <button type="button" className="ledger-row-summary" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}>
        <span className="ledger-row-name">
          {row.employeeName} · #{row.employeeNumber}
        </span>
        <span className="ledger-row-week">{row.logicalKey.weekStart}</span>
        <span className="ledger-row-hours">{formatWorkedDuration(row.workedMinutes, locale)}</span>
        <StatusBadge label={approvalStateLabel(row.approvalState, locale)} tone={approvalStateTone(row.approvalState)} />
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
      {open && (
        <div id={panelId}>
          <ExpandedWeekPanel locale={locale} row={row} />
        </div>
      )}
    </div>
  );
}
