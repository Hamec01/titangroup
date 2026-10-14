import { getTimeLedger, TimeLedgerReadChangedError, type LedgerActor, type TimeLedgerResult } from '@/lib/reporting/time-ledger';
import { loadHistoricalApprovalIssues, type HistoricalApprovalRow } from '@/lib/reporting/customer-hours-history';
import { listSiteOptionsForAdmin, type SiteOption } from '@/lib/attendance-overview-lookups';
import { resolveCustomerWorkAreaOptions, type CustomerWorkAreaOption } from '@/lib/reporting/customer-workarea-picker';
import { parseTimeLedgerUiState, uiStateToApiQuery, type TimeLedgerUiState } from '@/lib/reporting/time-ledger-ui-query';
import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import { TimesheetsTabs } from './TimesheetsTabs';
import { SummaryTab } from './SummaryTab';
import { TimesheetsLedgerView } from './TimesheetsLedgerView';
import { customerHoursApprovalEnabled } from '@/lib/customer-hours-approval-flag';

// UT4-B — Server Component entry point for the new (flag-on) /admin/timesheets body. Resolves the
// URL into a UI state via the SAME pure parser the client re-uses (lib/reporting/time-ledger-ui-query.ts),
// makes exactly ONE getTimeLedger() call for the first paint (no HTTP hop to its own API — same
// convention the rest of the admin section already uses), and hands the resolved state + result to
// the client view as props so the client's first render never re-fetches (no duplicate request).
export async function TimesheetsLedgerPage({
  locale,
  actor,
  searchParams
}: {
  locale: AppLocale;
  actor: LedgerActor;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const usp = toURLSearchParams(searchParams);
  const parsed = parseTimeLedgerUiState(usp, new Date());
  const approvalEnabled = customerHoursApprovalEnabled();

  if (!parsed.ok) {
    return (
      <main className="setup-page">
        <div className="setup-card worker-card ledger-card">
          <h1>{localeText(locale, 'Timesheets', 'Табель')}</h1>
          <p className="login-error" role="alert">
            {localeText(locale, 'This link has invalid filter parameters.', 'В этой ссылке некорректные параметры фильтра.')}
          </p>
          <a className="ledger-reset-link" href="/admin/timesheets">
            {localeText(locale, 'Reset filters', 'Сбросить фильтры')}
          </a>
        </div>
      </main>
    );
  }

  const state: TimeLedgerUiState = approvalEnabled
    ? parsed.state
    : { ...parsed.state, status: 'all', onlyChangedAfterApproval: false };

  // UT8-B — moved above the view branch: both the table view and the new "Сводка" tab need the SAME
  // site/customer filter option lists for their (shared-component) LedgerFilterBar.
  const [sites, selectedCustomerOptions] = await Promise.all([
    listSiteOptionsForAdmin(),
    state.workAreaId && state.workAreaId !== 'none' ? resolveCustomerWorkAreaOptions([state.workAreaId]) : Promise.resolve<CustomerWorkAreaOption[]>([])
  ]);

  if (state.view === 'summary') {
    return (
      <main className="setup-page">
        <div className="setup-card worker-card ledger-card">
          <h1>{localeText(locale, 'Timesheets', 'Табель')}</h1>
          <TimesheetsTabs locale={locale} state={state} />
          <SummaryTab locale={locale} approvalEnabled={approvalEnabled} initialState={state} initialSiteOptions={sites} initialSelectedCustomerOptions={selectedCustomerOptions} />
        </div>
      </main>
    );
  }

  let initialData: TimeLedgerResult | null = null;
  let initialReadChanged = false;
  let initialHistoricalRows: HistoricalApprovalRow[] = [];
  let initialHistoricalTruncated = false;
  let initialHistoricalError = false;
  // UT7-B-fixup-2 #1 — the main ledger read and the historical-approvals read are resolved in
  // PARALLEL (Promise.allSettled, not Promise.all) but their failures are handled completely
  // independently: historical-approvals is an explicitly SECONDARY, best-effort diagnostic source
  // (see customer-hours-history.ts's header comment), and a failure there must never take down the
  // main "Табель" page. getTimeLedger's own result/error handling is exactly what it was before this
  // fixup — only now it no longer shares a single try/catch (and therefore a single failure mode)
  // with the historical read.
  const [ledgerOutcome, historicalOutcome] = await Promise.allSettled([
    getTimeLedger(uiStateToApiQuery(state), actor),
    approvalEnabled ? loadHistoricalApprovalIssues(uiStateToApiQuery(state), actor) : Promise.resolve({ rows: [] as HistoricalApprovalRow[], truncated: false })
  ]);

  if (ledgerOutcome.status === 'fulfilled') {
    initialData = ledgerOutcome.value;
  } else if (ledgerOutcome.reason instanceof TimeLedgerReadChangedError) {
    initialReadChanged = true;
  } else {
    throw ledgerOutcome.reason;
  }

  if (historicalOutcome.status === 'fulfilled') {
    initialHistoricalRows = historicalOutcome.value.rows;
    initialHistoricalTruncated = historicalOutcome.value.truncated;
  } else {
    initialHistoricalError = true;
  }

  return (
    <main className="setup-page">
      <div className="setup-card worker-card ledger-card">
        <h1>{localeText(locale, 'Timesheets', 'Табель')}</h1>
        {/* UT8-B-fixup-5 — the tab bar for this (table) branch is now rendered INSIDE
            TimesheetsLedgerView itself, from its own reactive currentState, not here from this
            Server Component's one-time `state` — see TimesheetsLedgerView.tsx's own comment at its
            TimesheetsTabs usage for why. Rendering it here too would show two tab bars whenever
            initialData is present. The one gap: while initialReadChanged/!initialData shows the error
            banner below INSTEAD of TimesheetsLedgerView, there is briefly no tab bar at all — an
            existing, narrow edge case (a race while the page was loading), not a regression this
            fixup needs to solve. */}
        {initialReadChanged || !initialData ? (
          <div className="ledger-error-banner" role="alert">
            <p>{localeText(locale, 'The underlying data changed while this page was loading.', 'Данные изменились во время загрузки страницы.')}</p>
            <a className="ledger-reset-link" href={buildSelfHref(searchParams)}>
              {localeText(locale, 'Reload', 'Обновить')}
            </a>
          </div>
        ) : (
          <TimesheetsLedgerView
            locale={locale}
            approvalEnabled={approvalEnabled}
            initialState={state}
            initialData={initialData}
            initialHistoricalRows={initialHistoricalRows}
            initialHistoricalTruncated={initialHistoricalTruncated}
            initialHistoricalError={initialHistoricalError}
            initialSiteOptions={sites}
            initialSelectedCustomerOptions={selectedCustomerOptions}
          />
        )}
      </div>
    </main>
  );
}

function toURLSearchParams(sp: Record<string, string | string[] | undefined>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const one of value) p.append(key, one);
    } else {
      p.append(key, value);
    }
  }
  return p;
}

function buildSelfHref(sp: Record<string, string | string[] | undefined>): string {
  const qs = toURLSearchParams(sp).toString();
  return qs ? `/admin/timesheets?${qs}` : '/admin/timesheets';
}

export type { SiteOption };
