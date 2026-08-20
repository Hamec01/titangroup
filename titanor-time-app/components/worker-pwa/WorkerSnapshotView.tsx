'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { WorkerLink } from './WorkerLink';
import { parseWorkerRoute, readAccountBoundSnapshot, type ReadSnapshotOutcome, type PeriodsListPayload, type HistoryListPayload, type PeriodDetailPayload, type HoursListPayload, type DayDetailPayload, type SubmitSummaryPayload, type SnapshotReturnReason } from '@/lib/offline-outbox/read-snapshots';
import type { WorkerReadSnapshotRecord } from '@/lib/offline-outbox/db';

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
  if (reasons.length === 0) {
    return null;
  }
  return (
    <div className="wk-return-notice" role="note">
      <h2 className="wk-return-notice-title">Returned for correction</h2>
      <ul className="wk-return-reason-list">
        {reasons.map((r, i) => (
          <li key={i} className="wk-return-reason-item">
            <span className="wk-return-reason-scope">{r.scopeType === 'SITE' ? (r.siteName ?? 'Unknown site') : r.contextSiteName ? `General / non-site (${r.contextSiteName})` : 'General / non-site'}</span>
            <p className="wk-return-reason-text">{r.reason}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UnavailableNotice() {
  return (
    <div className="wk-card wk-snap-card">
      <p role="status" aria-live="polite">
        This page has not been saved for offline viewing yet. Connect and open it once.
      </p>
      <WorkerLink href="/worker" className="wk-back-link">
        ← Back to clock
      </WorkerLink>
    </div>
  );
}

function InstallOfflineNotice() {
  return (
    <div className="wk-card wk-snap-card">
      <p role="status" aria-live="polite">You&apos;re offline. Installation guidance needs a connection to check your browser&apos;s install status.</p>
      <WorkerLink href="/worker" className="wk-back-link">
        ← Back to clock
      </WorkerLink>
    </div>
  );
}

function ShellFrame({ capturedAt, children }: { capturedAt: string; children: ReactNode }) {
  return (
    <div className="wk-card wk-snap-card">
      <div className="wk-snap-header" role="status" aria-live="polite">
        <span className="wk-snap-badge">Offline — read-only</span>
        <span className="wk-snap-updated">Last updated: {formatCapturedAt(capturedAt)}</span>
      </div>
      {children}
      <div className="wk-snap-actions">
        <button type="button" className="wk-clock-secondary-button" onClick={() => window.location.reload()}>
          Reload when online
        </button>
        <WorkerLink href="/worker" className="wk-back-link">
          ← Back to clock
        </WorkerLink>
      </div>
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Not started',
  RETURNED: 'Returned — needs your attention',
  SUBMITTED: 'Submitted — awaiting review',
  FOREMAN_APPROVED: 'Approved by foreman',
  FINAL_APPROVED: 'Finalized'
};

function renderPayload(record: WorkerReadSnapshotRecord) {
  switch (record.routeKind) {
    case 'periods-list': {
      const payload = record.payload as PeriodsListPayload;
      return (
        <>
          <h1>Your periods</h1>
          {payload.periods.length === 0 ? (
            <p className="wk-empty">You haven&apos;t been assigned to a site yet.</p>
          ) : (
            <ul className="wk-period-list">
              {payload.periods.map((p) => (
                <li key={p.id}>
                  <WorkerLink href={`/worker/periods/${p.id}`} className="wk-period-item">
                    <span className="wk-period-dates">
                      {p.startDate} – {p.endDate}
                    </span>
                    <span className={`wk-status-badge wk-status-${p.timesheetStatus.toLowerCase()}`}>{STATUS_LABELS[p.timesheetStatus] ?? p.timesheetStatus}</span>
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
          <h1>History</h1>
          {payload.timesheets.length === 0 ? (
            <p className="wk-empty">No periods yet.</p>
          ) : (
            <ul className="wk-period-list">
              {payload.timesheets.map((t) => (
                <li key={t.timesheetId}>
                  <WorkerLink href={`/worker/periods/${t.id}`} className="wk-period-item">
                    <span className="wk-period-dates">
                      {t.startDate} – {t.endDate}
                    </span>
                    <span className={`wk-status-badge wk-status-${t.timesheetStatus.toLowerCase()}`}>{STATUS_LABELS[t.timesheetStatus] ?? t.timesheetStatus}</span>
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
          <span className={`wk-status-badge wk-status-${payload.timesheetStatus.toLowerCase()}`}>{STATUS_LABELS[payload.timesheetStatus] ?? payload.timesheetStatus}</span>
          <ReturnReasonsReadOnly reasons={payload.returnReasons} />
          <h2 className="wk-section-title">Your assignments</h2>
          {payload.assignments.length === 0 ? (
            <p className="wk-empty">You haven&apos;t been assigned to a site yet.</p>
          ) : (
            <ul className="wk-assignment-list">
              {payload.assignments.map((a) => (
                <li key={a.id} className="wk-assignment-item">
                  <span className="wk-assignment-site">
                    {a.siteName}
                    {a.isPrimary ? ' (primary)' : ''}
                  </span>
                  {a.workAreaName && <span className="wk-assignment-detail">{a.workAreaName}</span>}
                </li>
              ))}
            </ul>
          )}
          <WorkerLink href={`/worker/periods/${payload.periodId}/hours`} className="wk-back-link">
            View hours
          </WorkerLink>
        </>
      );
    }
    case 'hours-list': {
      const payload = record.payload as HoursListPayload;
      return (
        <>
          <h1>Hours</h1>
          <ReturnReasonsReadOnly reasons={payload.returnReasons} />
          <p className="wk-readonly-note">Read-only — offline snapshot.</p>
          {payload.days.length === 0 ? (
            <p className="wk-empty">No days in this period yet.</p>
          ) : (
            <ul className="wk-day-list">
              {payload.days.map((day) => (
                <li key={day.date}>
                  <WorkerLink href={`/worker/periods/${payload.periodId}/hours/${day.date}`} className="wk-day-item">
                    <span className="wk-day-date">{day.date}</span>
                    <span className="wk-day-summary">
                      {day.dayType !== 'WORK'
                        ? day.dayType.replace('_', ' ').toLowerCase()
                        : day.confirmedZero
                          ? 'Confirmed 0h'
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
            <p className="wk-empty">{payload.dayType.replace('_', ' ').toLowerCase()}</p>
          ) : payload.confirmedZero ? (
            <p className="wk-empty">Confirmed 0 hours</p>
          ) : payload.segments.length === 0 ? (
            <p className="wk-empty">No hours logged for this day.</p>
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
          <h1>Submit timesheet</h1>
          <ReturnReasonsReadOnly reasons={payload.returnReasons} />
          <p>
            {payload.startDate} – {payload.endDate}
          </p>
          <p className="wk-readonly-note">
            {payload.workedDaysCount} of {payload.totalDaysCount} days filled in · {formatMinutes(payload.totalMinutes)} total
          </p>
          <p className="wk-empty">Connect to submit — this snapshot is read-only.</p>
        </>
      );
    }
  }
}

export function WorkerSnapshotView({ pathname }: { pathname: string }) {
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
          Loading…
        </p>
      </div>
    );
  }
  if (outcome === 'no-route' || outcome.kind === 'unavailable') {
    return <UnavailableNotice />;
  }

  return <ShellFrame capturedAt={outcome.record.capturedAt}>{renderPayload(outcome.record)}</ShellFrame>;
}
