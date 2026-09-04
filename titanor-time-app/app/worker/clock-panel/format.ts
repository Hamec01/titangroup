// R09.7 — pure formatting/mapping helpers extracted verbatim from WorkerClockPanel.tsx so the panel
// file holds state + effects and these stay independently unit-testable. No behaviour change: every
// function here is byte-for-byte the logic it replaced.
import type { GpsSnapshot } from '@/lib/worker-gps';
import type { OutboxGps, OutboxApproximateGps, OutboxGpsUnavailableReason } from '@/lib/offline-outbox/db';

export interface StatusMessage {
  kind: 'info' | 'error';
  text: string;
  code?: string;
}

export type GpsUiState = 'IDLE' | 'CHECKING' | 'READY' | 'PERMISSION' | 'UNAVAILABLE';
export type ZoneStatus = 'UNKNOWN' | 'CHECKING' | 'INSIDE' | 'OUTSIDE' | 'LOW_ACCURACY' | 'NO_GEOFENCE' | 'UNAVAILABLE';

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
  /** R15 fixroad F03 — site flagged "GPS often unavailable here". Optional so an IndexedDB row
   *  cached before this field existed (offline shell) still satisfies the shape. Informational. */
  siteGpsOftenUnavailable?: boolean;
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

export function assignmentKey(siteId: string, workAreaId: string | null): string {
  return `${siteId}::${workAreaId ?? ''}`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

const helsinkiTimeFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function formatHelsinkiTime(iso: string): string {
  return helsinkiTimeFormatter.format(new Date(iso));
}

// T14 — split a capture into the three outbox GPS fields. A FRESH fix rides as `gps` (the server
// can verify it against the geofence). An APPROXIMATE fix (OS-cached / device last-good) rides as
// `gpsApproximate` with `gps` null — the server stores it as an approximate ClockEventLocation and
// never runs it through geofence verification. No fix at all: just the reason.
export function outboxGpsFields(snap: GpsSnapshot): { gps: OutboxGps | null; gpsUnavailableReason: OutboxGpsUnavailableReason | null; gpsApproximate: OutboxApproximateGps | null } {
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

export function resolveGpsUiState(snapshot: GpsSnapshot): GpsUiState {
  if (snapshot.location) {
    return 'READY';
  }
  if (snapshot.gpsUnavailableReason === 'PERMISSION_DENIED') {
    return 'PERMISSION';
  }
  return 'UNAVAILABLE';
}
