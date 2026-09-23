'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import type { CustomerGroup, TimeLedgerResult, WeeklyCustomerSliceRow } from '@/lib/reporting/time-ledger';
import type { HistoricalApprovalRow } from '@/lib/reporting/customer-hours-history';
import type { SiteOption } from '@/lib/attendance-overview-lookups';
import type { CustomerWorkAreaOption } from '@/lib/reporting/customer-workarea-picker';
import { parseTimeLedgerUiState, uiStateToHref, uiStateToApiUrl, uiStateToHistoricalApiUrl, nextUiState, MAX_PAGE_SIZE, type TimeLedgerUiState } from '@/lib/reporting/time-ledger-ui-query';
import { historicalLoadErrorLabel, historicalRetryLabel, historicalTruncatedLabel } from '@/lib/reporting/ledger-ui-text';
import { TimesheetsTabs } from './TimesheetsTabs';
import { LedgerTopBar } from './LedgerTopBar';
import { LedgerFilterBar } from './LedgerFilterBar';
import { LedgerSummaryStrip } from './LedgerSummaryStrip';
import { CustomerGroupSection, rowLogicalKey, customerKeyOf } from './CustomerGroupSection';
import { NotSubmittedSection } from './NotSubmittedSection';
import { SourceErrorSection } from './SourceErrorSection';
import { LedgerPagination } from './LedgerPagination';
import { MassApproveBar, type MassSelectedItem } from './MassApproveBar';

// UT6-B — mirrors lib/reporting/weekly-approval.ts's MAX_MASS_SELECTION_ITEMS (a server-only module
// that imports Prisma and cannot be imported into a 'use client' component). A single shared integer
// constant, not a formula — the server is the actual authority (400 SELECTION_TOO_LARGE); this is
// only a pre-emptive client-side check so "confirm all matching" never even offers to submit a
// selection the server would reject.
const MAX_MASS_SELECTION_ITEMS = 200;

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
  initialHistoricalRows,
  initialHistoricalTruncated,
  initialHistoricalError,
  initialSiteOptions,
  initialSelectedCustomerOptions
}: {
  locale: AppLocale;
  initialState: TimeLedgerUiState;
  initialData: TimeLedgerResult;
  initialHistoricalRows: HistoricalApprovalRow[];
  initialHistoricalTruncated: boolean;
  initialHistoricalError: boolean;
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
  // UT7-B-fixup #2 / UT7-B-fixup-2 — a separate, bounded fetch alongside the main ledger one (never
  // embedded in its pagination — see customer-hours-history.ts). A failure here never blocks the main
  // ledger view (historicalError just shows a small, non-blocking warning with its own retry — the
  // main rows/filters/approve flow keep working regardless). Seeded from initialHistoricalRows/
  // initialHistoricalTruncated/initialHistoricalError (resolved server-side by
  // TimesheetsLedgerPage.tsx via Promise.allSettled, the SAME reason initialData exists) so the very
  // first paint already has them — the fetch effect below only re-runs on a LATER filter/page change,
  // exactly like the main ledger fetch, so relying on client-only empty defaults would leave this
  // permanently empty (or permanently silent about a failure) on a fresh page load.
  const [historicalRows, setHistoricalRows] = useState<HistoricalApprovalRow[]>(initialHistoricalRows);
  const [historicalTruncated, setHistoricalTruncated] = useState<boolean>(initialHistoricalTruncated);
  const [historicalError, setHistoricalError] = useState<boolean>(initialHistoricalError);

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

  // UT9-B-fixup #3 — an EXTERNAL Next.js-router-mediated navigation to this same page (e.g.
  // components/admin/NotificationCenter.tsx's handleView calling router.push() for the
  // TIMESHEET_AWAITING_APPROVAL redirect) previously had no effect at all: React preserves this
  // component's OWN instance/state across that re-render (same component at the same tree
  // position), so its useState(initialData)/currentSearch never re-seed from the new props, and
  // navigate()'s raw window.history.replaceState() means this component never asked Next's router
  // for updates either — the page silently kept showing whatever was already loaded, ignoring the
  // fresh initialData the new render actually carried. useSearchParams() (searchParamsAtMount, read
  // every render — its NAME is legacy, its value is genuinely live) DOES reactively reflect a real
  // router.push()/Link navigation, but never our OWN navigate() (invisible to Next's router by
  // design — see navigate()'s own comment) — so comparing it against a ref of "the last value WE
  // saw FROM THIS HOOK" (never against currentSearch itself, which navigate() also writes to)
  // correctly fires only for a genuine external navigation, never fighting navigate()'s own updates.
  const lastRouterSearchRef = useRef<string>(searchParamsAtMount.toString());
  useEffect(() => {
    const fresh = searchParamsAtMount.toString();
    if (fresh !== lastRouterSearchRef.current) {
      lastRouterSearchRef.current = fresh;
      setCurrentSearch(fresh);
    }
  }, [searchParamsAtMount]);

  // The search string this component has already fetched (or was seeded with via SSR) — used to
  // tell "the URL genuinely changed, fetch" apart from "we just re-rendered for another reason"
  // (point: "SSR initial data без лишнего первого duplicate fetch").
  const lastFetchedSearchRef = useRef<string>(currentSearch);
  const seqRef = useRef(0);

  const parsedCurrent = useMemo(() => parseTimeLedgerUiState(new URLSearchParams(currentSearch), new Date()), [currentSearch]);
  const currentState: TimeLedgerUiState = parsedCurrent.ok ? parsedCurrent.state : initialState;

  // UT6-B — mass-approval selection (UT6-A-R1 §7). Lives here, not inside CustomerGroupSection,
  // specifically so it SURVIVES a customer group's own component unmounting/remounting across a page
  // navigation of the SAME filter (data.customerGroups is replaced wholesale on every fetch). Cleared
  // whenever the FILTER portion of the URL changes (below); page changes alone leave it untouched.
  const [selectedItems, setSelectedItems] = useState<Map<string, MassSelectedItem>>(new Map());
  const selectedCustomerKey = selectedItems.size > 0 ? [...selectedItems.values()][0].customerKey : null;
  const [allMatching, setAllMatching] = useState<{ groupKey: string; busy: boolean; tooMany: { totalItems: number; max: number } | null } | null>(null);
  // UT9-B — 'CUSTOMER' (default, every existing selection path: checkbox, "select visible", "confirm
  // all matching this customer") vs 'WEEK' ("Принять всю неделю" — selectWholeWeek below, the only
  // path that can ever populate the selection with more than one customer at once). Threaded into
  // MassApproveBar so it sends the matching `scope` to the mass preview/commit routes — never
  // guessed there from the selection's own shape.
  const [selectionScope, setSelectionScope] = useState<'CUSTOMER' | 'WEEK'>('CUSTOMER');
  const [wholeWeekBusyKey, setWholeWeekBusyKey] = useState<string | null>(null);
  // UT9-B-fixup #1 — keyed by row (like wholeWeekBusyKey), never a global flag: this worker's/week's
  // own attempt exceeded MAX_MASS_SELECTION_ITEMS, refused rather than silently confirmed partial.
  const [wholeWeekTooMany, setWholeWeekTooMany] = useState<{ rowKey: string; totalItems: number; max: number } | null>(null);
  // UT6-B-fixup #1 — true whenever MassApproveBar has a live preview/attempt open (any phase other
  // than 'idle'), reported via its onActiveChange callback. Selection edits are frozen for as long as
  // a confirmationToken is bound to the current selection, so a changed selection can never be sent
  // against a stale token.
  const [selectionLocked, setSelectionLocked] = useState(false);

  const filterFingerprint = useMemo(() => JSON.stringify({ ...currentState, page: undefined }), [currentState]);
  const lastFilterFingerprintRef = useRef(filterFingerprint);
  useEffect(() => {
    if (lastFilterFingerprintRef.current !== filterFingerprint) {
      lastFilterFingerprintRef.current = filterFingerprint;
      setSelectedItems(new Map());
      setAllMatching(null);
      setSelectionScope('CUSTOMER');
      setWholeWeekTooMany(null);
    }
  }, [filterFingerprint]);

  const toSelectedItem = useCallback(
    (row: WeeklyCustomerSliceRow, group: { siteName: string; workAreaName: string | null }): MassSelectedItem => ({
      itemKey: { timesheetId: row.logicalKey.timesheetId, siteId: row.logicalKey.siteId, workAreaId: row.logicalKey.workAreaId, weekStart: row.logicalKey.weekStart },
      expectedFingerprint: row.currentFingerprint,
      employeeName: row.employeeName,
      weekEnd: row.logicalKey.weekEnd,
      workedMinutes: row.workedMinutes,
      customerKey: customerKeyOf(row.logicalKey.siteId, row.logicalKey.workAreaId),
      siteName: group.siteName,
      workAreaName: group.workAreaName
    }),
    []
  );

  // A single-row toggle only has the group's own CustomerGroup available via a closure per section
  // (see the render below, which curries the group into onToggleSelect) — kept as a factory so
  // CustomerGroupSection/WorkerSliceRow never need to know about MassSelectedItem's shape at all.
  const toggleSelectInGroup = useCallback(
    (row: WeeklyCustomerSliceRow, group: CustomerGroup) => {
      setSelectionScope('CUSTOMER');
      setSelectedItems((prev) => {
        const key = rowLogicalKey(row);
        const next = new Map(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.set(key, toSelectedItem(row, group));
        }
        return next;
      });
    },
    [toSelectedItem]
  );

  const selectVisible = useCallback(
    (group: CustomerGroup) => {
      setSelectionScope('CUSTOMER');
      setSelectedItems((prev) => {
        const next = new Map(prev);
        for (const row of group.rows) next.set(rowLogicalKey(row), toSelectedItem(row, group));
        return next;
      });
    },
    [toSelectedItem]
  );

  const clearSelection = useCallback(() => {
    setSelectedItems(new Map());
    setAllMatching(null);
    setSelectionScope('CUSTOMER');
    setWholeWeekTooMany(null);
  }, []);

  // UT6-A-R1 §7/§10 — "confirm all matching" first resolves the FULL filtered set for this one
  // customer via an explicit server round-trip (pageSize = MAX_PAGE_SIZE, siteId/workAreaId pinned
  // to this group, every other filter kept as-is), then replaces the selection with it — never an
  // implicit server-side "resolve at commit time" scope. If more rows match than
  // MAX_MASS_SELECTION_ITEMS, nothing is selected and the admin is asked to narrow the filter instead
  // of a silent truncation.
  const confirmAllMatching = useCallback(
    async (group: CustomerGroup) => {
      if (selectionLocked) return; // defense in depth — the button is already disabled while locked
      const groupKey = customerKeyOf(group.siteId, group.workAreaId);
      setSelectionScope('CUSTOMER');
      setAllMatching({ groupKey, busy: true, tooMany: null });
      try {
        const state = nextUiState(currentState, { siteId: group.siteId, workAreaId: group.workAreaId, page: 1, pageSize: MAX_PAGE_SIZE });
        const res = await fetch(uiStateToApiUrl(state), { credentials: 'same-origin' });
        if (!res.ok) {
          setAllMatching(null);
          return;
        }
        const body = (await res.json()) as TimeLedgerResult;
        if (body.pagination.totalItems > MAX_MASS_SELECTION_ITEMS) {
          setAllMatching({ groupKey, busy: false, tooMany: { totalItems: body.pagination.totalItems, max: MAX_MASS_SELECTION_ITEMS } });
          return;
        }
        const next = new Map<string, MassSelectedItem>();
        for (const g of body.customerGroups) {
          for (const row of g.rows) next.set(rowLogicalKey(row), toSelectedItem(row, g));
        }
        setSelectedItems(next);
        setAllMatching(null);
      } catch {
        setAllMatching(null);
      }
    },
    [currentState, toSelectedItem, selectionLocked]
  );

  // UT9-B-fixup #1 — "Принять всю неделю": resolves EVERY customer this one worker has hours with
  // for THIS EXACT week, server-side. Deliberately scoped to startDate=weekStart/endDate=weekEnd
  // (this row's own week — never the admin's current, possibly much wider, visible date range) PLUS
  // the exact employeeId — never the wide range this fixup was written to stop trusting: with a
  // wide range and pageSize capped at MAX_MASS_SELECTION_ITEMS, this worker's target week could be
  // pushed past page 1 by unrelated rows from OTHER weeks, silently confirming an INCOMPLETE week.
  // Narrowing the request itself to the one week (and one worker) makes that structurally
  // impossible — the response can only ever contain rows for this worker's this week, regardless of
  // how much data exists elsewhere in the admin's current filter. The resulting selection is fed
  // through the SAME MassApproveBar preview/commit flow, tagged scope='WEEK' so the server's own
  // validateMassSelection relaxes its "one customer" rule to "one timesheet+week" instead.
  const selectWholeWeek = useCallback(
    async (row: WeeklyCustomerSliceRow) => {
      if (selectionLocked) return;
      const busyKey = rowLogicalKey(row);
      setWholeWeekBusyKey(busyKey);
      setWholeWeekTooMany(null);
      try {
        const state = nextUiState(currentState, {
          ...blankFilters(),
          employeeId: row.logicalKey.employeeId,
          allTime: false,
          startDate: row.logicalKey.weekStart,
          endDate: row.logicalKey.weekEnd,
          page: 1,
          pageSize: MAX_PAGE_SIZE
        });
        const res = await fetch(uiStateToApiUrl(state), { credentials: 'same-origin' });
        if (!res.ok) {
          setWholeWeekBusyKey(null);
          return;
        }
        const body = (await res.json()) as TimeLedgerResult;
        // UT9-B-fixup #1 — even scoped to one worker's one week, a pathological fan-out (many
        // customers in one week) could still exceed the cap. Never silently confirm a partial list
        // in that case — refuse and tell the admin, exactly like confirmAllMatching's own tooMany.
        if (body.pagination.totalItems > MAX_MASS_SELECTION_ITEMS) {
          setWholeWeekBusyKey(null);
          setWholeWeekTooMany({ rowKey: busyKey, totalItems: body.pagination.totalItems, max: MAX_MASS_SELECTION_ITEMS });
          return;
        }
        const next = new Map<string, MassSelectedItem>();
        for (const g of body.customerGroups) {
          for (const r of g.rows) {
            // Defensive exact check — the request is already scoped to this employeeId+week, but an
            // employee could in principle have more than one Timesheet touching the same calendar
            // week (adjacent/overlapping periods); never silently pull in a different timesheet's
            // slice just because it shares this employee and week.
            if (r.logicalKey.timesheetId === row.logicalKey.timesheetId && r.logicalKey.weekStart === row.logicalKey.weekStart) {
              next.set(rowLogicalKey(r), toSelectedItem(r, g));
            }
          }
        }
        setSelectionScope('WEEK');
        setSelectedItems(next);
        setWholeWeekBusyKey(null);
      } catch {
        setWholeWeekBusyKey(null);
      }
    },
    [currentState, toSelectedItem, selectionLocked]
  );

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

    // UT7-B-fixup-2 #2 — a new filter/page immediately clears whatever historical rows/truncated/
    // error state belonged to the PREVIOUS filter, so a slow or failing historical fetch can never
    // leave the previous customer/period's rows on screen under a filter they no longer match. The
    // `seq` check below still applies to the actual response, exactly like the main ledger fetch —
    // an in-flight request superseded by a newer filter change is simply ignored when it resolves.
    setHistoricalRows([]);
    setHistoricalTruncated(false);
    setHistoricalError(false);

    fetch(uiStateToHistoricalApiUrl(parsedCurrent.state), { credentials: 'same-origin', signal: controller.signal })
      .then(async (res) => {
        if (seq !== seqRef.current) return; // superseded by a newer filter change — ignore
        if (!res.ok) {
          setHistoricalError(true);
          return;
        }
        const body = await res.json().catch(() => null);
        if (seq !== seqRef.current) return;
        if (!body) {
          setHistoricalError(true);
          return;
        }
        setHistoricalRows(body.rows as HistoricalApprovalRow[]);
        setHistoricalTruncated(!!body.truncated);
      })
      .catch((err: unknown) => {
        if (seq !== seqRef.current) return;
        if (err instanceof DOMException && err.name === 'AbortError') return; // cleanup below, not a real error
        setHistoricalError(true);
      }); // a failure here (or above) only ever sets historicalError — it never surfaces as a
    // page-level error banner and never blocks the main ledger rows/filters/approve flow.

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
    setHistoricalError(false);
    fetch(uiStateToHistoricalApiUrl(currentState), { credentials: 'same-origin' })
      .then(async (res) => {
        if (seq !== seqRef.current) return;
        if (!res.ok) {
          setHistoricalError(true);
          return;
        }
        const body = await res.json().catch(() => null);
        if (seq !== seqRef.current) return;
        if (!body) {
          setHistoricalError(true);
          return;
        }
        setHistoricalRows(body.rows as HistoricalApprovalRow[]);
        setHistoricalTruncated(!!body.truncated);
      })
      .catch(() => {
        if (seq !== seqRef.current) return;
        setHistoricalError(true);
      });
  }, [currentState, currentSearch, router]);

  const errorBanner = error ? renderErrorBanner(error, locale, navigate, retry) : null;
  const keepDataVisible = error ? error.code === 'TIME_LEDGER_READ_CHANGED_DURING_QUERY' || error.code === 'NETWORK_ERROR' || error.code === 'UNKNOWN' : true;

  // UT7-B-fixup #2 — group historical rows by (siteId, workAreaId) so each one renders inside its
  // matching CustomerGroupSection. A key with historical rows but no live CustomerGroup on this page
  // (every one of that customer's approvals became historical) still needs its own minimal section —
  // built from the historical rows' own siteId/siteName/workAreaId/workAreaName, with no mass-approve
  // controls (onToggleSelect omitted), since it represents no live, approvable rows at all.
  const historicalByCustomerKey = useMemo(() => {
    const m = new Map<string, HistoricalApprovalRow[]>();
    for (const row of historicalRows) {
      const key = customerKeyOf(row.siteId, row.workAreaId);
      const list = m.get(key);
      if (list) list.push(row);
      else m.set(key, [row]);
    }
    return m;
  }, [historicalRows]);
  const shownCustomerKeys = new Set(data.customerGroups.map((g) => customerKeyOf(g.siteId, g.workAreaId)));
  const orphanHistoricalGroups = [...historicalByCustomerKey.entries()]
    .filter(([key]) => !shownCustomerKeys.has(key))
    .map(([key, rows]) => ({ key, siteId: rows[0].siteId, siteName: rows[0].siteName, workAreaId: rows[0].workAreaId, workAreaName: rows[0].workAreaName, rows }));

  return (
    <div className="ledger-view">
      {/* UT8-B-fixup-5 — rendered here, from currentState, instead of server-side in
          TimesheetsLedgerPage.tsx: navigate() above updates the URL via raw window.history.replaceState
          (fixup #6, deliberately not router.replace() — see that comment), which never re-runs the
          Server Component that used to render this tab bar with the ORIGINAL page-load state. A
          server-rendered tab link here would silently go stale after any client-side filter change
          (the customer combobox included) — see TimesheetsLedgerPage.tsx's own header comment. The
          Сводка tab still renders its own separate, server-rendered TimesheetsTabs — its navigate()
          uses a real router.replace(), so that instance's state is never stale to begin with. */}
      <TimesheetsTabs locale={locale} state={currentState} />
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
          {historicalError && (
            <div className="ledger-historical-warning" role="alert">
              <p>{historicalLoadErrorLabel(locale)}</p>
              <button type="button" className="ledger-retry-button" onClick={retry}>
                {historicalRetryLabel(locale)}
              </button>
            </div>
          )}
          {!historicalError && historicalTruncated && (
            <div className="ledger-historical-warning" role="status">
              <p>{historicalTruncatedLabel(locale)}</p>
            </div>
          )}
          {data.customerGroups.length === 0 && data.notSubmitted.length === 0 && data.sourceErrors.length === 0 && historicalRows.length === 0 ? (
            <p className="wk-empty" role="status">
              {localeText(locale, 'No results for these filters.', 'Нет результатов по этим фильтрам.')}{' '}
              <button type="button" className="ledger-link-button" onClick={() => navigate({ ...blankFilters(), page: 1 })}>
                {localeText(locale, 'Reset filters', 'Сбросить фильтры')}
              </button>
            </p>
          ) : (
            <>
              {data.customerGroups.map((group) => {
                const groupKey = customerKeyOf(group.siteId, group.workAreaId);
                const groupAllMatching = allMatching?.groupKey === groupKey ? allMatching : null;
                return (
                  <CustomerGroupSection
                    key={groupKey}
                    locale={locale}
                    group={group}
                    onApproved={retry}
                    selectedKeys={new Set(selectedItems.keys())}
                    selectedCustomerKey={selectedCustomerKey}
                    onToggleSelect={(row) => toggleSelectInGroup(row, group)}
                    onSelectVisible={selectVisible}
                    onConfirmAllMatching={confirmAllMatching}
                    allMatchingBusy={groupAllMatching?.busy ?? false}
                    allMatchingTooMany={groupAllMatching?.tooMany ?? null}
                    selectionLocked={selectionLocked}
                    historicalRows={historicalByCustomerKey.get(groupKey)}
                    onSelectWholeWeek={selectWholeWeek}
                    wholeWeekBusyKey={wholeWeekBusyKey}
                    wholeWeekTooMany={wholeWeekTooMany}
                  />
                );
              })}
              {orphanHistoricalGroups.map((g) => (
                <CustomerGroupSection
                  key={g.key}
                  locale={locale}
                  group={{ siteId: g.siteId, siteName: g.siteName, workAreaId: g.workAreaId, workAreaName: g.workAreaName, rows: [] }}
                  onApproved={retry}
                  historicalRows={g.rows}
                />
              ))}
              {data.notSubmitted.length > 0 && <NotSubmittedSection locale={locale} rows={data.notSubmitted} />}
              {data.sourceErrors.length > 0 && <SourceErrorSection locale={locale} rows={data.sourceErrors} />}
              <LedgerPagination locale={locale} pagination={data.pagination} onNavigate={navigate} />
            </>
          )}
        </>
      )}
      <MassApproveBar locale={locale} selectedItems={selectedItems} scope={selectionScope} onClearSelection={clearSelection} onApproved={retry} onActiveChange={setSelectionLocked} />
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
