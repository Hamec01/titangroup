'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { ClockStateView } from '@/lib/attendance-clock';
import type { WorkerCurrentAssignment } from '@/lib/worker-context';
import { captureGpsSnapshot, type GpsSnapshot } from '@/lib/worker-gps';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §9.1-9.3/§14 (this is the online-only worker
// UI slice — offline outbox/§6 IndexedDB protocol is explicitly out of scope). Every mutating
// request carries this header (§14 "CSRF" threat mitigation, already enforced by the three POST
// routes).
const CSRF_HEADER_VALUE = 'titanor-time';
const FETCH_TIMEOUT_MS = 20000;

// ------------------------------------------------------------------------------------------------
// Attempt model (task brief §6 "Идемпотентность и неопределённый сетевой результат") — one immutable
// object per user click, held only in React memory until a terminal/reconciled result. A retry of
// the SAME action reuses these exact ids/timestamps/GPS snapshot; a fresh click always makes a new
// attempt with fresh ids. No durable outbox, no service worker, no IndexedDB (online-only).
// ------------------------------------------------------------------------------------------------

interface CheckInAttempt {
  kind: 'CHECK_IN';
  clientEventId: string;
  siteId: string;
  workAreaId: string | null;
  clientCapturedAt: string;
  gps: GpsSnapshot | null;
}

interface CheckOutAttempt {
  kind: 'CHECK_OUT';
  clientEventId: string;
  assumedSiteId: string;
  clientCapturedAt: string;
  gps: GpsSnapshot | null;
}

interface SwitchSiteAttempt {
  kind: 'SWITCH_SITE';
  groupId: string;
  checkOutClientEventId: string;
  checkInClientEventId: string;
  oldAssumedSiteId: string;
  newSiteId: string;
  newWorkAreaId: string | null;
  checkOutClientCapturedAt: string;
  checkInClientCapturedAt: string;
  gps: GpsSnapshot | null;
}

type PendingAttempt = CheckInAttempt | CheckOutAttempt | SwitchSiteAttempt;

type PanelPhase = 'IDLE' | 'LOCATING' | 'SUBMITTING' | 'RECONCILING' | 'AWAITING_RETRY';

interface StatusMessage {
  kind: 'info' | 'error';
  text: string;
  code?: string;
}

interface ApiEnvelopeError {
  error?: { code?: string; message?: string; fieldErrors?: Record<string, string[]> };
}

function assignmentKey(siteId: string, workAreaId: string | null): string {
  return `${siteId}::${workAreaId ?? ''}`;
}

function describeErrorCode(code: string | undefined): string {
  switch (code) {
    case 'OUTSIDE_GEOFENCE':
      return "You're outside this site's work area. Move closer and try again.";
    case 'SITE_NOT_FOUND':
      return 'This site is no longer available. Please reload the page.';
    case 'CLIENT_EVENT_ID_REUSED':
      return 'This request could not be completed. Please try again.';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'This action was already submitted.';
    case 'IDEMPOTENCY_KEY_IN_PROGRESS':
      return 'This action is still being processed. Please wait.';
    case 'NO_OPEN_SHIFT_TO_SWITCH':
      return "You're not currently clocked in anywhere.";
    case 'RATE_LIMITED':
      return 'Too many attempts. Please wait a moment and try again.';
    case 'CSRF_REJECTED':
      return 'Your session needs to be refreshed. Please reload the page.';
    case 'NO_EMPLOYEE_PROFILE':
      return 'Your account has no linked employee profile. Contact your administrator.';
    case 'NOT_AUTHENTICATED':
      return 'Your session has expired.';
    case 'FORBIDDEN':
      return "You don't have permission to do that.";
    case 'VALIDATION_ERROR':
      return 'Some information was invalid. Please reload and try again.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
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
  initialClockState: ClockStateView;
  assignments: WorkerCurrentAssignment[];
  workerName: string | null;
  todayLabel: string;
  periodsHref: string;
}

export function WorkerClockPanel({ initialClockState, assignments, workerName, todayLabel, periodsHref }: WorkerClockPanelProps) {
  const [clockState, setClockState] = useState<ClockStateView>(initialClockState);
  const [offsetMs, setOffsetMs] = useState(() => new Date(initialClockState.serverNow).getTime() - Date.now());
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [phase, setPhase] = useState<PanelPhase>('IDLE');
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string | null>(() => {
    if (assignments.length === 0) return null;
    const primary = assignments.find((a) => a.isPrimary);
    return (primary ?? assignments[0]).id;
  });
  const [switchPanelOpen, setSwitchPanelOpen] = useState(false);
  const [switchTargetId, setSwitchTargetId] = useState<string | null>(null);

  const phaseRef = useRef<PanelPhase>('IDLE');
  const attemptRef = useRef<PendingAttempt | null>(null);

  function setPhaseBoth(next: PanelPhase) {
    phaseRef.current = next;
    setPhase(next);
  }

  // Live shift duration — one tick per second while clocked in, never negative (clamped against
  // the server/client offset computed from the last known serverNow), interval always cleared.
  useEffect(() => {
    if (clockState.state !== 'CLOCKED_IN') {
      return;
    }
    const interval = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [clockState.state]);

  async function refreshClockState(): Promise<ClockStateView | null> {
    try {
      const res = await fetchWithTimeout('/api/worker/attendance/clock-state', { method: 'GET' });
      if (!res.ok) {
        return null;
      }
      const data = (await res.json()) as ClockStateView;
      setClockState(data);
      setOffsetMs(new Date(data.serverNow).getTime() - Date.now());
      setNowTick(Date.now());
      return data;
    } catch {
      return null;
    }
  }

  async function submitForAttempt(attempt: PendingAttempt): Promise<{ status: number; body: unknown }> {
    if (attempt.kind === 'CHECK_IN') {
      const res = await fetchWithTimeout('/api/worker/attendance/check-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({
          clientEventId: attempt.clientEventId,
          siteId: attempt.siteId,
          workAreaId: attempt.workAreaId,
          clientCapturedAt: attempt.clientCapturedAt,
          location: attempt.gps?.location ?? null,
          gpsUnavailableReason: attempt.gps?.gpsUnavailableReason ?? null
        })
      });
      return { status: res.status, body: await res.json() };
    }
    if (attempt.kind === 'CHECK_OUT') {
      const res = await fetchWithTimeout('/api/worker/attendance/check-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({
          clientEventId: attempt.clientEventId,
          assumedSiteId: attempt.assumedSiteId,
          clientCapturedAt: attempt.clientCapturedAt,
          location: attempt.gps?.location ?? null,
          gpsUnavailableReason: attempt.gps?.gpsUnavailableReason ?? null
        })
      });
      return { status: res.status, body: await res.json() };
    }
    const res = await fetchWithTimeout('/api/worker/attendance/switch-site', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
      body: JSON.stringify({
        groupId: attempt.groupId,
        checkOutClientEventId: attempt.checkOutClientEventId,
        checkInClientEventId: attempt.checkInClientEventId,
        oldAssumedSiteId: attempt.oldAssumedSiteId,
        newSiteId: attempt.newSiteId,
        newWorkAreaId: attempt.newWorkAreaId,
        checkOutClientCapturedAt: attempt.checkOutClientCapturedAt,
        checkInClientCapturedAt: attempt.checkInClientCapturedAt,
        checkOutLocation: attempt.gps?.location ?? null,
        checkOutGpsUnavailableReason: attempt.gps?.gpsUnavailableReason ?? null,
        checkInLocation: attempt.gps?.location ?? null,
        checkInGpsUnavailableReason: attempt.gps?.gpsUnavailableReason ?? null
      })
    });
    return { status: res.status, body: await res.json() };
  }

  /** §6 "network-unknown reconciliation" — GET clock-state and check whether it reflects this exact attempt already having landed, without ever re-running the attempt's own mutation. */
  async function reconcileAfterUnknown(attempt: PendingAttempt): Promise<boolean> {
    const fresh = await refreshClockState();
    if (!fresh) {
      return false;
    }
    if (attempt.kind === 'CHECK_IN') {
      return fresh.state === 'CLOCKED_IN' && fresh.openShift?.openedByClockEventId === attempt.clientEventId;
    }
    if (attempt.kind === 'CHECK_OUT') {
      return fresh.state === 'CLOCKED_OUT';
    }
    return fresh.state === 'CLOCKED_IN' && fresh.openShift?.openedByClockEventId === attempt.checkInClientEventId;
  }

  function successMessageFor(kind: PendingAttempt['kind']): string {
    if (kind === 'CHECK_IN') return 'Checked in.';
    if (kind === 'CHECK_OUT') return 'Checked out.';
    return 'Switched site.';
  }

  async function submitAttemptAndHandle(attempt: PendingAttempt) {
    setPhaseBoth('SUBMITTING');
    setStatusMessage({ kind: 'info', text: 'Submitting…' });
    try {
      const { status, body } = await submitForAttempt(attempt);
      if (status === 200 || status === 201) {
        attemptRef.current = null;
        setSwitchPanelOpen(false);
        setSwitchTargetId(null);
        await refreshClockState();
        setPhaseBoth('IDLE');
        setStatusMessage({ kind: 'info', text: successMessageFor(attempt.kind) });
        return;
      }
      const envelope = body as ApiEnvelopeError;
      const code = envelope?.error?.code;
      if (code === 'RATE_LIMITED') {
        setPhaseBoth('AWAITING_RETRY');
        setStatusMessage({ kind: 'error', text: describeErrorCode(code), code });
        return;
      }
      // Every other non-success response is terminal for this attempt (§7: "ошибки не должны
      // стирать выбранное назначение" — selectedAssignmentId/switchTargetId are left untouched).
      attemptRef.current = null;
      await refreshClockState();
      setPhaseBoth('IDLE');
      setStatusMessage({ kind: 'error', text: describeErrorCode(code), code });
    } catch {
      // fetch threw: network error, our own AbortController timeout, or invalid JSON — the HTTP
      // result is genuinely unknown, never assumed either way.
      setPhaseBoth('RECONCILING');
      setStatusMessage({ kind: 'info', text: 'Result unknown, checking current state…' });
      const confirmed = await reconcileAfterUnknown(attempt);
      if (confirmed) {
        attemptRef.current = null;
        setSwitchPanelOpen(false);
        setSwitchTargetId(null);
        setPhaseBoth('IDLE');
        setStatusMessage({ kind: 'info', text: successMessageFor(attempt.kind) });
      } else {
        setPhaseBoth('AWAITING_RETRY');
        setStatusMessage({ kind: 'error', text: "We couldn't confirm this action went through. You can safely retry." });
      }
    }
  }

  async function handleCheckIn() {
    if (phaseRef.current !== 'IDLE' || !selectedAssignmentId) {
      return;
    }
    const assignment = assignments.find((a) => a.id === selectedAssignmentId);
    if (!assignment) {
      return;
    }
    const attempt: CheckInAttempt = {
      kind: 'CHECK_IN',
      clientEventId: crypto.randomUUID(),
      siteId: assignment.siteId,
      workAreaId: assignment.workAreaId,
      clientCapturedAt: new Date().toISOString(),
      gps: null
    };
    attemptRef.current = attempt;
    setPhaseBoth('LOCATING');
    setStatusMessage({ kind: 'info', text: 'Getting location…' });
    attempt.gps = await captureGpsSnapshot();
    await submitAttemptAndHandle(attempt);
  }

  async function handleCheckOut() {
    if (phaseRef.current !== 'IDLE' || clockState.state !== 'CLOCKED_IN' || !clockState.openShift) {
      return;
    }
    const attempt: CheckOutAttempt = {
      kind: 'CHECK_OUT',
      clientEventId: crypto.randomUUID(),
      assumedSiteId: clockState.openShift.siteId,
      clientCapturedAt: new Date().toISOString(),
      gps: null
    };
    attemptRef.current = attempt;
    setPhaseBoth('LOCATING');
    setStatusMessage({ kind: 'info', text: 'Getting location…' });
    // §5.4 — Check Out is never blocked by a missing/failed GPS reading.
    attempt.gps = await captureGpsSnapshot();
    await submitAttemptAndHandle(attempt);
  }

  function openSwitchPanel() {
    if (phaseRef.current !== 'IDLE' || clockState.state !== 'CLOCKED_IN' || !clockState.openShift) {
      return;
    }
    const openShift = clockState.openShift;
    const alternates = assignments.filter((a) => assignmentKey(a.siteId, a.workAreaId) !== assignmentKey(openShift.siteId, openShift.workAreaId));
    setSwitchTargetId(alternates[0]?.id ?? null);
    setSwitchPanelOpen(true);
    setStatusMessage(null);
  }

  function closeSwitchPanel() {
    if (phaseRef.current !== 'IDLE') {
      return;
    }
    setSwitchPanelOpen(false);
    setSwitchTargetId(null);
  }

  async function handleConfirmSwitch() {
    if (phaseRef.current !== 'IDLE' || !switchTargetId || clockState.state !== 'CLOCKED_IN' || !clockState.openShift) {
      return;
    }
    const target = assignments.find((a) => a.id === switchTargetId);
    if (!target) {
      return;
    }
    const capturedAt = new Date().toISOString();
    const attempt: SwitchSiteAttempt = {
      kind: 'SWITCH_SITE',
      groupId: crypto.randomUUID(),
      checkOutClientEventId: crypto.randomUUID(),
      checkInClientEventId: crypto.randomUUID(),
      oldAssumedSiteId: clockState.openShift.siteId,
      newSiteId: target.siteId,
      newWorkAreaId: target.workAreaId,
      checkOutClientCapturedAt: capturedAt,
      checkInClientCapturedAt: capturedAt,
      gps: null
    };
    attemptRef.current = attempt;
    setPhaseBoth('LOCATING');
    setStatusMessage({ kind: 'info', text: 'Getting location…' });
    attempt.gps = await captureGpsSnapshot();
    await submitAttemptAndHandle(attempt);
  }

  async function handleRetry() {
    if (phaseRef.current !== 'AWAITING_RETRY' || !attemptRef.current) {
      return;
    }
    await submitAttemptAndHandle(attemptRef.current);
  }

  function handleCancelAttempt() {
    if (phaseRef.current !== 'AWAITING_RETRY') {
      return;
    }
    attemptRef.current = null;
    setPhaseBoth('IDLE');
    setStatusMessage(null);
  }

  const busy = phase !== 'IDLE';
  const openShift = clockState.openShift;
  const alternateAssignments = openShift ? assignments.filter((a) => assignmentKey(a.siteId, a.workAreaId) !== assignmentKey(openShift.siteId, openShift.workAreaId)) : [];
  const switchTarget = switchTargetId ? assignments.find((a) => a.id === switchTargetId) : undefined;
  const durationMs = openShift ? Math.max(0, nowTick + offsetMs - new Date(openShift.openedAt).getTime()) : 0;

  return (
    <div className="wk-card wk-clock-card">
      <div className="wk-clock-header">
        {workerName && <p className="wk-clock-worker-name">{workerName}</p>}
        <p className="wk-clock-today">{todayLabel}</p>
      </div>

      {clockState.state === 'CLOCKED_OUT' ? (
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
        openShift && (
          <>
            <p className="wk-clock-status-label wk-clock-status-in">Clocked in</p>
            <p className="wk-clock-site">{openShift.siteName}</p>
            {openShift.workAreaName && <p className="wk-clock-workarea">{openShift.workAreaName}</p>}
            <p className="wk-clock-since">Since {formatHelsinkiTime(openShift.openedAt)}</p>
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
                    From <strong>{openShift.siteName}</strong> to <strong>{switchTarget.siteName}</strong>
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
        )
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

      {statusMessage?.code === 'NOT_AUTHENTICATED' && (
        <Link href="/login" className="wk-back-link">
          Log in again →
        </Link>
      )}

      {phase === 'AWAITING_RETRY' && (
        <div className="wk-switch-actions">
          <button type="button" className="wk-action-button" onClick={handleRetry}>
            Retry
          </button>
          <button type="button" className="wk-clock-cancel-button" onClick={handleCancelAttempt}>
            Cancel
          </button>
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
