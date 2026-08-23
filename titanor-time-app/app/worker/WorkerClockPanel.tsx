'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { captureGpsSnapshot, type GpsSnapshot } from '@/lib/worker-gps';
import { ensureDeviceBootstrapped, retryBootstrap, type BootstrapOutcome } from '@/lib/offline-outbox/device';
import { enqueueCheckIn, enqueueCheckOut, enqueueSwitchSite, EnqueueError } from '@/lib/offline-outbox/outbox';
import { runSyncOnce, tryRefreshClockState, type ClockStateWire, type SyncRunOutcome } from '@/lib/offline-outbox/sync-runner';
import { getAllOutboxEvents, type OutboxEventRecord, type CachedAssignment } from '@/lib/offline-outbox/db';
import { projectClockState } from '@/lib/offline-outbox/projection';
import { subscribeOutboxChanges } from '@/lib/offline-outbox/broadcast';
import { warmOfflineShellCache } from '@/lib/offline-outbox/pwa-warm-cache';
import { WorkerLink } from '@/components/worker-pwa/WorkerLink';
import { formatWorkedDuration } from '@/lib/reporting/report-format';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { WORKER_STRINGS, type WorkerStrings } from '@/lib/i18n/worker';

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

type GpsUiState = 'IDLE' | 'CHECKING' | 'READY' | 'PERMISSION' | 'UNAVAILABLE';

function assignmentKey(siteId: string, workAreaId: string | null): string {
  return `${siteId}::${workAreaId ?? ''}`;
}

function describeErrorCode(code: string | undefined, t: WorkerStrings): string {
  switch (code) {
    case 'OUTSIDE_GEOFENCE':
      return t.errOutsideGeofence;
    case 'VALIDATION_ERROR':
      return t.errValidation;
    case 'CLIENT_EVENT_ID_REUSED':
    case 'DEVICE_SEQUENCE_REUSED':
      return t.errDeviceRecordConflict;
    case 'SWITCH_SITE_GROUP_FAILED':
    case 'SWITCH_SITE_GROUP_INVALID':
      return t.errSwitchSiteFailed;
    case 'RATE_LIMITED':
      return t.errRateLimited;
    case 'NOT_AUTHENTICATED':
      return t.errSessionExpired;
    case 'FORBIDDEN':
    case 'NO_EMPLOYEE_PROFILE':
      return t.errNoPermission;
    case 'DEVICE_NOT_OWNED':
      return t.errDeviceNotOwned;
    case 'DEVICE_REVOKED':
      return t.errDeviceRevoked;
    case 'SYNC_PROTOCOL_ERROR':
    case 'NETWORK_ERROR':
      return t.errCouldNotReachServer;
    default:
      return t.errActionNeedsAttention;
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

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10C.1" §C — the narrow
// structural subset this component actually reads off an assignment. Both the server-side
// `WorkerCurrentAssignment` (lib/worker-context.ts) and the IndexedDB-cached `CachedAssignment`
// (lib/offline-outbox/db.ts) already satisfy this shape as-is — no adapter/mapping needed for
// either the online page or the offline shell to pass their own assignment list straight through.
export interface ClockPanelAssignment {
  id: string;
  siteId: string;
  siteName: string;
  workAreaId: string | null;
  workAreaName: string | null;
  isPrimary: boolean;
}

export interface WorkerClockPanelProps {
  initialClockState: ClockStateWire;
  assignments: ClockPanelAssignment[];
  workerName: string | null;
  todayLabel: string;
  recentActivity: {
    date: string;
    totalMinutes: number;
    siteNames: string[];
    href: string;
    isToday: boolean;
  } | null;
  /** `null` hides the corresponding nav link entirely — the offline shell passes `null` for both,
   * since /worker/periods and /worker/history need server data this slice does not cache and a
   * real navigation there while genuinely offline is left to fail the ordinary way, never silently
   * swapped for this shell (§C "остальные защищённые страницы не подменять worker shell"). */
  periodsHref: string | null;
  historyHref: string | null;
  /** Same `null`-hides convention as above — docs/titanor-time/T8_PWA_DESIGN.md §C.6. The offline
   * shell passes `null` for the same reason: /worker/install is not a service-worker-handled
   * route, so a real offline navigation there would hit a plain browser network error. */
  installHref: string | null;
  timeCardHref?: string | null;
}

export function WorkerClockPanel({ initialClockState, assignments, workerName, todayLabel, recentActivity, periodsHref, historyHref, installHref, timeCardHref = null }: WorkerClockPanelProps) {
  const t = WORKER_STRINGS[useAppLocale()];
  const router = useRouter();
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
  const [gpsStatus, setGpsStatus] = useState<GpsUiState>('IDLE');
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string | null>(() => {
    if (assignments.length === 0) return null;
    const primary = assignments.find((a) => a.isPrimary);
    return (primary ?? assignments[0]).id;
  });
  const [switchPanelOpen, setSwitchPanelOpen] = useState(false);
  const [switchTargetId, setSwitchTargetId] = useState<string | null>(null);
  const [assignmentSheetOpen, setAssignmentSheetOpen] = useState(false);
  const [statusSheetOpen, setStatusSheetOpen] = useState(false);

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
          setStatusMessage({ kind: 'error', text: t.syncOneOrMoreNeedAttention });
        } else if (outcome.ackedCount > 0) {
          setStatusMessage({ kind: 'info', text: t.synced });
          router.refresh();
        }
      } else if (outcome.kind === 'AUTH_EXPIRED') {
        setStatusMessage({ kind: 'error', text: describeErrorCode('NOT_AUTHENTICATED', t), code: 'NOT_AUTHENTICATED' });
        // A pause discovered mid-sync (as opposed to at bootstrap time) must still surface the
        // paused/return-notice UI (§8 "a paused auth/device state") — `bootstrap` otherwise stays
        // stale at its last READY value from mount, silently leaving the Check In/Out UI visible.
        setBootstrap({ kind: 'AUTH_EXPIRED' });
      } else if (outcome.kind === 'DEVICE_PAUSED') {
        setStatusMessage({ kind: 'error', text: describeErrorCode(outcome.reason, t), code: outcome.reason });
        setBootstrap({ kind: 'PAUSED', reason: outcome.reason });
      } else if (outcome.kind === 'RATE_LIMITED') {
        setStatusMessage({ kind: 'error', text: describeErrorCode('RATE_LIMITED', t), code: 'RATE_LIMITED' });
      } else if (outcome.kind === 'NETWORK_ERROR' || outcome.kind === 'RETRYABLE_HTTP' || outcome.kind === 'PROTOCOL_ERROR') {
        // Expected/transient while offline or the server is briefly unavailable — no alarming
        // message; the pending-count/offline indicator already communicates this.
      }
      await refreshOutboxSnapshot();
      return outcome;
    } finally {
      setSyncing(false);
    }
  }, [syncing, refreshOutboxSnapshot, router, t]);

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
      if (!cancelled && outcome.kind === 'READY') {
        // Best-effort, never awaited by anything the user is waiting on — warms the offline
        // shell's Cache Storage entry so a later genuinely offline cold start has something to
        // serve (§C of the T7A.10C.1 addendum). No-op if service workers aren't supported.
        void warmOfflineShellCache();
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

  useEffect(() => {
    if (!assignmentSheetOpen && !switchPanelOpen && !statusSheetOpen) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAssignmentSheetOpen(false);
        setSwitchPanelOpen(false);
        setStatusSheetOpen(false);
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [assignmentSheetOpen, statusSheetOpen, switchPanelOpen]);

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
    setGpsStatus('CHECKING');
    setStatusMessage({ kind: 'info', text: t.gettingLocation });
    try {
      const gpsSnapshot: GpsSnapshot = await captureGpsSnapshot();
      setGpsStatus(resolveGpsUiState(gpsSnapshot));
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
      setStatusMessage({ kind: 'info', text: isOnline ? t.savedSyncing : t.savedWaitingForSync });
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
    setGpsStatus('CHECKING');
    setStatusMessage({ kind: 'info', text: t.gettingLocation });
    try {
      const gpsSnapshot: GpsSnapshot = await captureGpsSnapshot();
      setGpsStatus(resolveGpsUiState(gpsSnapshot));
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
      setStatusMessage({ kind: 'info', text: isOnline ? t.savedSyncing : t.savedWaitingForSync });
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
    setGpsStatus('CHECKING');
    setStatusMessage({ kind: 'info', text: t.gettingLocation });
    try {
      const gpsSnapshot: GpsSnapshot = await captureGpsSnapshot();
      setGpsStatus(resolveGpsUiState(gpsSnapshot));
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
      setStatusMessage({ kind: 'info', text: isOnline ? t.savedSyncing : t.savedWaitingForSync });
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
      setStatusMessage({ kind: 'error', text: err.code === 'SEQUENCE_OVERFLOW' ? err.message : t.offlineSetupNotReady, code: err.code });
      return;
    }
    setStatusMessage({ kind: 'error', text: t.couldNotSaveAction });
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

  const currentHelsinki = useMemo(() => {
    const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return formatter.format(nowTick + offsetMs);
  }, [nowTick, offsetMs]);

  const selectedAssignment = assignments.find((a) => a.id === selectedAssignmentId) ?? assignments[0] ?? null;
  const activeSiteName = projected.state === 'CLOCKED_IN' ? projected.siteName : selectedAssignment?.siteName ?? null;
  const activeWorkAreaName = projected.state === 'CLOCKED_IN' ? projected.workAreaName : selectedAssignment?.workAreaName ?? null;

  const syncSummary = syncing
    ? t.syncing
    : failedRecords.length > 0
      ? t.statusNeedsAttention
      : pendingCount > 0
        ? t.statusWaitingCount(pendingCount)
        : t.statusSynced;

  const gpsSummary = gpsStatus === 'CHECKING'
    ? t.statusGpsChecking
    : gpsStatus === 'READY'
      ? t.statusGpsReady
      : gpsStatus === 'PERMISSION'
        ? t.statusGpsPermission
        : gpsStatus === 'UNAVAILABLE'
          ? t.statusGpsUnavailable
          : t.statusGpsWillCheck;

  const canOpenAssignmentSheet = projected.state === 'CLOCKED_OUT' && assignments.length > 1;

  const isClockedIn = projected.state === 'CLOCKED_IN';

  const actionLabel = isClockedIn ? t.checkOutUpper : t.checkInUpper;
  const actionHint = isClockedIn ? t.endWork : t.startWork;
  const actionHelper = locating ? t.statusGpsChecking : t.gpsCheckedAtAction;

  return (
    <div className="wk-card wk-clock-home-card">
      <button type="button" className="wk-status-card" onClick={() => setStatusSheetOpen(true)}>
        <div className="wk-status-card-head">
          <div>
            <p className="wk-status-card-name">{workerName ?? t.worker}</p>
            <p className="wk-status-card-date">{todayLabel}</p>
          </div>
          <div className="wk-status-card-time">{currentHelsinki}</div>
        </div>

        <div className="wk-status-workplace">
          <span className="wk-status-label">{t.workplaceLabel}</span>
          {activeSiteName ? <p className="wk-status-site">{activeSiteName}</p> : <p className="wk-status-site">{t.noWorkplaceAssigned}</p>}
          {activeWorkAreaName ? <p className="wk-status-workarea">{activeWorkAreaName}</p> : null}
        </div>

        <div className="wk-status-grid" role="status" aria-live="polite">
          <p>
            <span className={`wk-status-dot ${isOnline ? 'online' : 'offline'}`} aria-hidden="true" />
            <span>{t.statusInternet}</span>
            <strong>{isOnline ? t.online : t.offline}</strong>
          </p>
          <p>
            <span className={`wk-status-dot ${failedRecords.length > 0 ? 'warn' : pendingCount > 0 ? 'amber' : 'online'}`} aria-hidden="true" />
            <span>{t.statusSync}</span>
            <strong>{syncSummary}</strong>
          </p>
          <p>
            <span className={`wk-status-dot ${gpsStatus === 'READY' ? 'online' : gpsStatus === 'CHECKING' ? 'amber' : gpsStatus === 'IDLE' ? 'offline' : 'warn'}`} aria-hidden="true" />
            <span>{t.statusGps}</span>
            <strong>{gpsSummary}</strong>
          </p>
        </div>
      </button>

      {canOpenAssignmentSheet && (
        <button type="button" className="wk-inline-secondary" onClick={() => setAssignmentSheetOpen(true)} disabled={busy}>
          {t.changeWorkplace}
        </button>
      )}

      <div className={`wk-main-action-wrap ${isClockedIn ? 'in' : 'out'}`}>
        {isClockedIn && projected.openedAt && (
          <p className="wk-main-action-timer" aria-label={`Elapsed time ${formatDuration(durationMs)}`}>
            {formatDuration(durationMs)}
          </p>
        )}
        {isClockedIn && projected.openedAt ? <p className="wk-main-action-since">{t.sinceTime(formatHelsinkiTime(projected.openedAt))}</p> : null}

        <button
          type="button"
          className={`wk-main-action ${isClockedIn ? 'out' : 'in'}`}
          onClick={isClockedIn ? handleCheckOut : handleCheckIn}
          disabled={busy || setupNotReady || (projected.state === 'CLOCKED_OUT' && (!selectedAssignmentId || assignments.length === 0))}
          aria-live="polite"
          aria-label={isClockedIn ? t.checkOut : t.checkIn}
        >
          <span className="wk-main-action-title">{actionLabel}</span>
          <span className="wk-main-action-subtitle">{actionHint}</span>
          <span className="wk-main-action-helper">{actionHelper}</span>
        </button>
      </div>

      {setupNotReady && (
        <p className="wk-empty" role="status">
          {isOnline ? t.offlineSetupNotReadyConnecting : t.offlineSetupNotReadyConnectOnce}
        </p>
      )}

      {paused && (
        <div className="wk-return-notice">
          <p className="wk-return-notice-title">
            {paused === 'DEVICE_NOT_OWNED' && t.deviceNotLinked}
            {paused === 'DEVICE_REVOKED' && t.deviceDisabled}
            {paused === 'AUTH_EXPIRED' && t.sessionExpiredTitle}
          </p>
          {paused === 'AUTH_EXPIRED' ? (
            <a href="/login" className="wk-back-link">
              {t.logInAgain}
            </a>
          ) : (
            <button type="button" className="wk-clock-secondary-button" onClick={handleRetryBootstrap}>
              {t.retry}
            </button>
          )}
          <p className="wk-return-reason-text">{t.nothingLost}</p>
        </div>
      )}

      {!setupNotReady && isClockedIn && alternateAssignments.length > 0 && !switchPanelOpen && (
        <button type="button" className="wk-clock-secondary-button" onClick={openSwitchPanel} disabled={busy}>
          {t.switchWorkplace}
        </button>
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
          <p className="wk-return-notice-title">{t.actionNeedsAttention}</p>
          <ul className="wk-return-reason-list">
            {failedRecords.map((r) => (
              <li key={r.clientEventId} className="wk-return-reason-item">
                <span className="wk-return-reason-scope">{r.operationType === 'CHECK_IN' ? t.checkIn : t.checkOut}</span>
                <span className="wk-return-reason-text">{describeErrorCode(r.lastErrorCode ?? undefined, t)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="wk-time-preview" aria-labelledby="wk-time-preview-title">
        <div className="wk-time-preview-heading">
          <h2 id="wk-time-preview-title">{t.timeCardTitle}</h2>
          <span>{recentActivity?.isToday ? t.today : t.recent}</span>
        </div>

        {timeCardHref ? (
          <WorkerLink href={timeCardHref} className="wk-time-preview-link">
            <span>{t.viewAndEditHours}</span>
            <span aria-hidden="true">→</span>
          </WorkerLink>
        ) : null}

        {recentActivity ? (
          <WorkerLink href={recentActivity.href} className="wk-time-preview-day-link">
            <strong>{formatWorkedDuration(recentActivity.totalMinutes)}</strong>
            <span>{recentActivity.date}</span>
            <span>{recentActivity.siteNames.join(', ')}</span>
            <span aria-hidden="true">→</span>
          </WorkerLink>
        ) : (
          <p className="wk-empty">{t.noCompletedTimeEntries}</p>
        )}
      </section>

      {assignmentSheetOpen && (
        <>
          <button type="button" className="wk-overlay-backdrop" aria-hidden="true" tabIndex={-1} onClick={() => setAssignmentSheetOpen(false)} />
          <div className="wk-overlay-sheet" role="dialog" aria-modal="true" aria-label={t.changeWorkplace}>
            <p className="wk-overlay-title">{t.changeWorkplace}</p>
            <div role="radiogroup" aria-label="Select site to check in" className="wk-assignment-options">
              {assignments.map((a) => (
                <label key={a.id} className={`wk-assignment-option${selectedAssignmentId === a.id ? ' selected' : ''}`}>
                  <input type="radio" name="checkin-assignment" value={a.id} checked={selectedAssignmentId === a.id} onChange={() => setSelectedAssignmentId(a.id)} disabled={busy} />
                  <span className="wk-assignment-option-body">
                    <span className="wk-assignment-site">
                      {a.siteName}
                      {a.isPrimary ? t.primarySuffix : ''}
                    </span>
                    {a.workAreaName && <span className="wk-assignment-detail">{a.workAreaName}</span>}
                  </span>
                </label>
              ))}
            </div>
            <button type="button" className="wk-clock-cancel-button" onClick={() => setAssignmentSheetOpen(false)}>
              {t.close}
            </button>
          </div>
        </>
      )}

      {switchPanelOpen && (
        <>
          <button type="button" className="wk-overlay-backdrop" aria-hidden="true" tabIndex={-1} onClick={closeSwitchPanel} />
          <div className="wk-overlay-sheet" role="dialog" aria-modal="true" aria-label={t.switchWorkplace}>
            <p className="wk-overlay-title">{t.switchWorkplace}</p>
            {projected.siteName ? (
              <p className="wk-switch-summary">
                {t.currentWorkplacePrefix} {projected.siteName}
              </p>
            ) : null}
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
            {switchTarget ? <p className="wk-switch-summary">{t.switchFromTo(projected.siteName ?? '', switchTarget.siteName)}</p> : null}
            <div className="wk-switch-actions">
              <button type="button" className="wk-clock-secondary-button" onClick={handleConfirmSwitch} disabled={busy || !switchTargetId}>
                {t.confirmSwitch}
              </button>
              <button type="button" className="wk-clock-cancel-button" onClick={closeSwitchPanel} disabled={busy}>
                {t.cancel}
              </button>
            </div>
          </div>
        </>
      )}

      {statusSheetOpen && (
        <>
          <button type="button" className="wk-overlay-backdrop" aria-hidden="true" tabIndex={-1} onClick={() => setStatusSheetOpen(false)} />
          <div className="wk-overlay-sheet wk-status-sheet" role="dialog" aria-modal="true" aria-label={t.workStatus}>
            <p className="wk-overlay-title">{t.workStatus}</p>
            <p className="wk-status-sheet-name">{workerName ?? t.worker}</p>
            <p className="wk-status-sheet-line">{todayLabel}</p>
            <p className="wk-status-sheet-line">{currentHelsinki} · Europe/Helsinki</p>
            <p className="wk-status-sheet-line">{t.clockStateLabel}: {isClockedIn ? t.clockedIn : t.clockedOut}</p>
            {projected.openedAt ? <p className="wk-status-sheet-line">{t.startedAtLabel}: {formatHelsinkiTime(projected.openedAt)}</p> : null}
            {isClockedIn && projected.openedAt ? <p className="wk-status-sheet-line">{t.elapsedLabel}: {formatDuration(durationMs)}</p> : null}
            <p className="wk-status-sheet-line">{t.workplaceLabel}: {activeSiteName ?? t.noWorkplaceAssigned}</p>
            {activeWorkAreaName ? <p className="wk-status-sheet-line">{t.workAreaLabel}: {activeWorkAreaName}</p> : null}
            <p className="wk-status-sheet-line">{t.statusInternet}: {isOnline ? t.online : t.offline}</p>
            <p className="wk-status-sheet-line">{t.statusSync}: {syncSummary}</p>
            <p className="wk-status-sheet-line">{t.statusPendingActions}: {pendingCount}</p>
            <p className="wk-status-sheet-line">{t.statusGps}: {gpsSummary}</p>
            <button type="button" className="wk-clock-secondary-button" onClick={handleManualSync} disabled={syncing || setupNotReady}>
              {syncing ? t.syncing : t.syncNow}
            </button>
            <button type="button" className="wk-clock-cancel-button" onClick={() => setStatusSheetOpen(false)}>
              {t.close}
            </button>
          </div>
        </>
      )}

    </div>
  );
}

function resolveGpsUiState(snapshot: GpsSnapshot): GpsUiState {
  if (snapshot.location) {
    return 'READY';
  }
  if (snapshot.gpsUnavailableReason === 'PERMISSION_DENIED') {
    return 'PERMISSION';
  }
  return 'UNAVAILABLE';
}
