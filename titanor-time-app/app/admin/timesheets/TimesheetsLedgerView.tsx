'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import type { TimeLedgerResult } from '@/lib/reporting/time-ledger';
import type { SiteOption } from '@/lib/attendance-overview-lookups';
import type { CustomerWorkAreaOption } from '@/lib/reporting/customer-workarea-picker';
import { parseTimeLedgerUiState, uiStateToHref, uiStateToApiUrl, nextUiState, type TimeLedgerUiState } from '@/lib/reporting/time-ledger-ui-query';
import { LedgerTopBar } from './LedgerTopBar';
import { LedgerFilterBar } from './LedgerFilterBar';
import { LedgerSummaryStrip } from './LedgerSummaryStrip';
import { CustomerGroupSection } from './CustomerGroupSection';
import { NotSubmittedSection } from './NotSubmittedSection';
import { SourceErrorSection } from './SourceErrorSection';
import { LedgerPagination } from './LedgerPagination';

interface FetchErrorState {
  code: string;
  message: string;
}

// UT4-B — the client-side orchestrator: owns the fetch/URL/race-control loop (point 8 of the
// fixup). Design: the URL is the single trigger for re-fetching — every filter/range/page control
// below just calls `navigate(changes)`, a single effect watches the URL and fetches whenever it
// actually changes, and Back/Forward is handled by the same code path via a popstate listener.
//
// UT4-B-fixup #6 — `navigate()` deliberately updates the URL via raw `window.history.replaceState`
// instead of next/navigation's `router.replace()`. In the App Router, a searchParams change is
// NOT part of the route's static cache key, so `router.replace()` on this page makes Next.js
// re-render TimesheetsLedgerPage.tsx server-side (a second, wasted getTimeLedger() call) on EVERY
// filter click, running alongside this component's own client fetch below — two ledger
// computations per filter change instead of one. Raw History API updates the address bar without
// asking Next's router to do anything, so only the one client fetch below ever runs. The tradeoff:
// next/navigation's useSearchParams() only updates in response to the router's OWN navigations, not
// a raw history call, so this component tracks "the current search string" itself (currentSearch
// state, written by navigate() and by a popstate listener for genuine Back/Forward) instead of
// reading useSearchParams() reactively. useSearchParams() is still read ONCE, for the initial
// render/hydration value only, since that is guaranteed consistent between server and client.
export function TimesheetsLedgerView({
  locale,
  initialState,
  initialData,
  initialSiteOptions,
  initialSelectedCustomerOptions
}: {
  locale: AppLocale;
  initialState: TimeLedgerUiState;
  initialData: TimeLedgerResult;
  initialSiteOptions: SiteOption[];
  initialSelectedCustomerOptions: CustomerWorkAreaOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  // Read once for the initial render/hydration value only (guaranteed identical between server and
  // client for the first paint) — NOT relied on reactively afterward, see the header comment above.
  const searchParamsAtMount = useSearchParams();

  const [data, setData] = useState<TimeLedgerResult>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FetchErrorState | null>(null);

  // This component's own tracked "current URL search string" — written by navigate() (a raw History
  // API call) and by the popstate listener below (genuine Back/Forward). Seeded from the REAL
  // browser URL at mount, not from a re-serialization of initialState, which may differ from the raw
  // URL when the page resolved defaults (e.g. a bare URL with no explicit range) without rewriting
  // the address bar.
  const [currentSearch, setCurrentSearch] = useState<string>(() => searchParamsAtMount.toString());

  useEffect(() => {
    function onPopState() {
      setCurrentSearch(window.location.search.replace(/^\?/, ''));
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // The search string this component has already fetched (or was seeded with via SSR) — used to
  // tell "the URL genuinely changed, fetch" apart from "we just re-rendered for another reason"
  // (point: "SSR initial data без лишнего первого duplicate fetch").
  const lastFetchedSearchRef = useRef<string>(currentSearch);
  const seqRef = useRef(0);

  const parsedCurrent = useMemo(() => parseTimeLedgerUiState(new URLSearchParams(currentSearch), new Date()), [currentSearch]);
  const currentState: TimeLedgerUiState = parsedCurrent.ok ? parsedCurrent.state : initialState;

  useEffect(() => {
    if (currentSearch === lastFetchedSearchRef.current) return;
    lastFetchedSearchRef.current = currentSearch;

    if (!parsedCurrent.ok) {
      setError({ code: 'INVALID_FILTERS', message: '' });
      setLoading(false);
      return;
    }

    const seq = ++seqRef.current;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetch(uiStateToApiUrl(parsedCurrent.state), { credentials: 'same-origin', signal: controller.signal })
      .then(async (res) => {
        if (seq !== seqRef.current) return; // superseded by a newer request — ignore
        const body = await res.json().catch(() => null);
        if (seq !== seqRef.current) return;
        if (!res.ok) {
          const code: string = body?.error?.code ?? 'UNKNOWN';
          if (code === 'NOT_AUTHENTICATED') {
            router.push('/login');
            return;
          }
          setError({ code, message: body?.error?.message ?? '' });
          setLoading(false);
          return;
        }
        setData(body as TimeLedgerResult);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (seq !== seqRef.current) return;
        if (err instanceof DOMException && err.name === 'AbortError') return; // cleanup below, not a real error
        setError({ code: 'NETWORK_ERROR', message: '' });
        setLoading(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSearch]);

  const navigate = useCallback(
    (changes: Partial<TimeLedgerUiState>) => {
      const next = nextUiState(currentState, changes);
      const href = uiStateToHref(pathname, next);
      // Raw History API, deliberately NOT router.replace() — see the header comment (fixup #6).
      window.history.replaceState(null, '', href);
      const qIndex = href.indexOf('?');
      setCurrentSearch(qIndex === -1 ? '' : href.slice(qIndex + 1));
    },
    [currentState, pathname]
  );

  const retry = useCallback(() => {
    // Re-fetch the SAME state without changing the URL (nothing to navigate to — force a refetch
    // by clearing the "already fetched" marker).
    lastFetchedSearchRef.current = '\u0000'; // guaranteed not to equal any real search string
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    fetch(uiStateToApiUrl(currentState), { credentials: 'same-origin' })
      .then(async (res) => {
        if (seq !== seqRef.current) return;
        const body = await res.json().catch(() => null);
        if (seq !== seqRef.current) return;
        if (!res.ok) {
          const code: string = body?.error?.code ?? 'UNKNOWN';
          if (code === 'NOT_AUTHENTICATED') {
            router.push('/login');
            return;
          }
          setError({ code, message: body?.error?.message ?? '' });
          setLoading(false);
          return;
        }
        lastFetchedSearchRef.current = currentSearch;
        setData(body as TimeLedgerResult);
        setLoading(false);
      })
      .catch(() => {
        if (seq !== seqRef.current) return;
        setError({ code: 'NETWORK_ERROR', message: '' });
        setLoading(false);
      });
  }, [currentState, currentSearch, router]);

  const errorBanner = error ? renderErrorBanner(error, locale, navigate, retry) : null;
  const keepDataVisible = error ? error.code === 'TIME_LEDGER_READ_CHANGED_DURING_QUERY' || error.code === 'NETWORK_ERROR' || error.code === 'UNKNOWN' : true;

  return (
    <div className="ledger-view">
      <LedgerTopBar locale={locale} state={currentState} onNavigate={navigate} />
      <LedgerFilterBar
        locale={locale}
        state={currentState}
        onNavigate={navigate}
        siteOptions={initialSiteOptions}
        initialSelectedCustomerOptions={initialSelectedCustomerOptions}
      />
      {errorBanner}
      {loading && <p className="ledger-loading" role="status" aria-live="polite">{localeText(locale, 'Loading…', 'Загрузка…')}</p>}
      {(!error || keepDataVisible) && (
        <>
          <LedgerSummaryStrip locale={locale} summary={data.summary} state={currentState} onNavigate={navigate} />
          {data.customerGroups.length === 0 && data.notSubmitted.length === 0 && data.sourceErrors.length === 0 ? (
            <p className="wk-empty" role="status">
              {localeText(locale, 'No results for these filters.', 'Нет результатов по этим фильтрам.')}{' '}
              <button type="button" className="ledger-link-button" onClick={() => navigate({ ...blankFilters(), page: 1 })}>
                {localeText(locale, 'Reset filters', 'Сбросить фильтры')}
              </button>
            </p>
          ) : (
            <>
              {data.customerGroups.map((group) => (
                <CustomerGroupSection key={`${group.siteId}:${group.workAreaId ?? ''}`} locale={locale} group={group} />
              ))}
              {data.notSubmitted.length > 0 && <NotSubmittedSection locale={locale} rows={data.notSubmitted} />}
              {data.sourceErrors.length > 0 && <SourceErrorSection locale={locale} rows={data.sourceErrors} />}
              <LedgerPagination locale={locale} pagination={data.pagination} onNavigate={navigate} />
            </>
          )}
        </>
      )}
    </div>
  );
}

function blankFilters(): Partial<TimeLedgerUiState> {
  return { employeeSearch: null, siteId: null, workAreaId: null, status: 'all', onlyIssues: false, onlyChangedAfterApproval: false, submissionState: 'all', submissionSource: 'all' };
}

function renderErrorBanner(error: FetchErrorState, locale: AppLocale, navigate: (c: Partial<TimeLedgerUiState>) => void, retry: () => void) {
  switch (error.code) {
    case 'TIME_LEDGER_READ_CHANGED_DURING_QUERY':
      return (
        <div className="ledger-error-banner ledger-error-banner-retry" role="alert">
          <p>{localeText(locale, 'The data changed while this page was loading. The list below may be out of date.', 'Данные изменились во время загрузки. Список ниже может быть устаревшим.')}</p>
          <button type="button" className="ledger-retry-button" onClick={retry}>
            {localeText(locale, 'Reload', 'Обновить')}
          </button>
        </div>
      );
    case 'FORBIDDEN':
      return (
        <div className="ledger-error-banner" role="alert">
          <p>{localeText(locale, 'Missing required permission.', 'Недостаточно прав.')}</p>
        </div>
      );
    case 'VALIDATION_ERROR':
    case 'RANGE_TOO_LARGE':
    case 'CONFLICTING_RANGE_PARAMETERS':
    case 'CONFLICTING_FILTER_PARAMETERS':
    case 'INVALID_FILTERS':
      return (
        <div className="ledger-error-banner" role="alert">
          <p>{localeText(locale, 'Invalid filter parameters.', 'Некорректные параметры фильтра.')}</p>
          <button type="button" className="ledger-retry-button" onClick={() => navigate({ ...blankFilters(), page: 1 })}>
            {localeText(locale, 'Reset filters', 'Сбросить фильтры')}
          </button>
        </div>
      );
    default:
      return (
        <div className="ledger-error-banner ledger-error-banner-retry" role="alert">
          <p>{localeText(locale, 'Could not load data.', 'Не удалось загрузить данные.')}</p>
          <button type="button" className="ledger-retry-button" onClick={retry}>
            {localeText(locale, 'Try again', 'Повторить')}
          </button>
        </div>
      );
  }
}
