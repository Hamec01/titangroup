import { getTimeLedger, TimeLedgerReadChangedError, type LedgerActor, type TimeLedgerResult } from '@/lib/reporting/time-ledger';
import { listSiteOptionsForAdmin, type SiteOption } from '@/lib/attendance-overview-lookups';
import { resolveCustomerWorkAreaOptions, type CustomerWorkAreaOption } from '@/lib/reporting/customer-workarea-picker';
import { parseTimeLedgerUiState, uiStateToApiQuery, type TimeLedgerUiState } from '@/lib/reporting/time-ledger-ui-query';
import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import { TimesheetsTabs } from './TimesheetsTabs';
import { SummaryTabPlaceholder } from './SummaryTabPlaceholder';
import { TimesheetsLedgerView } from './TimesheetsLedgerView';

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

  const state = parsed.state;

  if (state.view === 'summary') {
    return (
      <main className="setup-page">
        <div className="setup-card worker-card ledger-card">
          <h1>{localeText(locale, 'Timesheets', 'Табель')}</h1>
          <TimesheetsTabs locale={locale} state={state} />
          <SummaryTabPlaceholder locale={locale} />
        </div>
      </main>
    );
  }

  const [sites, selectedCustomerOptions] = await Promise.all([
    listSiteOptionsForAdmin(),
    state.workAreaId && state.workAreaId !== 'none' ? resolveCustomerWorkAreaOptions([state.workAreaId]) : Promise.resolve<CustomerWorkAreaOption[]>([])
  ]);

  let initialData: TimeLedgerResult | null = null;
  let initialReadChanged = false;
  try {
    initialData = await getTimeLedger(uiStateToApiQuery(state), actor);
  } catch (err) {
    if (err instanceof TimeLedgerReadChangedError) {
      initialReadChanged = true;
    } else {
      throw err;
    }
  }

  return (
    <main className="setup-page">
      <div className="setup-card worker-card ledger-card">
        <h1>{localeText(locale, 'Timesheets', 'Табель')}</h1>
        <TimesheetsTabs locale={locale} state={state} />
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
            initialState={state}
            initialData={initialData}
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
