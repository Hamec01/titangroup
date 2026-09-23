'use client';

import { useEffect, useState } from 'react';
import type { AppLocale } from '@/lib/i18n/locale';
import { formatWorkedDuration } from '@/lib/reporting/report-format';
import { formatHelsinkiDateTime } from '@/lib/helsinki-datetime';
import {
  diffLoadingLabel,
  diffErrorLabel,
  diffBeforeAfterLabel,
  diffApprovedByLabel,
  diffDeltaLabel,
  diffChangedDatesLabel,
  diffSliceRemovedLabel,
  diffSourceUnreadableLabel,
  diffUnchangedLabel
} from '@/lib/reporting/ledger-ui-text';

interface DiffResponse {
  state: 'UNCHANGED' | 'FINGERPRINT_CHANGED' | 'SLICE_REMOVED' | 'SOURCE_UNREADABLE';
  before: { workedMinutes: number; approvedAt: string; approvedByUserName: string };
  after: { workedMinutes: number } | null;
  changedDates: string[];
  deltaWorkedMinutes: number | null;
}

type Phase = 'loading' | 'ready' | 'error';

export interface ApprovalDiffLogicalKey {
  timesheetId: string;
  siteId: string;
  workAreaId: string | null;
  weekStart: string;
}

// UT7-B — "было / стало" panel for a row showing CHANGED_AFTER_APPROVAL or NEEDS_ATTENTION +
// supersededFingerprintMatch. Fetched lazily (only rendered by ExpandedWeekPanel for exactly these
// two states, and only once the row is actually expanded) from the read-only
// GET /api/admin/time-ledger/approval-diff — never embedded in the paginated ledger GET. Every
// number/name shown here comes from the server response; nothing is computed or trusted client-side.
//
// UT7-B-fixup #2 — takes just the logical key rather than a full WeeklyCustomerSliceRow (which is
// all it ever actually read) so the same panel can be reused by HistoricalApprovalRow.tsx, whose
// rows have no live WeeklyCustomerSliceRow at all (that is exactly why they need this panel).
export function ApprovalDiffPanel({ locale, logicalKey }: { locale: AppLocale; logicalKey: ApprovalDiffLogicalKey }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [diff, setDiff] = useState<DiffResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setDiff(null);
    const qs = new URLSearchParams({ timesheetId: logicalKey.timesheetId, siteId: logicalKey.siteId, weekStart: logicalKey.weekStart });
    if (logicalKey.workAreaId) qs.set('workAreaId', logicalKey.workAreaId);

    fetch(`/api/admin/time-ledger/approval-diff?${qs.toString()}`, { credentials: 'same-origin' })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setPhase('error');
          return;
        }
        const body = (await res.json()) as DiffResponse;
        if (cancelled) return;
        setDiff(body);
        setPhase('ready');
      })
      .catch(() => {
        if (!cancelled) setPhase('error');
      });

    return () => {
      cancelled = true;
    };
  }, [logicalKey.timesheetId, logicalKey.siteId, logicalKey.workAreaId, logicalKey.weekStart]);

  if (phase === 'loading') {
    return (
      <p className="ledger-diff-loading" role="status" aria-live="polite">
        {diffLoadingLabel(locale)}
      </p>
    );
  }
  if (phase === 'error' || !diff) {
    return (
      <p className="ledger-diff-error" role="alert">
        {diffErrorLabel(locale)}
      </p>
    );
  }

  const beforeText = formatWorkedDuration(diff.before.workedMinutes, locale);
  const afterText = diff.after ? formatWorkedDuration(diff.after.workedMinutes, locale) : '—';

  return (
    <div className="ledger-diff-panel">
      {diff.state === 'SLICE_REMOVED' && <p className="ledger-diff-note ledger-diff-note-removed">{diffSliceRemovedLabel(locale)}</p>}
      {diff.state === 'SOURCE_UNREADABLE' && <p className="ledger-diff-note ledger-diff-note-unreadable">{diffSourceUnreadableLabel(locale)}</p>}
      {diff.state === 'UNCHANGED' && <p className="ledger-diff-note">{diffUnchangedLabel(locale)}</p>}
      <p className="ledger-diff-before-after">{diffBeforeAfterLabel(beforeText, afterText, locale)}</p>
      {diff.deltaWorkedMinutes !== null && diff.deltaWorkedMinutes !== 0 && <p className="ledger-diff-delta">{diffDeltaLabel(diff.deltaWorkedMinutes, locale)}</p>}
      {diff.changedDates.length > 0 && <p className="ledger-diff-dates">{diffChangedDatesLabel(diff.changedDates, locale)}</p>}
      <p className="ledger-diff-approved-by">{diffApprovedByLabel(diff.before.approvedByUserName, formatHelsinkiDateTime(diff.before.approvedAt), locale)}</p>
    </div>
  );
}
