'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import { formatWorkedDuration } from '@/lib/reporting/report-format';
import type { SiteOption } from '@/lib/attendance-overview-lookups';
import type { CustomerWorkAreaOption } from '@/lib/reporting/customer-workarea-picker';
import {
  parseTimeLedgerUiState,
  uiStateToHref,
  uiStateToSummaryApiUrl,
  uiStateToSummaryExportApiUrl,
  nextUiState,
  type TimeLedgerUiState
} from '@/lib/reporting/time-ledger-ui-query';
import {
  summaryConfirmedForCustomerLabel,
  summaryConfirmedMinutesLabel,
  summaryPendingMinutesLabel,
  summaryChangedMinutesLabel,
  summaryWarningsCountLabel,
  summaryTechnicalErrorsLabel,
  summaryHistoricalSectionTitleLabel,
  summaryHistoricalNoteLabel,
  summaryWorkersLabel,
  summaryFinalReadyLabel,
  summaryFinalNotReadyLabel,
  summaryExportPreviewCsvLabel,
  summaryExportPreviewPdfLabel,
  summaryExportFinalCsvLabel,
  summaryExportFinalPdfLabel,
  summaryAllTimeNotAllowedLabel,
  summaryRangeTooLargeLabel,
  summarySelectionTooLargeLabel,
  summaryWorkAreaNoneRequiresSiteLabel,
  summaryLoadErrorLabel,
  summaryBlockerReasonLabel,
  summaryBlockersHeadingLabel,
  summaryNotSubmittedLabel
} from '@/lib/reporting/ledger-ui-text';
import { LedgerTopBar } from './LedgerTopBar';
import { LedgerFilterBar } from './LedgerFilterBar';

interface SummaryCustomerTotalDto {
  siteId: string;
  siteName: string;
  workAreaId: string | null;
  workAreaName: string | null;
  confirmedMinutes: number;
  confirmedWorkerCount: number;
  pendingMinutes: number;
  changedMinutes: number;
  pendingCount: number;
  changedCount: number;
  warningCount: number;
  historicalCount: number;
}

interface SummaryBlockerDto {
  reason: 'PENDING' | 'NEEDS_ATTENTION' | 'CHANGED_AFTER_APPROVAL' | 'SOURCE_UNREADABLE' | 'HISTORICAL_INCOMPLETE' | 'NOT_SUBMITTED';
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  siteId: string | null;
  siteName: string | null;
  workAreaId: string | null;
  workAreaName: string | null;
  weekStart: string | null;
  weekEnd: string | null;
}

interface SummaryResponse {
  requestedRange: { startDate: string; endDate: string };
  effectiveWeekRange: { startDate: string; endDate: string };
  totals: {
    confirmedMinutes: number;
    pendingMinutes: number;
    changedMinutes: number;
    confirmedWorkerCount: number;
    pendingWorkerCount: number;
    changedWorkerCount: number;
    warningCount: number;
    sourceErrorCount: number;
    historicalCount: number;
    historicalTruncated: boolean;
    notSubmittedCount: number;
    notSubmittedWorkerCount: number;
  };
  byCustomer: SummaryCustomerTotalDto[];
  readyForCustomerExport: boolean;
  blockers: SummaryBlockerDto[];
}

type LoadState = { phase: 'loading' } | { phase: 'ready'; data: SummaryResponse } | { phase: 'error'; code: string; message: string };

// UT8-B — the real "Сводка" tab (replaces SummaryTabPlaceholder). Shares the SAME TimeLedgerUiState/
// URL as the "Табель" tab (TimesheetsTabs.tsx only ever changes `view`), so a customer/period picked
// on either tab carries over automatically. Unlike TimesheetsLedgerView, this component does NOT
// need the raw-History-API/no-duplicate-SSR-fetch dance — TimesheetsLedgerPage.tsx's
// view==='summary' branch does no data fetching of its own (see that file), so a plain
// router.replace() here costs nothing extra server-side; useSearchParams() can be read reactively.
export function SummaryTab({
  locale,
  initialState,
  initialSiteOptions,
  initialSelectedCustomerOptions
}: {
  locale: AppLocale;
  initialState: TimeLedgerUiState;
  initialSiteOptions: SiteOption[];
  initialSelectedCustomerOptions: CustomerWorkAreaOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const parsed = parseTimeLedgerUiState(searchParams, new Date());
  const state: TimeLedgerUiState = parsed.ok ? parsed.state : initialState;

  const [load, setLoad] = useState<LoadState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setLoad({ phase: 'loading' });
    fetch(uiStateToSummaryApiUrl(state), { credentials: 'same-origin' })
      .then(async (res) => {
        if (cancelled) return;
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          if (body?.error?.code === 'NOT_AUTHENTICATED') {
            router.push('/login');
            return;
          }
          setLoad({ phase: 'error', code: body?.error?.code ?? 'UNKNOWN', message: body?.error?.message ?? '' });
          return;
        }
        setLoad({ phase: 'ready', data: body as SummaryResponse });
      })
      .catch(() => {
        if (!cancelled) setLoad({ phase: 'error', code: 'NETWORK_ERROR', message: '' });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.allTime, state.startDate, state.endDate, state.employeeSearch, state.siteId, state.workAreaId]);

  const navigate = (changes: Partial<TimeLedgerUiState>) => {
    const next = nextUiState(state, changes);
    router.replace(uiStateToHref(pathname, next));
  };

  return (
    <div className="ledger-view">
      <LedgerTopBar locale={locale} state={state} onNavigate={navigate} />
      <LedgerFilterBar locale={locale} state={state} onNavigate={navigate} siteOptions={initialSiteOptions} initialSelectedCustomerOptions={initialSelectedCustomerOptions} />
      {load.phase === 'loading' && (
        <p className="ledger-loading" role="status" aria-live="polite">
          {localeText(locale, 'Loading…', 'Загрузка…')}
        </p>
      )}
      {load.phase === 'error' && <SummaryErrorBanner locale={locale} code={load.code} />}
      {load.phase === 'ready' && <SummaryBody locale={locale} data={load.data} state={state} />}
    </div>
  );
}

function SummaryErrorBanner({ locale, code }: { locale: AppLocale; code: string }) {
  let message: string;
  if (code === 'ALL_TIME_NOT_ALLOWED') message = summaryAllTimeNotAllowedLabel(locale);
  else if (code === 'RANGE_TOO_LARGE') message = summaryRangeTooLargeLabel(6, locale);
  else if (code === 'SELECTION_TOO_LARGE') message = summarySelectionTooLargeLabel(locale);
  else if (code === 'WORK_AREA_NONE_REQUIRES_SITE') message = summaryWorkAreaNoneRequiresSiteLabel(locale);
  else if (code === 'FORBIDDEN') message = localeText(locale, 'Missing required permission.', 'Недостаточно прав.');
  else message = summaryLoadErrorLabel(locale);
  return (
    <div className="ledger-error-banner" role="alert">
      <p>{message}</p>
    </div>
  );
}

function SummaryBody({ locale, data, state }: { locale: AppLocale; data: SummaryResponse; state: TimeLedgerUiState }) {
  const { totals, byCustomer, readyForCustomerExport, blockers } = data;

  return (
    <div className="ledger-summary-tab">
      <section className="ledger-summary-stat-row">
        <SummaryStat label={summaryConfirmedMinutesLabel(locale)} value={formatWorkedDuration(totals.confirmedMinutes, locale)} sub={`${totals.confirmedWorkerCount} ${summaryWorkersLabel(locale)}`} tone="confirmed" />
        <SummaryStat label={summaryPendingMinutesLabel(locale)} value={formatWorkedDuration(totals.pendingMinutes, locale)} sub={`${totals.pendingWorkerCount} ${summaryWorkersLabel(locale)}`} tone="pending" />
        <SummaryStat label={summaryChangedMinutesLabel(locale)} value={formatWorkedDuration(totals.changedMinutes, locale)} sub={`${totals.changedWorkerCount} ${summaryWorkersLabel(locale)}`} tone="changed" />
        <SummaryStat label={summaryWarningsCountLabel(locale)} value={String(totals.warningCount)} tone="neutral" />
        <SummaryStat label={summaryTechnicalErrorsLabel(locale)} value={String(totals.sourceErrorCount)} tone="error" />
        <SummaryStat label={summaryNotSubmittedLabel(locale)} value={String(totals.notSubmittedCount)} sub={`${totals.notSubmittedWorkerCount} ${summaryWorkersLabel(locale)}`} tone="error" />
      </section>

      <p className="ledger-summary-readiness" role="status">
        {readyForCustomerExport ? `✓ ${summaryFinalReadyLabel(locale)}` : `⚠ ${summaryFinalNotReadyLabel(blockers.length, locale)}`}
      </p>

      <section className="ledger-summary-export-actions">
        <a className="ledger-summary-export-link" href={uiStateToSummaryExportApiUrl(state, 'csv', 'preview')}>
          {summaryExportPreviewCsvLabel(locale)}
        </a>
        <a className="ledger-summary-export-link" href={uiStateToSummaryExportApiUrl(state, 'pdf', 'preview')}>
          {summaryExportPreviewPdfLabel(locale)}
        </a>
        <a className={`ledger-summary-export-link ledger-summary-export-final${readyForCustomerExport ? '' : ' is-disabled'}`} href={readyForCustomerExport ? uiStateToSummaryExportApiUrl(state, 'csv', 'final') : undefined} aria-disabled={!readyForCustomerExport}>
          {summaryExportFinalCsvLabel(locale)}
        </a>
        <a className={`ledger-summary-export-link ledger-summary-export-final${readyForCustomerExport ? '' : ' is-disabled'}`} href={readyForCustomerExport ? uiStateToSummaryExportApiUrl(state, 'pdf', 'final') : undefined} aria-disabled={!readyForCustomerExport}>
          {summaryExportFinalPdfLabel(locale)}
        </a>
      </section>

      {byCustomer.length === 0 ? (
        <p className="wk-empty" role="status">
          {localeText(locale, 'No results for these filters.', 'Нет результатов по этим фильтрам.')}
        </p>
      ) : (
        <table className="ledger-summary-customer-table">
          <thead>
            <tr>
              <th>{localeText(locale, 'Customer', 'Заказчик')}</th>
              <th>{localeText(locale, 'Site', 'Объект')}</th>
              <th>{summaryConfirmedMinutesLabel(locale)}</th>
              <th>{summaryPendingMinutesLabel(locale)}</th>
              <th>{summaryChangedMinutesLabel(locale)}</th>
              <th>{summaryWarningsCountLabel(locale)}</th>
              <th>{summaryHistoricalSectionTitleLabel(locale)}</th>
            </tr>
          </thead>
          <tbody>
            {byCustomer.map((c) => (
              <tr key={`${c.siteId}::${c.workAreaId ?? ''}`}>
                <td>{c.workAreaName ?? localeText(locale, '(no customer)', 'Без заказчика')}</td>
                <td>{c.siteName}</td>
                <td>{formatWorkedDuration(c.confirmedMinutes, locale)}</td>
                <td>{formatWorkedDuration(c.pendingMinutes, locale)}</td>
                <td>{formatWorkedDuration(c.changedMinutes, locale)}</td>
                <td>{c.warningCount}</td>
                <td>{c.historicalCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {totals.historicalCount > 0 && (
        <section className="ledger-summary-historical">
          <h2>{summaryHistoricalSectionTitleLabel(locale)}</h2>
          <p className="ledger-historical-note">{summaryHistoricalNoteLabel(locale)}</p>
          <p>{totals.historicalCount}</p>
        </section>
      )}

      {blockers.length > 0 && (
        <section className="ledger-summary-blockers">
          <h2>{summaryBlockersHeadingLabel(locale)}</h2>
          <ul className="ledger-plain-list">
            {blockers.map((b, i) => (
              <li key={i}>
                {b.reason === 'HISTORICAL_INCOMPLETE' ? summaryBlockerReasonLabel(b.reason, locale) : (
                  <>
                    {b.employeeName} · #{b.employeeNumber}
                    {b.workAreaName ? ` · ${b.workAreaName}` : ''}
                    {b.weekStart ? ` · ${b.weekStart}` : ''} — {summaryBlockerReasonLabel(b.reason, locale)}
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="ledger-summary-confirmed-badge-note">{summaryConfirmedForCustomerLabel(locale)}</p>
    </div>
  );
}

function SummaryStat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: 'confirmed' | 'pending' | 'changed' | 'neutral' | 'error' }) {
  return (
    <div className={`ledger-summary-stat ledger-summary-stat-${tone}`}>
      <span className="ledger-summary-stat-label">{label}</span>
      <span className="ledger-summary-stat-value">{value}</span>
      {sub && <span className="ledger-summary-stat-sub">{sub}</span>}
    </div>
  );
}
