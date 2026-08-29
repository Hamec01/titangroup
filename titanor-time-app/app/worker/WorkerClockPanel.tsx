'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  captureGpsSnapshot,
  evaluateZoneProximity,
  getGeolocationPermissionState,
  requestGeolocationPermission,
  startGpsWatch,
  stopGpsWatch,
  currentBestFix,
  hasFreshGoodFix,
  isGeoOnboarded,
  markGeoOnboarded,
  clearGeoOnboarded,
  type GpsSnapshot,
  type GeolocationPermissionState
} from '@/lib/worker-gps';
import { ensureDeviceBootstrapped, retryBootstrap, type BootstrapOutcome } from '@/lib/offline-outbox/device';
import { enqueueCheckIn, enqueueCheckOut, enqueueSwitchSite, EnqueueError } from '@/lib/offline-outbox/outbox';
import type { OutboxGps, OutboxApproximateGps, OutboxGpsUnavailableReason } from '@/lib/offline-outbox/db';
import { runSyncOnce, tryRefreshClockState, type ClockStateWire, type SyncRunOutcome } from '@/lib/offline-outbox/sync-runner';
import { enqueuePresenceSample, lastPresenceCaptureMs, shouldCapturePresence } from '@/lib/offline-outbox/presence';
import { runPresenceSyncOnce } from '@/lib/offline-outbox/presence-sync';
import { getAllOutboxEvents, type OutboxEventRecord, type CachedAssignment } from '@/lib/offline-outbox/db';
import { projectClockState } from '@/lib/offline-outbox/projection';
import { subscribeOutboxChanges } from '@/lib/offline-outbox/broadcast';
import { warmOfflineShellCache } from '@/lib/offline-outbox/pwa-warm-cache';
import { WorkerLink } from '@/components/worker-pwa/WorkerLink';
import { formatWorkedDuration } from '@/lib/reporting/report-format';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { WORKER_STRINGS, describeWorkerErrorCode, type WorkerStrings } from '@/lib/i18n/worker';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §6/§7/§9.11 (T7A.7B — offline outbox client).
// Every Check In/Out/Switch Site action now writes to the IndexedDB outbox FIRST (one atomic
// transaction, lib/offline-outbox/outbox.ts) and is submitted exclusively through
// POST /api/worker/attendance/sync — never a direct call to /check-in, /check-out or
// /switch-site any more. Those three online endpoints and their service logic are untouched and
// remain the supported, separately-tested API surface (regression, not deprecated).
const BOUNDED_SYNC_TIMER_MS = 25000;
// Deliberately a periodic one-shot getCurrentPosition, not watchPosition — same privacy posture
// as the button-press capture above (no persistence, no logging), just repeated on a timer so the
// "in zone" badge below updates without the worker having to press anything. Paused while the tab
// is hidden (see the visibility gate on the interval below).
const ZONE_CHECK_INTERVAL_MS = 30000;
// T14 — when a Check In/Out/Switch is pressed and no fresh GPS fix is on hand, show a short
// "finding your location" prompt with this countdown and a "clock in anyway" button that aborts
// the wait and proceeds with whatever (cached / last-good / none) worker-gps can offer.
const GPS_WAIT_SECONDS = 15;

interface StatusMessage {
  kind: 'info' | 'error';
  text: string;
  code?: string;
}

type GpsUiState = 'IDLE' | 'CHECKING' | 'READY' | 'PERMISSION' | 'UNAVAILABLE';
type ZoneStatus = 'UNKNOWN' | 'CHECKING' | 'INSIDE' | 'OUTSIDE' | 'LOW_ACCURACY' | 'NO_GEOFENCE' | 'UNAVAILABLE';

function assignmentKey(siteId: string, workAreaId: string | null): string {
  return `${siteId}::${workAreaId ?? ''}`;
}

const describeErrorCode = describeWorkerErrorCode;

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

export interface WorkerWeekDayActivity {
  date: string;
  label: string;
  totalMinutes: number;
  isToday: boolean;
  href: string | null;
}

export interface WorkerWeekActivity {
  days: WorkerWeekDayActivity[];
  totalMinutes: number;
}

export interface WorkerClockPanelProps {
  initialClockState: ClockStateWire;
  assignments: ClockPanelAssignment[];
  workerName: string | null;
  todayLabel: string;
  weekActivity: WorkerWeekActivity | null;
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

export function WorkerClockPanel({ initialClockState, assignments, workerName, todayLabel, weekActivity, periodsHref, historyHref, installHref, timeCardHref = null }: WorkerClockPanelProps) {
  const locale = useAppLocale();
  const t = WORKER_STRINGS[locale];
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
  const [zoneStatus, setZoneStatus] = useState<ZoneStatus>('UNKNOWN');
  // GPS steps 2+3 — one-time permission + a long-lived watch feeding a best-fix buffer.
  const [gpsPermission, setGpsPermission] = useState<GeolocationPermissionState | null>(null);
  const [bestAccuracyM, setBestAccuracyM] = useState<number | null>(null);
  const [refiningGps, setRefiningGps] = useState(false);
  // T14 — the "finding your location" prompt: `null` when not waiting, otherwise the seconds left.
  const [gpsWaitSecondsLeft, setGpsWaitSecondsLeft] = useState<number | null>(null);
  const gpsWaitAbortRef = useRef<AbortController | null>(null);
  // T17 — modal shown when a good GPS fix puts the worker outside the site geofence on Check In.
  const [outsideZonePrompt, setOutsideZonePrompt] = useState<{ siteName: string; resolve: (proceed: boolean) => void } | null>(null);
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
        // T15 — a permanently-failed action is surfaced only in the notification bell now (its own
        // "needs attention" list), never as a message on the clock screen. `router.refresh()` still
        // runs on a successful ack so the rest of the page reflects the new server state.
        if (outcome.failedCount === 0 && outcome.ackedCount > 0) {
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

  // ---- GPS steps 2+3 — resolve permission once, then keep one long-lived watch running while
  // this panel is mounted. The watch feeds worker-gps's best-fix buffer, so Check In/Out uses the
  // least-bad recent reading and the OS never re-prompts. ----
  // Flip back to the blocked banner and forget the onboarding flag when the OS reports the grant is
  // really gone (worker turned Location off after granting).
  const handleGeoPermissionRevoked = useCallback(() => {
    clearGeoOnboarded();
    setGpsPermission('denied');
    stopGpsWatch();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getGeolocationPermissionState().then((state) => {
      if (cancelled) return;
      if (state === 'denied') {
        // Explicit, trustworthy on every browser — always the blocked banner.
        clearGeoOnboarded();
        setGpsPermission('denied');
        return;
      }
      if (state === 'granted') {
        markGeoOnboarded();
        setGpsPermission('granted');
        startGpsWatch(handleGeoPermissionRevoked);
        return;
      }
      // state is 'prompt' or 'unsupported'. On iOS Safari navigator.permissions reports 'prompt'
      // even when the grant is live, so this is NOT proof the worker still needs to be asked. If
      // they already completed onboarding on this device, trust that: run the watch silently and
      // let handleGeoPermissionRevoked catch a real revocation. Only a fresh device (no flag) sees
      // the onboarding banner.
      if (isGeoOnboarded()) {
        setGpsPermission('granted');
        startGpsWatch(handleGeoPermissionRevoked);
      } else {
        setGpsPermission(state);
        if (state === 'unsupported') {
          startGpsWatch(handleGeoPermissionRevoked);
        }
      }
    });
    const readout = window.setInterval(() => {
      const fix = currentBestFix(90_000);
      setBestAccuracyM(fix ? fix.accuracyMeters : null);
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(readout);
      stopGpsWatch();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // T14 — abort any in-progress "finding your location" wait if the panel unmounts mid-capture.
  useEffect(() => () => gpsWaitAbortRef.current?.abort(), []);

  // A clock-action capture that comes back PERMISSION_DENIED is the OS actively refusing — surface
  // the "blocked, fix it in settings" banner and forget the onboarding flag.
  useEffect(() => {
    if (gpsStatus === 'PERMISSION') {
      clearGeoOnboarded();
      setGpsPermission('denied');
    }
  }, [gpsStatus]);

  async function handleGrantGps(): Promise<void> {
    const result = await requestGeolocationPermission();
    if (result.granted) {
      markGeoOnboarded();
      setGpsPermission('granted');
      startGpsWatch(handleGeoPermissionRevoked);
      return;
    }
    if (result.reason === 'PERMISSION_DENIED') {
      clearGeoOnboarded();
      setGpsPermission('denied');
      return;
    }
    // TIMEOUT / POSITION_UNAVAILABLE — the OS prompt was shown and the worker did NOT deny it; we
    // just couldn't pull a fix right now (very common indoors). Treat onboarding as done so the
    // banner stops re-appearing, and start the watch — it picks up a fix once there's signal.
    markGeoOnboarded();
    setGpsPermission('granted');
    startGpsWatch(handleGeoPermissionRevoked);
  }

  async function handleRefineGps(): Promise<void> {
    if (refiningGps) return;
    setRefiningGps(true);
    try {
      const snap = await captureGpsSnapshot();
      setBestAccuracyM(snap.location ? snap.location.accuracyMeters : null);
      if (snap.location) setGpsStatus('READY');
    } finally {
      setRefiningGps(false);
    }
  }

  // ---- Sync triggers: online event, visibilitychange/resume, bounded timer ----
  useEffect(() => {
    function handleOnline() {
      setIsOnline(true);
      void triggerSync();
      void runPresenceSyncOnce();
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

  // ---- T12 §2b — opportunistic "still on site" GPS sample during an open shift ----
  // A full-background timer is impossible in an iOS PWA, so this is the realistic version: whenever
  // the app becomes visible AND a shift is open AND >3h have passed since the last sample, take one
  // GPS fix and queue it (offline-safe). It never gates anything — pure evidence for the admin.
  const presenceInFlightRef = useRef(false);
  useEffect(() => {
    const isClockedIn = projected.state === 'CLOCKED_IN';
    const ready = bootstrap?.kind === 'READY';

    async function maybeCapturePresence(): Promise<void> {
      if (!isClockedIn || presenceInFlightRef.current || !ready) {
        return;
      }
      presenceInFlightRef.current = true;
      try {
        const last = await lastPresenceCaptureMs();
        if (!shouldCapturePresence(last, Date.now())) {
          void runPresenceSyncOnce(); // still flush anything already queued
          return;
        }
        const snap = await captureGpsSnapshot();
        if (snap.location) {
          await enqueuePresenceSample({
            latitude: snap.location.latitude,
            longitude: snap.location.longitude,
            accuracyMeters: snap.location.accuracyMeters,
            capturedAt: new Date().toISOString(),
            capturedOffline: !navigator.onLine
          });
        }
        void runPresenceSyncOnce();
      } catch {
        // A presence sample is never worth surfacing an error for.
      } finally {
        presenceInFlightRef.current = false;
      }
    }

    function onVisible(): void {
      if (document.visibilityState === 'visible') {
        void maybeCapturePresence();
      }
    }

    void maybeCapturePresence(); // also check right now (e.g. just clocked in, or app already open 3h+)
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projected.state, bootstrap?.kind]);

  function cachedGeofenceVersionIdFor(siteId: string): string | null {
    return cachedAssignments.find((a) => a.siteId === siteId)?.geofenceVersionId ?? null;
  }

  function cachedGeofenceFor(siteId: string): { latitude: number; longitude: number; radiusMeters: number } | null {
    const cached = cachedAssignments.find((a) => a.siteId === siteId);
    if (!cached || cached.geofenceLatitude == null || cached.geofenceLongitude == null || cached.geofenceRadiusMeters == null) {
      return null;
    }
    return { latitude: cached.geofenceLatitude, longitude: cached.geofenceLongitude, radiusMeters: cached.geofenceRadiusMeters };
  }

  // The site the "in zone" badge below checks against: the open shift's site while clocked in
  // (matches what Check Out will validate), otherwise whichever site is currently selected for the
  // next Check In.
  const zoneCheckSiteId = projected.state === 'CLOCKED_IN' ? projected.siteId : (assignments.find((a) => a.id === selectedAssignmentId)?.siteId ?? null);

  useEffect(() => {
    if (!zoneCheckSiteId) {
      setZoneStatus('UNKNOWN');
      return;
    }
    const geofence = cachedGeofenceFor(zoneCheckSiteId);
    if (!geofence) {
      setZoneStatus('NO_GEOFENCE');
      return;
    }
    let cancelled = false;
    function check() {
      // GPS steps 2+3 — the long-lived watch already keeps worker-gps's best-fix buffer fresh, so
      // the "in zone" badge reads it passively instead of firing its own getCurrentPosition every
      // 30 s. A one-shot capture still happens at the actual Check In/Out.
      const fix = currentBestFix(90_000);
      if (cancelled) {
        return;
      }
      setZoneStatus(fix ? evaluateZoneProximity(fix, geofence!) : 'CHECKING');
    }
    check();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void check();
      }
    }, ZONE_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneCheckSiteId, cachedAssignments]);

  const deviceReady = bootstrap?.kind === 'READY';

  // T14 — capture GPS for a clock action. If a fresh accurate fix is already on hand, proceed with
  // no prompt. Otherwise show the "finding your location" countdown; `captureGpsSnapshot` waits up
  // to GPS_WAIT_SECONDS and the worker can press "clock in anyway" (skipGpsWait) to abort early and
  // take whatever cached / last-good point is available.
  async function runGpsCapture(): Promise<GpsSnapshot> {
    if (hasFreshGoodFix()) {
      return captureGpsSnapshot({ maxWaitMs: GPS_WAIT_SECONDS * 1000 });
    }
    const abort = new AbortController();
    gpsWaitAbortRef.current = abort;
    const startedAt = Date.now();
    setGpsWaitSecondsLeft(GPS_WAIT_SECONDS);
    const ticker = window.setInterval(() => {
      setGpsWaitSecondsLeft(Math.max(0, GPS_WAIT_SECONDS - Math.floor((Date.now() - startedAt) / 1000)));
    }, 250);
    try {
      return await captureGpsSnapshot({ maxWaitMs: GPS_WAIT_SECONDS * 1000, signal: abort.signal });
    } finally {
      window.clearInterval(ticker);
      setGpsWaitSecondsLeft(null);
      gpsWaitAbortRef.current = null;
    }
  }

  function skipGpsWait() {
    gpsWaitAbortRef.current?.abort();
  }

  // T17 — the worker taps Check In and a good GPS fix puts them outside the site geofence. Check In
  // is never blocked (the server opens the shift and files a review flag either way), but the
  // worker gets a MODAL choice first — it cannot be swiped/tapped away, one of the two buttons must
  // be pressed. `true` = go ahead and check in; `false` = don't (they'll walk closer first).
  function confirmOutsideZone(siteName: string, snapshot: GpsSnapshot, siteId: string): Promise<boolean> {
    if (!snapshot.location || snapshot.approximate) {
      return Promise.resolve(true); // no reliable fix -> nothing to warn about, just proceed
    }
    const geofence = cachedGeofenceFor(siteId);
    if (!geofence || evaluateZoneProximity(snapshot.location, geofence) !== 'OUTSIDE') {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      setOutsideZonePrompt({ siteName, resolve });
    });
  }

  function answerOutsideZone(proceed: boolean) {
    outsideZonePrompt?.resolve(proceed);
    setOutsideZonePrompt(null);
  }

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
      const gpsSnapshot: GpsSnapshot = await runGpsCapture();
      setGpsStatus(resolveGpsUiState(gpsSnapshot));
      setLocating(false);
      if (!(await confirmOutsideZone(assignment.siteName, gpsSnapshot, assignment.siteId))) {
        setStatusMessage(null);
        return;
      }
      const gpsFields = outboxGpsFields(gpsSnapshot);
      await enqueueCheckIn({
        siteId: assignment.siteId,
        siteName: assignment.siteName,
        workAreaId: assignment.workAreaId,
        workAreaName: assignment.workAreaName,
        clientCapturedAt: new Date().toISOString(),
        ...gpsFields,
        cachedGeofenceVersionId: cachedGeofenceVersionIdFor(assignment.siteId)
      });
      await refreshOutboxSnapshot();
      setStatusMessage({ kind: 'info', text: gpsFields.gpsApproximate ? t.savedApproxLocation : isOnline ? t.savedSyncing : t.savedWaitingForSync });
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
      const gpsSnapshot: GpsSnapshot = await runGpsCapture();
      setGpsStatus(resolveGpsUiState(gpsSnapshot));
      setLocating(false);
      // §5.4 — Check Out is never blocked by a missing/failed GPS reading.
      const gpsFields = outboxGpsFields(gpsSnapshot);
      await enqueueCheckOut({
        assumedSiteId: projected.siteId,
        clientCapturedAt: new Date().toISOString(),
        ...gpsFields
      });
      await refreshOutboxSnapshot();
      setSwitchPanelOpen(false);
      setSwitchTargetId(null);
      setStatusMessage({ kind: 'info', text: gpsFields.gpsApproximate ? t.savedApproxLocation : isOnline ? t.savedSyncing : t.savedWaitingForSync });
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
      const gpsSnapshot: GpsSnapshot = await runGpsCapture();
      setGpsStatus(resolveGpsUiState(gpsSnapshot));
      setLocating(false);
      if (!(await confirmOutsideZone(target.siteName, gpsSnapshot, target.siteId))) {
        setStatusMessage(null);
        return;
      }
      const gpsFields = outboxGpsFields(gpsSnapshot);
      await enqueueSwitchSite({
        oldAssumedSiteId: projected.siteId,
        newSiteId: target.siteId,
        newSiteName: target.siteName,
        newWorkAreaId: target.workAreaId,
        newWorkAreaName: target.workAreaName,
        clientCapturedAt: new Date().toISOString(),
        ...gpsFields,
        cachedGeofenceVersionId: cachedGeofenceVersionIdFor(target.siteId)
      });
      await refreshOutboxSnapshot();
      setSwitchPanelOpen(false);
      setSwitchTargetId(null);
      setStatusMessage({ kind: 'info', text: gpsFields.gpsApproximate ? t.savedApproxLocation : isOnline ? t.savedSyncing : t.savedWaitingForSync });
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

  const syncSummary = syncing ? t.syncing : pendingCount > 0 ? t.statusWaitingCount(pendingCount) : t.statusSynced;

  const gpsSummary = gpsStatus === 'CHECKING'
    ? t.statusGpsChecking
    : gpsStatus === 'READY'
      ? t.statusGpsReady
      : gpsStatus === 'PERMISSION'
        ? t.statusGpsPermission
        : gpsStatus === 'UNAVAILABLE'
          ? t.statusGpsUnavailable
          : t.statusGpsWillCheck;

  const zoneSummary = zoneStatus === 'CHECKING'
    ? t.statusZoneChecking
    : zoneStatus === 'INSIDE'
      ? t.statusZoneInside
      : zoneStatus === 'OUTSIDE'
        ? t.statusZoneOutside
        : zoneStatus === 'LOW_ACCURACY'
          ? t.statusZoneLowAccuracy
          : t.statusZoneUnavailable;
  // Hidden when there's nothing to check yet (no site selected) or the site has no geofence
  // configured — a badge with nothing meaningful to report would just be noise.
  const showZoneStatus = zoneStatus !== 'UNKNOWN' && zoneStatus !== 'NO_GEOFENCE';

  const canOpenAssignmentSheet = projected.state === 'CLOCKED_OUT' && assignments.length > 1;

  const isClockedIn = projected.state === 'CLOCKED_IN';

  const actionLabel = isClockedIn ? t.checkOutUpper : t.checkInUpper;
  const actionHint = isClockedIn ? t.endWork : t.startWork;
  const actionHelper = locating ? t.statusGpsChecking : t.gpsCheckedAtAction;

  // weekActivity's per-day totals come from materialized (checked-out) segments only — the
  // currently open shift isn't one of those until Check Out, so today's cell would otherwise sit
  // at its pre-shift total while the big timer above ticks up, reading as if today wasn't counted
  // at all. Folding the same live duration the timer already shows into today's cell (and the
  // period total) keeps both numbers consistent without waiting for Check Out.
  const liveElapsedMinutes = isClockedIn && projected.openedAt ? Math.floor(durationMs / 60000) : 0;
  const displayWeekActivity = useMemo(() => {
    if (!weekActivity || liveElapsedMinutes === 0) {
      return weekActivity;
    }
    return {
      totalMinutes: weekActivity.totalMinutes + liveElapsedMinutes,
      days: weekActivity.days.map((day) => (day.isToday ? { ...day, totalMinutes: day.totalMinutes + liveElapsedMinutes } : day))
    };
  }, [weekActivity, liveElapsedMinutes]);

  return (
    <div className="wk-card wk-clock-home-card">
      {gpsPermission === 'prompt' && (
        <div className="wk-return-notice" role="status">
          <h2 className="wk-return-notice-title">{t.gpsGrantTitle}</h2>
          <p className="wk-return-reason-text">{t.gpsGrantBody}</p>
          <button type="button" className="wk-action-button" onClick={() => void handleGrantGps()}>
            {t.gpsGrantButton}
          </button>
        </div>
      )}
      {gpsPermission === 'denied' && (
        <div className="wk-return-notice" role="alert">
          <h2 className="wk-return-notice-title">{t.gpsDeniedTitle}</h2>
          <p className="wk-return-reason-text">{t.gpsDeniedBody}</p>
        </div>
      )}

      {gpsWaitSecondsLeft !== null && (
        <div className="wk-return-notice" role="status" aria-live="polite">
          <h2 className="wk-return-notice-title">{t.gpsWaitTitle}</h2>
          <p className="wk-return-reason-text">{t.gpsWaitBody(gpsWaitSecondsLeft)}</p>
          <button type="button" className="wk-clock-secondary-button" onClick={skipGpsWait}>
            {t.gpsWaitProceed}
          </button>
        </div>
      )}

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
            <span className={`wk-status-dot ${pendingCount > 0 ? 'amber' : 'online'}`} aria-hidden="true" />
            <span>{t.statusSync}</span>
            <strong>{syncSummary}</strong>
          </p>
          <p>
            <span className={`wk-status-dot ${gpsStatus === 'READY' ? 'online' : gpsStatus === 'CHECKING' ? 'amber' : gpsStatus === 'IDLE' ? 'offline' : 'warn'}`} aria-hidden="true" />
            <span>{t.statusGps}</span>
            <strong>{gpsSummary}</strong>
          </p>
          {showZoneStatus && (
            <p>
              <span className={`wk-status-dot ${zoneStatus === 'INSIDE' ? 'online' : zoneStatus === 'OUTSIDE' ? 'warn' : zoneStatus === 'CHECKING' ? 'amber' : 'offline'}`} aria-hidden="true" />
              <span>{t.statusZone}</span>
              <strong>{zoneSummary}</strong>
            </p>
          )}
        </div>
      </button>

      {canOpenAssignmentSheet && (
        <button type="button" className="wk-inline-secondary" onClick={() => setAssignmentSheetOpen(true)} disabled={busy}>
          {t.changeWorkplace}
        </button>
      )}

      {(gpsPermission === 'granted' || gpsPermission === 'unsupported' || gpsPermission === null) && (
        <p className="wk-gps-accuracy">
          {bestAccuracyM === null
            ? t.gpsAccuracyUnknown
            : bestAccuracyM <= 75
              ? t.gpsAccuracyGood(Math.round(bestAccuracyM))
              : t.gpsAccuracyPoor(Math.round(bestAccuracyM))}
          {bestAccuracyM !== null && bestAccuracyM > 75 ? (
            <button type="button" className="wk-inline-secondary" onClick={() => void handleRefineGps()} disabled={refiningGps}>
              {refiningGps ? t.gpsRefining : t.gpsRefine}
            </button>
          ) : null}
        </p>
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

      {/* T15 — a permanently-failed check-in/out used to render a red banner here. It now lives
          only in the notification bell (WorkerNotificationBell), never on the clock screen. */}

      <section className="wk-time-preview" aria-labelledby="wk-time-preview-title">
        <div className="wk-time-preview-heading">
          <h2 id="wk-time-preview-title">{t.timeCardTitle}</h2>
          {displayWeekActivity ? <span>{formatWorkedDuration(displayWeekActivity.totalMinutes, locale)}</span> : null}
        </div>

        {timeCardHref ? (
          <WorkerLink href={timeCardHref} className="wk-time-preview-link">
            <span>{t.viewAndEditHours}</span>
            <span aria-hidden="true">→</span>
          </WorkerLink>
        ) : null}

        {displayWeekActivity ? (
          <ol className="wk-week-grid">
            {displayWeekActivity.days.map((day) => {
              const body = (
                <>
                  <span className="wk-week-day-label">{day.label}</span>
                  <span className="wk-week-day-hours">{day.totalMinutes > 0 ? formatWorkedDuration(day.totalMinutes, locale) : '—'}</span>
                </>
              );
              return (
                <li key={day.date} className={`wk-week-day${day.isToday ? ' today' : ''}`}>
                  {day.href ? (
                    <WorkerLink href={day.href} className="wk-week-day-link">
                      {body}
                    </WorkerLink>
                  ) : (
                    <span className="wk-week-day-link wk-week-day-link-disabled">{body}</span>
                  )}
                </li>
              );
            })}
          </ol>
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
            {showZoneStatus && <p className="wk-status-sheet-line">{t.statusZone}: {zoneSummary}</p>}
            <button type="button" className="wk-clock-secondary-button" onClick={handleManualSync} disabled={syncing || setupNotReady}>
              {syncing ? t.syncing : t.syncNow}
            </button>
            <button type="button" className="wk-clock-cancel-button" onClick={() => setStatusSheetOpen(false)}>
              {t.close}
            </button>
          </div>
        </>
      )}

      {outsideZonePrompt && (
        <>
          {/* T17 — deliberately NOT dismissible: no backdrop onClick, no Escape, no ✕. One of the
              two buttons must be pressed. */}
          <div className="wk-overlay-backdrop" aria-hidden="true" />
          <div className="wk-overlay-sheet" role="alertdialog" aria-modal="true" aria-label={t.outsideZoneTitle}>
            <p className="wk-overlay-title">{t.outsideZoneTitle}</p>
            <p className="wk-return-reason-text">{t.outsideZoneBody(outsideZonePrompt.siteName)}</p>
            <div className="wk-switch-actions">
              <button type="button" className="wk-action-button" onClick={() => answerOutsideZone(true)}>
                {t.outsideZoneProceed}
              </button>
              <button type="button" className="wk-clock-cancel-button" onClick={() => answerOutsideZone(false)}>
                {t.outsideZoneCancel}
              </button>
            </div>
          </div>
        </>
      )}

    </div>
  );
}

// T14 — split a capture into the three outbox GPS fields. A FRESH fix rides as `gps` (the server
// can verify it against the geofence). An APPROXIMATE fix (OS-cached / device last-good) rides as
// `gpsApproximate` with `gps` null — the server stores it as an approximate ClockEventLocation and
// never runs it through geofence verification. No fix at all: just the reason.
function outboxGpsFields(snap: GpsSnapshot): { gps: OutboxGps | null; gpsUnavailableReason: OutboxGpsUnavailableReason | null; gpsApproximate: OutboxApproximateGps | null } {
  if (snap.location && !snap.approximate) {
    return { gps: snap.location, gpsUnavailableReason: null, gpsApproximate: null };
  }
  if (snap.location && snap.approximate) {
    return {
      gps: null,
      gpsUnavailableReason: snap.gpsUnavailableReason ?? 'POSITION_UNAVAILABLE',
      gpsApproximate: { latitude: snap.location.latitude, longitude: snap.location.longitude, accuracyMeters: snap.location.accuracyMeters, fixAgeSeconds: snap.fixAgeSeconds, capturedAfterEventSeconds: null }
    };
  }
  return { gps: null, gpsUnavailableReason: snap.gpsUnavailableReason, gpsApproximate: null };
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
