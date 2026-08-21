'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { WorkerLink } from './WorkerLink';
import { parseWorkerRoute, readAccountBoundSnapshot, type ReadSnapshotOutcome, type PeriodsListPayload, type HistoryListPayload, type PeriodDetailPayload, type HoursListPayload, type DayDetailPayload, type SubmitSummaryPayload, type SnapshotReturnReason } from '@/lib/offline-outbox/read-snapshots';
import type { WorkerReadSnapshotRecord } from '@/lib/offline-outbox/db';
import { workerTimesheetStatusLabel } from '@/lib/worker-timesheet-presentation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { COMMON_STRINGS } from '@/lib/i18n/common';
import { WORKER_STRINGS, dayTypeLabel } from '@/lib/i18n/worker';
import type { AppLocale } from '@/lib/i18n/locale';

// docs/titanor-time/T8_PWA_DESIGN.md §F.6/§F.9 — the shell's read-only renderer, one branch per
// SnapshotRouteKind. Never renders an editable input, a Save/Submit control, or a mutation-
// confirmation message — that's the whole point of this being a SEPARATE component from
// DayEditor/SubmitButton, not a reused one. `pathname` is read once by the caller
// (OfflineShellClient) via a plain window.location.pathname read — never next/navigation's
// usePathname(), to avoid any App Router reconciliation attempt against a URL that doesn't match
// this cached document's own embedded route data.

function formatCapturedAt(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h${m ? ` ${m}m` : ''}`;
}

function ReturnReasonsReadOnly({ reasons }: { reasons: SnapshotReturnReason[] }) {
  const t = COMMON_STRINGS[useAppLocale()];
  if (reasons.length === 0) {
    return null;
  }
  return (
    <div className="wk-return-notice" role="note">
      <h2 className="wk-return-notice-title">{t.returnedForCorrectionTitle}</h2>
      <ul className="wk-return-reason-list">
        {reasons.map((r, i) => (
          <li key={i} className="wk-return-reason-item">
            <span className="wk-return-reason-scope">{r.scopeType === 'SITE' ? (r.siteName ?? t.unknownSite) : r.contextSiteName ? `${t.generalNonSite} (${r.contextSiteName})` : t.generalNonSite}</span>
            <p className="wk-return-reason-text">{r.reason}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UnavailableNotice() {
  const locale = useAppLocale();
  const t = WORKER_STRINGS[locale];
  const common = COMMON_STRINGS[locale];
  return (
    <div className="wk-card wk-snap-card">
      <p role="status" aria-live="polite">
        {t.snapUnavailable}
      </p>
      <WorkerLink href="/worker" className="wk-back-link">
        {common.backToClock}
      </WorkerLink>
    </div>
  );
}

function InstallOfflineNotice() {
  const locale = useAppLocale();
  const t = WORKER_STRINGS[locale];
  const common = COMMON_STRINGS[locale];
  return (
    <div className="wk-card wk-snap-card">
      <p role="status" aria-live="polite">{t.snapInstallOffline}</p>
      <WorkerLink href="/worker" className="wk-back-link">
        {common.backToClock}
      </WorkerLink>
    </div>
  );
}

function ShellFrame({ capturedAt, children }: { capturedAt: string; children: ReactNode }) {
  const locale = useAppLocale();
  const t = WORKER_STRINGS[locale];
  const common = COMMON_STRINGS[locale];
  return (
    <div className="wk-card wk-snap-card">
      <div className="wk-snap-header" role="status" aria-live="polite">
        <span className="wk-snap-badge">{t.snapOfflineReadOnly}</span>
        <span className="wk-snap-updated">{t.snapLastUpdated(formatCapturedAt(capturedAt))}</span>
      </div>
      {children}
      <div className="wk-snap-actions">
        <button type="button" className="wk-clock-secondary-button" onClick={() => window.location.reload()}>
          {t.snapReloadWhenOnline}
        </button>
        <WorkerLink href="/worker" className="wk-back-link">
          {common.backToClock}
        </WorkerLink>
      </div>
    </div>
  );
}

function renderPayload(record: WorkerReadSnapshotRecord, locale: AppLocale) {
  const t = WORKER_STRINGS[locale];
  switch (record.routeKind) {
    case 'periods-list': {
      const payload = record.payload as PeriodsListPayload;
      return (
        <>
          <h1>{t.yourPeriods}</h1>
          {payload.periods.length === 0 ? (
            <p className="wk-empty">{t.notAssignedToSiteYet}</p>
          ) : (
            <ul className="wk-period-list">
              {payload.periods.map((p) => (
                <li key={p.id}>
                  <WorkerLink href={`/worker/periods/${p.id}`} className="wk-period-item">
                    <span className="wk-period-dates">
                      {p.startDate} – {p.endDate}
                    </span>
                    <span className={`wk-status-badge wk-status-${p.timesheetStatus.toLowerCase()}`}>{workerTimesheetStatusLabel(p.timesheetStatus, p.totalMinutes, locale)}</span>
                  </WorkerLink>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    }
    case 'history-list': {
      const payload = record.payload as HistoryListPayload;
      return (
        <>
          <h1>{t.historyTitle}</h1>
          {payload.timesheets.length === 0 ? (
            <p className="wk-empty">{t.noPeriodsYet}</p>
          ) : (
            <ul className="wk-period-list">
              {payload.timesheets.map((t) => (
                <li key={t.timesheetId}>
                  <WorkerLink href={`/worker/periods/${t.id}`} className="wk-period-item">
                    <span className="wk-period-dates">
                      {t.startDate} – {t.endDate}
                    </span>
                    <span className={`wk-status-badge wk-status-${t.timesheetStatus.toLowerCase()}`}>{workerTimesheetStatusLabel(t.timesheetStatus, t.totalMinutes, locale)}</span>
                  </WorkerLink>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    }
    case 'period-detail': {
      const payload = record.payload as PeriodDetailPayload;
      return (
        <>
          <h1>
            {payload.startDate} – {payload.endDate}
          </h1>
          <span className={`wk-status-badge wk-status-${payload.timesheetStatus.toLowerCase()}`}>{workerTimesheetStatusLabel(payload.timesheetStatus, payload.totalMinutes, locale)}</span>
          <ReturnReasonsReadOnly reasons={payload.returnReasons} />
          <h2 className="wk-section-title">{t.yourAssignments}</h2>
          {payload.assignments.length === 0 ? (
            <p className="wk-empty">{t.notAssignedToSiteYet}</p>
          ) : (
            <ul className="wk-assignment-list">
              {payload.assignments.map((a) => (
                <li key={a.id} className="wk-assignment-item">
                  <span className="wk-assignment-site">
                    {a.siteName}
                    {a.isPrimary ? t.primarySuffix : ''}
                  </span>
                  {a.workAreaName && <span className="wk-assignment-detail">{a.workAreaName}</span>}
                </li>
              ))}
            </ul>
          )}
          <WorkerLink href={`/worker/periods/${payload.periodId}/hours`} className="wk-back-link">
            {t.viewHours}
          </WorkerLink>
        </>
      );
    }
    case 'hours-list': {
      const payload = record.payload as HoursListPayload;
      return (
        <>
          <h1>{t.hours}</h1>
          <ReturnReasonsReadOnly reasons={payload.returnReasons} />
          <p className="wk-readonly-note">{t.snapReadOnlyOffline}</p>
          {payload.days.length === 0 ? (
            <p className="wk-empty">{t.noDaysInPeriodYet}</p>
          ) : (
            <ul className="wk-day-list">
              {payload.days.map((day) => (
                <li key={day.date}>
                  <WorkerLink href={`/worker/periods/${payload.periodId}/hours/${day.date}`} className="wk-day-item">
                    <span className="wk-day-date">{day.date}</span>
                    <span className="wk-day-summary">
                      {day.dayType !== 'WORK'
                        ? dayTypeLabel(day.dayType, locale)
                        : day.confirmedZero
                          ? t.confirmedZeroShort
                          : day.siteNames.length === 0
                            ? '—'
                            : `${formatMinutes(day.totalMinutes)} · ${day.siteNames.join(', ')}`}
                    </span>
                  </WorkerLink>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    }
    case 'day-detail': {
      const payload = record.payload as DayDetailPayload;
      return (
        <>
          <h1>{payload.date}</h1>
          <ReturnReasonsReadOnly reasons={payload.returnReasons} />
          {payload.dayType !== 'WORK' ? (
            <p className="wk-empty">{dayTypeLabel(payload.dayType, locale)}</p>
          ) : payload.confirmedZero ? (
            <p className="wk-empty">{t.snapConfirmedZeroHours}</p>
          ) : payload.segments.length === 0 ? (
            <p className="wk-empty">{t.snapNoHoursLoggedDay}</p>
          ) : (
            <ul className="wk-period-list">
              {payload.segments.map((s, i) => (
                <li key={i} className="wk-period-item">
                  <span className="wk-period-dates">
                    {new Date(s.startAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – {new Date(s.endAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="wk-assignment-detail">
                    {s.siteName}
                    {s.workAreaName ? ` · ${s.workAreaName}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      );
    }
    case 'submit-summary': {
      const payload = record.payload as SubmitSummaryPayload;
      return (
        <>
          <h1>{t.submitTimesheetTitle}</h1>
          <ReturnReasonsReadOnly reasons={payload.returnReasons} />
          <p>
            {payload.startDate} – {payload.endDate}
          </p>
          <p className="wk-readonly-note">
            {t.daysFilledIn(payload.workedDaysCount, payload.totalDaysCount, formatMinutes(payload.totalMinutes))}
          </p>
          <p className="wk-empty">{t.snapConnectToSubmit}</p>
        </>
      );
    }
  }
}

export function WorkerSnapshotView({ pathname }: { pathname: string }) {
  const locale = useAppLocale();
  const common = COMMON_STRINGS[locale];
  const [outcome, setOutcome] = useState<ReadSnapshotOutcome | 'loading' | 'no-route'>('loading');

  useEffect(() => {
    let cancelled = false;
    const route = parseWorkerRoute(pathname);
    if (!route) {
      setOutcome('no-route');
      return;
    }
    readAccountBoundSnapshot(route)
      .then((result) => {
        if (!cancelled) {
          setOutcome(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOutcome({ kind: 'unavailable', reason: 'NOT_CAPTURED' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  if (pathname === '/worker/install') {
    return <InstallOfflineNotice />;
  }
  if (outcome === 'loading') {
    return (
      <div className="wk-card">
        <p role="status" aria-live="polite">
          {common.loading}
        </p>
      </div>
    );
  }
  if (outcome === 'no-route' || outcome.kind === 'unavailable') {
    return <UnavailableNotice />;
  }

  return <ShellFrame capturedAt={outcome.record.capturedAt}>{renderPayload(outcome.record, locale)}</ShellFrame>;
}
