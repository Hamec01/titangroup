import type { ExceptionStatusFilter, ExceptionTypeFilter } from '@/lib/attendance-exceptions';
import { formatHelsinkiDateTime } from '@/lib/helsinki-datetime';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §11 — T7A.8C.1 UI foundation. Pure,
// presentation-only label/formatting helpers shared by the admin and foreman exception list/detail
// pages. No scope/filter/pagination logic lives here — that stays exclusively in
// lib/attendance-exceptions.ts (listAttendanceExceptions/parseExceptionListQuery/etc.), reused
// as-is by the pages that import this module.

export const EXCEPTION_TYPE_LABELS: Record<ExceptionTypeFilter, string> = {
  GPS_NOT_VERIFIED: 'GPS not verified',
  OUTSIDE_GEOFENCE_CHECKOUT: 'Checked out outside geofence',
  SITE_MISMATCH_CHECKOUT: 'Site mismatch at checkout',
  DOUBLE_CHECK_IN: 'Double check-in',
  CHECKOUT_WITHOUT_OPEN_SHIFT: 'Checkout without open shift',
  STALE_ASSIGNMENT: 'Stale assignment',
  GEOFENCE_VERSION_MISMATCH: 'Geofence version mismatch',
  LATE_SYNC_AFTER_SUBMIT: 'Late sync after submit',
  MISSING_CHECKOUT_AT_CUTOFF: 'Missing checkout at cutoff',
  EXCESSIVE_CLOCK_SKEW: 'Excessive clock skew',
  CHECKOUT_CHRONOLOGY_ANOMALY: 'Checkout chronology anomaly',
  EXCESSIVE_SHIFT_DURATION: 'Excessive shift duration',
  PERIOD_BOUNDARY_SPAN: 'Period boundary span',
  OVERLAPPING_SHIFT: 'Overlapping shift'
};

export function exceptionTypeLabel(type: string): string {
  return EXCEPTION_TYPE_LABELS[type as ExceptionTypeFilter] ?? type;
}

const EXCEPTION_STATUS_LABELS: Record<ExceptionStatusFilter, string> = {
  OPEN: 'Open',
  RESOLVED: 'Resolved',
  DISMISSED: 'Dismissed'
};

export function exceptionStatusLabel(status: string): string {
  return EXCEPTION_STATUS_LABELS[status as ExceptionStatusFilter] ?? status;
}

export function exceptionStatusBadgeClass(status: string): string {
  switch (status) {
    case 'OPEN':
      return 'exc-badge exc-badge-open';
    case 'RESOLVED':
      return 'exc-badge exc-badge-resolved';
    case 'DISMISSED':
      return 'exc-badge exc-badge-dismissed';
    default:
      return 'exc-badge';
  }
}

export function channelLabel(channel: string): string {
  switch (channel) {
    case 'ONLINE':
      return 'Online';
    case 'OFFLINE_SYNC':
      return 'Offline (synced)';
    default:
      return channel;
  }
}

export function gpsVerificationLabel(state: string): string {
  switch (state) {
    case 'VERIFIED_INSIDE':
      return 'Verified — inside geofence';
    case 'VERIFIED_OUTSIDE':
      return 'Verified — outside geofence';
    case 'NOT_VERIFIED':
      return 'Not verified';
    default:
      return state;
  }
}

export function gpsUnavailableReasonLabel(reason: string): string {
  switch (reason) {
    case 'PERMISSION_DENIED':
      return 'Location permission denied';
    case 'TIMEOUT':
      return 'Location request timed out';
    case 'POSITION_UNAVAILABLE':
      return 'Position unavailable';
    case 'LOW_ACCURACY':
      return 'Accuracy too low';
    default:
      return reason;
  }
}

export function operationTypeLabel(type: string): string {
  switch (type) {
    case 'CHECK_IN':
      return 'Check In';
    case 'CHECK_OUT':
      return 'Check Out';
    default:
      return type;
  }
}

export function materializationStateLabel(state: string): string {
  switch (state) {
    case 'PENDING':
      return 'Pending';
    case 'MATERIALIZED':
      return 'Materialized';
    default:
      return state;
  }
}

export function projectionStateLabel(state: string): string {
  switch (state) {
    case 'PENDING':
      return 'Pending';
    case 'SETTLED':
      return 'Settled';
    default:
      return state;
  }
}

export function timesheetStatusLabel(status: string): string {
  return status
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Attendance instants are stored in UTC and always displayed in the company timezone. Never use
 * the Node host's local timezone here: production runs in UTC while the company operates in
 * Europe/Helsinki (a three-hour difference during EEST). */
export function formatDateTime(iso: string): string {
  return formatHelsinkiDateTime(iso);
}

const DETAIL_KEY_LABELS: Record<string, string> = {
  distanceMeters: 'Distance (m)',
  accuracyMeters: 'GPS accuracy (m)',
  thresholdMeters: 'Threshold (m)',
  reason: 'Reason',
  clockSkewMs: 'Clock skew (ms)',
  assumedSiteId: 'Assumed site',
  authoritativeSiteId: 'Authoritative site',
  claimedEffectiveAt: 'Claimed time',
  openedAt: 'Opened at',
  clampedTo: 'Clamped to',
  durationHours: 'Duration (h)',
  thresholdHours: 'Threshold (h)',
  timesheetStatus: 'Timesheet status',
  triggeringClockShiftId: 'Triggering shift',
  cachedGeofenceVersionId: 'Cached geofence version',
  currentGeofenceVersionId: 'Current geofence version'
};

export function detailKeyLabel(key: string): string {
  return DETAIL_KEY_LABELS[key] ?? key;
}

/** Builds a `?a=b&c=d` query string from a plain filter/pagination record, dropping
 * null/undefined/empty-string entries — the one piece of URL-building logic shared by every
 * pagination/filter link on the list pages, kept here so it isn't hand-rolled four times. */
export function buildExceptionsQueryString(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') {
      continue;
    }
    search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}
