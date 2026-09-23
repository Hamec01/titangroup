import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import type { LedgerIssue } from '@/lib/reporting/time-ledger';
import {
  massPreviewSummaryLabel,
  massPeriodLabel,
  massAlreadyApprovedLabel,
  massTechnicallyBlockedIntroLabel,
  massWarningsIntroLabel,
  massConfirmAnywayLabel,
  massConfirmCleanLabel,
  noCustomerGroupLabel,
  issueLabel
} from '@/lib/reporting/ledger-ui-text';
import { formatWorkedDuration } from '@/lib/reporting/report-format';

export interface MassPreviewItemDto {
  itemKey: { timesheetId: string; siteId: string; workAreaId: string | null; weekStart: string; employeeId: string | null };
  employeeName: string | null;
  weekEnd: string | null;
  workedMinutes: number | null;
  matchesExpectedFingerprint: boolean;
  warnings: LedgerIssue[];
  technicalBlocker: { code: string; message: string } | null;
  outcome: 'WILL_APPROVE' | 'WILL_SUPERSEDE_AND_APPROVE' | 'ALREADY_APPROVED_NOOP' | 'TECHNICALLY_BLOCKED' | 'STALE';
}

export interface MassPreviewResponseDto {
  context: {
    scope: 'CUSTOMER' | 'WEEK';
    siteId: string | null;
    siteName: string | null;
    workAreaId: string | null;
    workAreaName: string | null;
    /** UT9-B — set only for scope='WEEK' ("Принять всю неделю"): whose week this is. */
    employeeId: string | null;
    employeeName: string | null;
    periodStart: string;
    periodEnd: string;
  };
  summary: { weekPartCount: number; employeeCount: number; workedMinutes: number; alreadyApprovedCount: number; technicallyBlockedCount: number; staleCount: number };
  items: MassPreviewItemDto[];
  confirmationToken?: string;
}

// UT6-B (updated UT6-B-fixup #2) — the read-only result of a mass preview (UT6-A-R1 §9): заказчик
// (workAreaName) AND объект (siteName) shown separately (never one standing in for the other), the
// server-computed period (context.periodStart/periodEnd — never client text), the rounded total, and
// three clearly separate lists (technically-blocked, warnings, plain summary). Never auto-commits
// from here — the caller always requires one explicit click on the primary button this component
// renders, even when there is nothing to warn about (§9's "show a short clear confirmation"
// requirement).
export function MassApprovePreviewPanel({
  locale,
  preview,
  onConfirm,
  onCancel,
  confirmDisabled
}: {
  locale: AppLocale;
  preview: MassPreviewResponseDto;
  onConfirm: () => void;
  onCancel: () => void;
  confirmDisabled: boolean;
}) {
  const blockedItems = preview.items.filter((it) => it.outcome === 'TECHNICALLY_BLOCKED' || it.outcome === 'STALE');
  const warningItems = preview.items.filter((it) => it.warnings.length > 0 && it.outcome !== 'TECHNICALLY_BLOCKED' && it.outcome !== 'STALE');
  const canCommit = !!preview.confirmationToken && !confirmDisabled;
  const customerLabel = preview.context.workAreaName ?? noCustomerGroupLabel(locale);

  return (
    <div className="ledger-mass-preview" role="alert">
      <p className="ledger-mass-preview-context">
        {preview.context.scope === 'WEEK'
          ? `${preview.context.employeeName ?? ''} · ${massPeriodLabel(preview.context.periodStart, preview.context.periodEnd, locale)}`
          : `${customerLabel} · ${preview.context.siteName} · ${massPeriodLabel(preview.context.periodStart, preview.context.periodEnd, locale)}`}
      </p>
      <p className="ledger-mass-preview-context">
        {massPreviewSummaryLabel(preview.summary.employeeCount, preview.summary.weekPartCount, locale)} · {formatWorkedDuration(preview.summary.workedMinutes, locale)}
      </p>
      {preview.summary.alreadyApprovedCount > 0 && <p className="ledger-mass-preview-already">{massAlreadyApprovedLabel(preview.summary.alreadyApprovedCount, locale)}</p>}

      {blockedItems.length > 0 && (
        <div className="ledger-mass-preview-section ledger-mass-preview-blocked">
          <p>{massTechnicallyBlockedIntroLabel(locale)}</p>
          <ul>
            {blockedItems.map((it, i) => (
              <li key={i}>
                {it.employeeName ?? it.itemKey.timesheetId} · {it.itemKey.weekStart}
                {it.technicalBlocker ? ` — ${it.technicalBlocker.message}` : ''}
                {!it.technicalBlocker && it.outcome === 'STALE' ? ` — ${localeText(locale, 'changed since preview', 'изменилось с момента проверки')}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {warningItems.length > 0 && (
        <div className="ledger-mass-preview-section ledger-mass-preview-warnings">
          <p>{massWarningsIntroLabel(locale)}</p>
          <ul>
            {warningItems.map((it, i) => (
              <li key={i}>
                {it.employeeName} · {it.weekEnd ?? it.itemKey.weekStart}: {it.warnings.map((w) => issueLabel(w, locale)).join(', ')}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="ledger-approve-actions">
        <button type="button" className="ledger-approve-button" disabled={!canCommit} onClick={onConfirm}>
          {warningItems.length > 0 ? massConfirmAnywayLabel(locale) : massConfirmCleanLabel(locale)}
        </button>
        <button type="button" className="ledger-link-button" onClick={onCancel}>
          {localeText(locale, 'Change selection', 'Изменить выбор')}
        </button>
      </div>
    </div>
  );
}
