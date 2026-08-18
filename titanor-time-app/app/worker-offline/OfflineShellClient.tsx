'use client';

import { useEffect, useState } from 'react';
import { getDeviceState, getLocalClockState } from '@/lib/offline-outbox/db';
import type { ClockStateWire } from '@/lib/offline-outbox/sync-runner';
import { WorkerClockPanel, type ClockPanelAssignment } from '../worker/WorkerClockPanel';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10C.1" §C — the offline shell's
// only job is turning IndexedDB reads into the exact same props WorkerClockPanel already accepts
// from the server on the online page. No enqueue/sync/projection/bootstrap logic is reimplemented
// here — WorkerClockPanel's own mount effect calls the same ensureDeviceBootstrapped()/
// triggerSync() it always does, this component only supplies its INITIAL props from a different
// source. Renders nothing but a loading/not-ready message until this read completes — no action
// button exists before that, on top of atomicEnqueue's own DEVICE_NOT_BOOTSTRAPPED fail-closed
// check (defense in depth, not the only gate).

function todayLabelNow(): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
}

type ReadState = { kind: 'loading' } | { kind: 'not-bootstrapped' } | { kind: 'ready'; initialClockState: ClockStateWire; assignments: ClockPanelAssignment[] };

export function OfflineShellClient() {
  const [state, setState] = useState<ReadState>({ kind: 'loading' });

  useEffect(() => {
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

  if (state.kind === 'loading') {
    return (
      <div className="wk-card">
        <p role="status" aria-live="polite">
          Loading…
        </p>
      </div>
    );
  }

  if (state.kind === 'not-bootstrapped') {
    return (
      <div className="wk-card">
        <p role="status" aria-live="polite">
          Offline setup is not ready. Connect to the internet once, open the app, and try again.
        </p>
      </div>
    );
  }

  return (
    <WorkerClockPanel
      initialClockState={state.initialClockState}
      assignments={state.assignments}
      workerName={null}
      todayLabel={todayLabelNow()}
      periodsHref={null}
      historyHref={null}
    />
  );
}
