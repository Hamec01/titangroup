'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { WorkerCurrentAssignment } from '@/lib/worker-context';
import { captureGpsSnapshot, type GpsSnapshot } from '@/lib/worker-gps';
import { ensureDeviceBootstrapped, retryBootstrap, type BootstrapOutcome } from '@/lib/offline-outbox/device';
import { enqueueCheckIn, enqueueCheckOut, enqueueSwitchSite, EnqueueError } from '@/lib/offline-outbox/outbox';
import { runSyncOnce, tryRefreshClockState, type ClockStateWire, type SyncRunOutcome } from '@/lib/offline-outbox/sync-runner';
import { getAllOutboxEvents, type OutboxEventRecord, type CachedAssignment } from '@/lib/offline-outbox/db';
import { projectClockState } from '@/lib/offline-outbox/projection';
import { subscribeOutboxChanges } from '@/lib/offline-outbox/broadcast';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §6/§7/§9.11 (T7A.7B — offline outbox client).
// Every Check In/Out/Switch Site action now writes to the IndexedDB outbox FIRST (one atomic
// transaction, lib/offline-outbox/outbox.ts) and is submitted exclusively through
// POST /api/worker/attendance/sync — never a direct call to /check-in, /check-out or
// /switch-site any more. Those three online endpoints and their service logic are untouched and
// remain the supported, separately-tested API surface (regression, not deprecated).
const BOUNDED_SYNC_TIMER_MS = 25000;

interface StatusMessage {
  kind: 'info' | 'error';
  text: string;
  code?: string;
}

function assignmentKey(siteId: string, workAreaId: string | null): string {
  return `${siteId}::${workAreaId ?? ''}`;
}

function describeErrorCode(code: string | undefined): string {
  switch (code) {
    case 'OUTSIDE_GEOFENCE':
      return "You're outside this site's work area. Move closer and sync again.";
    case 'VALIDATION_ERROR':
      return 'This record could not be validated. Please contact your administrator.';
    case 'CLIENT_EVENT_ID_REUSED':
    case 'DEVICE_SEQUENCE_REUSED':
      return 'This device record conflicted with another one. Please contact your administrator.';
    case 'SWITCH_SITE_GROUP_FAILED':
    case 'SWITCH_SITE_GROUP_INVALID':
      return 'This site switch could not be completed. Please contact your administrator.';
    case 'RATE_LIMITED':
      return 'Too many attempts. Please wait a moment and try again.';
    case 'NOT_AUTHENTICATED':
      return 'Your session has expired.';
    case 'FORBIDDEN':
    case 'NO_EMPLOYEE_PROFILE':
      return "You don't have permission to do that. Contact your administrator.";
    case 'DEVICE_NOT_OWNED':
      return 'This device is no longer linked to your account.';
    case 'DEVICE_REVOKED':
      return 'This device has been disabled by an administrator.';
    case 'SYNC_PROTOCOL_ERROR':
    case 'NETWORK_ERROR':
      return "We couldn't reach the server. It will retry automatically.";
    default:
      return 'This action needs attention. Please contact your administrator.';
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

const helsinkiTimeFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function formatHelsinkiTime(iso: string): string {
  return helsinkiTimeFormatter.format(new Date(iso));
}

export interface WorkerClockPanelProps {
  initialClockState: ClockStateWire;
  assignments: WorkerCurrentAssignment[];
  workerName: string | null;
  todayLabel: string;
  periodsHref: string;
}

export function WorkerClockPanel({ initialClockState, assignments, workerName, todayLabel, periodsHref }: WorkerClockPanelProps) {
  const [bootstrap, setBootstrap] = useState<BootstrapOutcome | null>(null);
  const [clockState, setClockState] = useState<ClockStateWire>(initialClockState);
  const [outboxRecords, setOutboxRecords] = useState<OutboxEventRecord[]>([]);
  const [offsetMs, setOffsetMs] = useState(() => new Date(initialClockState.serverNow).getTime() - Date.now());
  const [nowTick, setNowTick] = useState(() => Date.now());
  // Always starts `true` (matching what SSR renders, since `navigator` doesn't exist server-side)
  // and is corrected in the mount effect below — reading `navigator.onLine` directly in the state
  // initializer would make the FIRST client render disagree with the server-rendered HTML whenever
  // the browser's actual connectivity is offline at hydration time, which React reports as a
  // hydration mismatch (found via Playwright console assertions during this slice's own testing).
  const [isOnline, setIsOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [locating, setLocating] = useState(false);
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string | null>(() => {
    if (assignments.length === 0) return null;
    const primary = assignments.find((a) => a.isPrimary);
    return (primary ?? assignments[0]).id;
  });
  const [switchPanelOpen, setSwitchPanelOpen] = useState(false);
  const [switchTargetId, setSwitchTargetId] = useState<string | null>(null);

  const busyRef = useRef(false); // synchronous double-click guard — checked BEFORE any await.

  const refreshOutboxSnapshot = useCallback(async () => {
    try {
      const all = await getAllOutboxEvents();
      setOutboxRecords(all);
    } catch {
      // IndexedDB unavailable — leave previous snapshot in place, UI degrades to authoritative-only.
    }
  }, []);

  const triggerSync = useCallback(async (force = false): Promise<SyncRunOutcome | null> => {
    if (syncing) {
      return null;
    }
    setSyncing(true);
    try {
      const outcome = await runSyncOnce(force);
      if (outcome.kind === 'OK') {
        if (outcome.clockState) {
          setClockState(outcome.clockState);
          setOffsetMs(new Date(outcome.clockState.serverNow).getTime() - Date.now());
          setNowTick(Date.now());
        }
        if (outcome.failedCount > 0) {
          setStatusMessage({ kind: 'error', text: 'One or more actions need attention — see below.' });
        } else if (outcome.ackedCount > 0) {
          setStatusMessage({ kind: 'info', text: 'Synced.' });
        }
      } else if (outcome.kind === 'AUTH_EXPIRED') {
        setStatusMessage({ kind: 'error', text: describeErrorCode('NOT_AUTHENTICATED'), code: 'NOT_AUTHENTICATED' });
        // A pause discovered mid-sync (as opposed to at bootstrap time) must still surface the
        // paused/return-notice UI (§8 "a paused auth/device state") — `bootstrap` otherwise stays
        // stale at its last READY value from mount, silently leaving the Check In/Out UI visible.
        setBootstrap({ kind: 'AUTH_EXPIRED' });
      } else if (outcome.kind === 'DEVICE_PAUSED') {
        setStatusMessage({ kind: 'error', text: describeErrorCode(outcome.reason), code: outcome.reason });
        setBootstrap({ kind: 'PAUSED', reason: outcome.reason });
      } else if (outcome.kind === 'RATE_LIMITED') {
        setStatusMessage({ kind: 'error', text: describeErrorCode('RATE_LIMITED'), code: 'RATE_LIMITED' });
      } else if (outcome.kind === 'NETWORK_ERROR' || outcome.kind === 'RETRYABLE_HTTP' || outcome.kind === 'PROTOCOL_ERROR') {
        // Expected/transient while offline or the server is briefly unavailable — no alarming
        // message; the pending-count/offline indicator already communicates this.
      }
      await refreshOutboxSnapshot();
      return outcome;
    } finally {
      setSyncing(false);
    }
  }, [syncing, refreshOutboxSnapshot]);

  // ---- Bootstrap + initial outbox snapshot ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const outcome = await ensureDeviceBootstrapped();
      if (cancelled) return;
      setBootstrap(outcome);
      await refreshOutboxSnapshot();
      if (!cancelled && (outcome.kind === 'READY' || outcome.kind === 'NOT_READY_OFFLINE')) {
        await triggerSync();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Correct isOnline post-hydration (see the state initializer's comment above) ----
  useEffect(() => {
    setIsOnline(navigator.onLine);
  }, []);

  // ---- Sync triggers: online event, visibilitychange/resume, bounded timer ----
  useEffect(() => {
    function handleOnline() {
      setIsOnline(true);
      void triggerSync();
    }
    function handleOffline() {
      setIsOnline(false);
    }
    function handleVisibility() {
      if (document.visibilityState === 'visible') {
        void triggerSync();
      }
    }
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);
    const timer = window.setInterval(() => {
      void triggerSync();
    }, BOUNDED_SYNC_TIMER_MS);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Cross-tab UX-only invalidation ----
  useEffect(() => {
    return subscribeOutboxChanges(() => {
      void refreshOutboxSnapshot();
    });
  }, [refreshOutboxSnapshot]);

  // Live shift duration tick while (projected) clocked in.
  const pendingSorted = useMemo(() => outboxRecords.filter((r) => r.state === 'PENDING' || r.state === 'SENDING').sort((a, b) => a.deviceSequence - b.deviceSequence), [outboxRecords]);
  const failedRecords = useMemo(() => outboxRecords.filter((r) => r.state === 'FAILED_TERMINAL'), [outboxRecords]);

  const cachedAssignments: CachedAssignment[] = bootstrap && bootstrap.kind === 'READY' ? (bootstrap.deviceState.contextAssignments ?? []) : [];
  const nameLookups = useMemo(() => {
    const siteNames = new Map<string, string>();
    const workAreaNames = new Map<string, string>();
    for (const a of assignments) {
      siteNames.set(a.siteId, a.siteName);
      if (a.workAreaId && a.workAreaName) workAreaNames.set(a.workAreaId, a.workAreaName);
    }
    for (const a of cachedAssignments) {
      if (!siteNames.has(a.siteId)) siteNames.set(a.siteId, a.siteName);
      if (a.workAreaId && a.workAreaName && !workAreaNames.has(a.workAreaId)) workAreaNames.set(a.workAreaId, a.workAreaName);
    }
    return { siteNames, workAreaNames };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignments, bootstrap]);

  const projected = useMemo(
    () => projectClockState(clockState, pendingSorted, (siteId) => nameLookups.siteNames.get(siteId) ?? null, (workAreaId) => (workAreaId ? (nameLookups.workAreaNames.get(workAreaId) ?? null) : null)),
    [clockState, pendingSorted, nameLookups]
  );

  useEffect(() => {
    if (projected.state !== 'CLOCKED_IN') {
      return;
    }
    const interval = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [projected.state]);

  function cachedGeofenceVersionIdFor(siteId: string): string | null {
    return cachedAssignments.find((a) => a.siteId === siteId)?.geofenceVersionId ?? null;
  }

  const deviceReady = bootstrap?.kind === 'READY';

  async function handleCheckIn() {
    if (busyRef.current || !deviceReady || !selectedAssignmentId) {
      return;
    }
    const assignment = assignments.find((a) => a.id === selectedAssignmentId);
    if (!assignment) {
      return;
    }
    busyRef.current = true;
    setLocating(true);
    setStatusMessage({ kind: 'info', text: 'Getting location…' });
    try {
      const gpsSnapshot: GpsSnapshot = await captureGpsSnapshot();
      setLocating(false);
      await enqueueCheckIn({
        siteId: assignment.siteId,
        siteName: assignment.siteName,
        workAreaId: assignment.workAreaId,
        workAreaName: assignment.workAreaName,
        clientCapturedAt: new Date().toISOString(),
        gps: gpsSnapshot.location,
        gpsUnavailableReason: gpsSnapshot.gpsUnavailableReason,
        cachedGeofenceVersionId: cachedGeofenceVersionIdFor(assignment.siteId)
      });
      await refreshOutboxSnapshot();
      setStatusMessage({ kind: 'info', text: isOnline ? 'Saved on device — syncing…' : 'Saved on device — waiting for sync.' });
      void triggerSync();
    } catch (err) {
      handleEnqueueError(err);
    } finally {
      setLocating(false);
      busyRef.current = false;
    }
  }

  async function handleCheckOut() {
    if (busyRef.current || !deviceReady || projected.state !== 'CLOCKED_IN' || !projected.siteId) {
      return;
    }
    busyRef.current = true;
    setLocating(true);
    setStatusMessage({ kind: 'info', text: 'Getting location…' });
    try {
      const gpsSnapshot: GpsSnapshot = await captureGpsSnapshot();
      setLocating(false);
      // §5.4 — Check Out is never blocked by a missing/failed GPS reading.
      await enqueueCheckOut({
        assumedSiteId: projected.siteId,
        clientCapturedAt: new Date().toISOString(),
        gps: gpsSnapshot.location,
        gpsUnavailableReason: gpsSnapshot.gpsUnavailableReason
      });
      await refreshOutboxSnapshot();
      setSwitchPanelOpen(false);
      setSwitchTargetId(null);
      setStatusMessage({ kind: 'info', text: isOnline ? 'Saved on device — syncing…' : 'Saved on device — waiting for sync.' });
      void triggerSync();
    } catch (err) {
      handleEnqueueError(err);
    } finally {
      setLocating(false);
      busyRef.current = false;
    }
  }

  function openSwitchPanel() {
    if (busyRef.current || projected.state !== 'CLOCKED_IN' || !projected.siteId) {
      return;
    }
    const alternates = assignments.filter((a) => assignmentKey(a.siteId, a.workAreaId) !== assignmentKey(projected.siteId!, projected.workAreaId));
    setSwitchTargetId(alternates[0]?.id ?? null);
    setSwitchPanelOpen(true);
    setStatusMessage(null);
  }

  function closeSwitchPanel() {
    if (busyRef.current) {
      return;
    }
    setSwitchPanelOpen(false);
    setSwitchTargetId(null);
  }

  async function handleConfirmSwitch() {
    if (busyRef.current || !switchTargetId || projected.state !== 'CLOCKED_IN' || !projected.siteId) {
      return;
    }
    const target = assignments.find((a) => a.id === switchTargetId);
    if (!target) {
      return;
    }
    busyRef.current = true;
    setLocating(true);
    setStatusMessage({ kind: 'info', text: 'Getting location…' });
    try {
      const gpsSnapshot: GpsSnapshot = await captureGpsSnapshot();
      setLocating(false);
      await enqueueSwitchSite({
        oldAssumedSiteId: projected.siteId,
        newSiteId: target.siteId,
        newSiteName: target.siteName,
        newWorkAreaId: target.workAreaId,
        newWorkAreaName: target.workAreaName,
        clientCapturedAt: new Date().toISOString(),
        gps: gpsSnapshot.location,
        gpsUnavailableReason: gpsSnapshot.gpsUnavailableReason,
        cachedGeofenceVersionId: cachedGeofenceVersionIdFor(target.siteId)
      });
      await refreshOutboxSnapshot();
      setSwitchPanelOpen(false);
      setSwitchTargetId(null);
      setStatusMessage({ kind: 'info', text: isOnline ? 'Saved on device — syncing…' : 'Saved on device — waiting for sync.' });
      void triggerSync();
    } catch (err) {
      handleEnqueueError(err);
    } finally {
      setLocating(false);
      busyRef.current = false;
    }
  }

  function handleEnqueueError(err: unknown) {
    if (err instanceof EnqueueError) {
      setStatusMessage({ kind: 'error', text: err.code === 'SEQUENCE_OVERFLOW' ? err.message : 'Offline setup is not ready yet.', code: err.code });
      return;
    }
    setStatusMessage({ kind: 'error', text: 'Could not save this action on this device. Please try again.' });
  }

  async function handleRetryBootstrap() {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const outcome = await retryBootstrap();
      setBootstrap(outcome);
      await refreshOutboxSnapshot();
      if (outcome.kind === 'READY') {
        setStatusMessage(null);
        void triggerSync();
      }
    } finally {
      busyRef.current = false;
    }
  }

  async function handleManualSync() {
    if (busyRef.current) return;
    await triggerSync(true);
    // §7 — after any successfully applied response, reconcile via authoritative clock-state even
    // if nothing was pending (covers "just check current state now").
    if (outboxRecords.length === 0) {
      const fresh = await tryRefreshClockState();
      if (fresh) {
        setClockState(fresh);
        setOffsetMs(new Date(fresh.serverNow).getTime() - Date.now());
        setNowTick(Date.now());
      }
    }
  }

  const busy = locating || syncing;
  const alternateAssignments = projected.siteId ? assignments.filter((a) => assignmentKey(a.siteId, a.workAreaId) !== assignmentKey(projected.siteId!, projected.workAreaId)) : [];
  const switchTarget = switchTargetId ? assignments.find((a) => a.id === switchTargetId) : undefined;
  const durationMs = projected.openedAt ? Math.max(0, nowTick + offsetMs - new Date(projected.openedAt).getTime()) : 0;
  const pendingCount = pendingSorted.length;

  const setupNotReady = bootstrap === null || bootstrap.kind === 'NOT_READY_OFFLINE';
  const paused = bootstrap?.kind === 'PAUSED' ? bootstrap.reason : bootstrap?.kind === 'AUTH_EXPIRED' ? 'AUTH_EXPIRED' : null;

  return (
    <div className="wk-card wk-clock-card">
      <div className="wk-clock-header">
        {workerName && <p className="wk-clock-worker-name">{workerName}</p>}
        <p className="wk-clock-today">{todayLabel}</p>
      </div>

      <div className="wk-offline-bar" role="status" aria-live="polite">
        <span className={`wk-connectivity-dot${isOnline ? ' online' : ' offline'}`} aria-hidden="true" />
        <span>{isOnline ? 'Online' : 'Offline'}</span>
        {pendingCount > 0 && <span className="wk-pending-count">{pendingCount} pending</span>}
        <button type="button" className="wk-sync-now-button" onClick={handleManualSync} disabled={syncing || setupNotReady}>
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      {setupNotReady && (
        <p className="wk-empty" role="status">
          Offline setup is not ready yet{isOnline ? ' — connecting…' : '. Connect to the internet once to finish setup.'}
        </p>
      )}

      {paused && (
        <div className="wk-return-notice">
          <p className="wk-return-notice-title">
            {paused === 'DEVICE_NOT_OWNED' && 'This device is not linked to your account.'}
            {paused === 'DEVICE_REVOKED' && 'This device has been disabled.'}
            {paused === 'AUTH_EXPIRED' && 'Your session has expired.'}
          </p>
          {paused === 'AUTH_EXPIRED' ? (
            <Link href="/login" className="wk-back-link">
              Log in again →
            </Link>
          ) : (
            <button type="button" className="wk-clock-secondary-button" onClick={handleRetryBootstrap}>
              Retry
            </button>
          )}
          <p className="wk-return-reason-text">Nothing saved on this device has been lost.</p>
        </div>
      )}

      {!setupNotReady && (
        <>
          {projected.state === 'CLOCKED_OUT' ? (
            <>
              <p className="wk-clock-status-label wk-clock-status-out">Clocked out</p>

              {assignments.length === 0 ? (
                <p className="wk-empty">You haven&apos;t been assigned to a site yet. Contact your foreman or admin.</p>
              ) : (
                <div role="radiogroup" aria-label="Select site to check in" className="wk-assignment-options">
                  {assignments.map((a) => (
                    <label key={a.id} className={`wk-assignment-option${selectedAssignmentId === a.id ? ' selected' : ''}`}>
                      <input
                        type="radio"
                        name="checkin-assignment"
                        value={a.id}
                        checked={selectedAssignmentId === a.id}
                        onChange={() => setSelectedAssignmentId(a.id)}
                        disabled={busy}
                      />
                      <span className="wk-assignment-option-body">
                        <span className="wk-assignment-site">
                          {a.siteName}
                          {a.isPrimary ? ' · Primary' : ''}
                        </span>
                        {a.workAreaName && <span className="wk-assignment-detail">{a.workAreaName}</span>}
                      </span>
                    </label>
                  ))}
                </div>
              )}

              <button type="button" className="wk-action-button" onClick={handleCheckIn} disabled={busy || assignments.length === 0 || !selectedAssignmentId}>
                Check in
              </button>
            </>
          ) : (
            <>
              <p className="wk-clock-status-label wk-clock-status-in">Clocked in{projected.isProjected ? ' (waiting for sync)' : ''}</p>
              {projected.siteName && <p className="wk-clock-site">{projected.siteName}</p>}
              {projected.workAreaName && <p className="wk-clock-workarea">{projected.workAreaName}</p>}
              {projected.openedAt && <p className="wk-clock-since">Since {formatHelsinkiTime(projected.openedAt)}</p>}
              <p className="wk-clock-timer" aria-label={`Elapsed time ${formatDuration(durationMs)}`}>
                {formatDuration(durationMs)}
              </p>

              <button type="button" className="wk-action-button" onClick={handleCheckOut} disabled={busy}>
                Check out
              </button>

              {alternateAssignments.length > 0 && !switchPanelOpen && (
                <button type="button" className="wk-clock-secondary-button" onClick={openSwitchPanel} disabled={busy}>
                  Switch site
                </button>
              )}

              {switchPanelOpen && (
                <div className="wk-switch-panel">
                  <p className="wk-section-title">Switch to a different site</p>
                  <div role="radiogroup" aria-label="Select new site" className="wk-assignment-options">
                    {alternateAssignments.map((a) => (
                      <label key={a.id} className={`wk-assignment-option${switchTargetId === a.id ? ' selected' : ''}`}>
                        <input type="radio" name="switch-assignment" checked={switchTargetId === a.id} onChange={() => setSwitchTargetId(a.id)} disabled={busy} />
                        <span className="wk-assignment-option-body">
                          <span className="wk-assignment-site">{a.siteName}</span>
                          {a.workAreaName && <span className="wk-assignment-detail">{a.workAreaName}</span>}
                        </span>
                      </label>
                    ))}
                  </div>
                  {switchTarget && (
                    <p className="wk-switch-summary">
                      From <strong>{projected.siteName}</strong> to <strong>{switchTarget.siteName}</strong>
                    </p>
                  )}
                  <div className="wk-switch-actions">
                    <button type="button" className="wk-clock-secondary-button" onClick={handleConfirmSwitch} disabled={busy || !switchTargetId}>
                      Confirm switch
                    </button>
                    <button type="button" className="wk-clock-cancel-button" onClick={closeSwitchPanel} disabled={busy}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      {statusMessage && (
        <p
          className={statusMessage.kind === 'error' ? 'login-error' : 'wk-status-live'}
          role={statusMessage.kind === 'error' ? 'alert' : 'status'}
          aria-live={statusMessage.kind === 'error' ? 'assertive' : 'polite'}
        >
          {statusMessage.text}
        </p>
      )}

      {failedRecords.length > 0 && (
        <div className="wk-return-notice" aria-live="polite">
          <p className="wk-return-notice-title">Needs attention</p>
          <ul className="wk-return-reason-list">
            {failedRecords.map((r) => (
              <li key={r.clientEventId} className="wk-return-reason-item">
                <span className="wk-return-reason-scope">{r.operationType === 'CHECK_IN' ? 'Check in' : 'Check out'}</span>
                <span className="wk-return-reason-text">{describeErrorCode(r.lastErrorCode ?? undefined)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="wk-clock-nav">
        <Link href={periodsHref} className="wk-back-link">
          My periods →
        </Link>
        <Link href="/worker/history" className="wk-back-link">
          History →
        </Link>
      </div>
    </div>
  );
}
