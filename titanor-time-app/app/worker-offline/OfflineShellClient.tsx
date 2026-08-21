'use client';

import { useEffect, useState } from 'react';
import { getDeviceState, getLocalClockState } from '@/lib/offline-outbox/db';
import type { ClockStateWire } from '@/lib/offline-outbox/sync-runner';
import { WorkerClockPanel, type ClockPanelAssignment } from '../worker/WorkerClockPanel';
import { WorkerSnapshotView } from '@/components/worker-pwa/WorkerSnapshotView';
import { AppLocaleProvider, useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { readClientLocale } from '@/lib/i18n/client';
import { DEFAULT_APP_LOCALE, type AppLocale } from '@/lib/i18n/locale';
import { COMMON_STRINGS } from '@/lib/i18n/common';
import { WORKER_STRINGS } from '@/lib/i18n/worker';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10C.1" §C — the offline shell's
// clock behavior (this component's original job) is completely unchanged: turning IndexedDB reads
// into the exact same props WorkerClockPanel already accepts from the server on the online page. No
// enqueue/sync/projection/bootstrap logic is reimplemented here.
//
// docs/titanor-time/T8_PWA_DESIGN.md §F.10 (T8.8) — this same cached document is now ALSO served by
// the service worker as the fallback for the other known /worker/** UI routes, not just /worker
// itself. `pathname` is read once via a plain `window.location.pathname` (NEVER
// next/navigation's usePathname() — that hooks into the App Router's own navigation/reconciliation
// machinery, which this deliberately avoids: the browser preserves the ORIGINAL requested URL for a
// SW-served navigation, but this document's own embedded RSC data is for /worker-offline itself: a
// plain DOM read has no side effects and cannot trigger an unwanted client-side re-fetch attempt for
// the mismatched route). pathname === '/worker' or '/worker-offline' (or unrecognized) keeps
// rendering the real clock, exactly as before; a known OTHER route renders the read-only snapshot
// view instead.

function todayLabelNow(locale: AppLocale): string {
  return new Intl.DateTimeFormat(locale === 'RU' ? 'ru-RU' : 'en-GB', { timeZone: 'Europe/Helsinki', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
}

type ReadState = { kind: 'loading' } | { kind: 'not-bootstrapped' } | { kind: 'ready'; initialClockState: ClockStateWire; assignments: ClockPanelAssignment[] };

const CLOCK_PATHS = new Set(['/worker', '/worker-offline']);

function OfflineShellContent() {
  const locale = useAppLocale();
  const common = COMMON_STRINGS[locale];
  const t = WORKER_STRINGS[locale];
  const [state, setState] = useState<ReadState>({ kind: 'loading' });
  // Resolved inside the effect below (not read synchronously in the render body), same
  // hydration-safety reasoning as `state` itself — this is a single effect, not two racing ones,
  // so `pathname` and the decision of "is this a clock route" are always resolved together.
  const [pathname, setPathname] = useState<string | null>(null);

  useEffect(() => {
    const currentPath = window.location.pathname;
    setPathname(currentPath);
    if (!CLOCK_PATHS.has(currentPath)) {
      // A known non-clock route (or /worker/install) — WorkerSnapshotView (rendered below once
      // `pathname` is set) handles its own IndexedDB read; this effect has nothing further to do.
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const deviceState = await getDeviceState();
        if (cancelled) return;
        if (!deviceState || !deviceState.bootstrapped) {
          setState({ kind: 'not-bootstrapped' });
          return;
        }

        const localClockState = await getLocalClockState();
        const clockState: ClockStateWire =
          localClockState && localClockState.state === 'CLOCKED_IN' && localClockState.siteId
            ? {
                serverNow: new Date().toISOString(),
                state: 'CLOCKED_IN',
                openShift: {
                  openedAt: localClockState.openedAt ?? new Date().toISOString(),
                  siteId: localClockState.siteId,
                  siteName: localClockState.siteName ?? '',
                  workAreaId: localClockState.workAreaId,
                  workAreaName: localClockState.workAreaName,
                  sourceAssignmentId: null,
                  openedByClockEventId: '' // never read by WorkerClockPanel/projectClockState — a real event id only ever matters server-side.
                }
              }
            : { serverNow: new Date().toISOString(), state: 'CLOCKED_OUT', openShift: null };

        const assignments: ClockPanelAssignment[] = (deviceState.contextAssignments ?? []).map((a) => ({
          id: a.id,
          siteId: a.siteId,
          siteName: a.siteName,
          workAreaId: a.workAreaId,
          workAreaName: a.workAreaName,
          isPrimary: a.isPrimary
        }));

        if (!cancelled) {
          setState({ kind: 'ready', initialClockState: clockState, assignments });
        }
      } catch {
        if (!cancelled) {
          setState({ kind: 'not-bootstrapped' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (pathname === null) {
    return (
      <div className="wk-card">
        <p role="status" aria-live="polite">
          {common.loading}
        </p>
      </div>
    );
  }

  if (!CLOCK_PATHS.has(pathname)) {
    return <WorkerSnapshotView pathname={pathname} />;
  }

  if (state.kind === 'loading') {
    return (
      <div className="wk-card">
        <p role="status" aria-live="polite">
          {common.loading}
        </p>
      </div>
    );
  }

  if (state.kind === 'not-bootstrapped') {
    return (
      <div className="wk-card">
        <p role="status" aria-live="polite">
          {t.offlineShellNotReady}
        </p>
      </div>
    );
  }

  return (
    <WorkerClockPanel
      initialClockState={state.initialClockState}
      assignments={state.assignments}
      workerName={null}
      todayLabel={todayLabelNow(locale)}
      recentActivity={null}
      periodsHref={null}
      historyHref={null}
      installHref={null}
    />
  );
}

export function OfflineShellClient() {
  const [locale, setLocale] = useState<AppLocale>(DEFAULT_APP_LOCALE);
  useEffect(() => setLocale(readClientLocale()), []);
  return (
    <AppLocaleProvider locale={locale}>
      <OfflineShellContent />
    </AppLocaleProvider>
  );
}
