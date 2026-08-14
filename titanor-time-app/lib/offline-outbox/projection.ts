// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §6/task §7 "Response application" — combines
// the last-known AUTHORITATIVE server clock-state with the still-unconfirmed outbox tail
// (PENDING/SENDING only, ordered by deviceSequence) into what the UI should show right now.
// IndexedDB/local state is only ever this projection — never a substitute source of truth.

import type { OutboxEventRecord } from './db';
import type { ClockStateWire } from './sync-runner';

export interface ProjectedClockState {
  state: 'CLOCKED_OUT' | 'CLOCKED_IN';
  siteId: string | null;
  siteName: string | null;
  workAreaId: string | null;
  workAreaName: string | null;
  openedAt: string | null;
  isProjected: boolean; // true when at least one still-unconfirmed outbox event was layered on top
}

export function projectClockState(
  authoritative: ClockStateWire,
  pendingSortedByDeviceSequence: OutboxEventRecord[],
  lookupSiteName: (siteId: string) => string | null,
  lookupWorkAreaName: (workAreaId: string | null) => string | null
): ProjectedClockState {
  let state: 'CLOCKED_OUT' | 'CLOCKED_IN' = authoritative.state;
  let siteId = authoritative.openShift?.siteId ?? null;
  let siteName = authoritative.openShift?.siteName ?? null;
  let workAreaId = authoritative.openShift?.workAreaId ?? null;
  let workAreaName = authoritative.openShift?.workAreaName ?? null;
  let openedAt = authoritative.openShift?.openedAt ?? null;

  // Only PENDING/SENDING should ever reach this function — FAILED_TERMINAL must not continue to
  // project optimistically (task §7 "FAILED_TERMINAL не должен продолжать optimistic projection").
  for (const event of pendingSortedByDeviceSequence) {
    if (event.operationType === 'CHECK_IN') {
      state = 'CLOCKED_IN';
      siteId = event.siteId;
      siteName = lookupSiteName(event.siteId);
      workAreaId = event.workAreaId;
      workAreaName = lookupWorkAreaName(event.workAreaId);
      openedAt = event.clientCapturedAt;
    } else {
      state = 'CLOCKED_OUT';
      siteId = null;
      siteName = null;
      workAreaId = null;
      workAreaName = null;
      openedAt = null;
    }
  }

  return { state, siteId, siteName, workAreaId, workAreaName, openedAt, isProjected: pendingSortedByDeviceSequence.length > 0 };
}
