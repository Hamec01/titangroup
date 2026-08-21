import type { OperationalState } from '@/lib/attendance-overview';

// T7A.9B — pure presentation-only label/formatting helpers for the /admin and /foreman overview
// pages, mirroring lib/attendance-exceptions-ui.ts's split (no scope/filter/aggregation logic
// here — that stays exclusively in lib/attendance-overview.ts). Shared verbatim by the admin and
// foreman overview views, which differ only in scope/links, not in how a given value is labelled.

const OPERATIONAL_STATE_LABELS: Record<OperationalState, string> = {
  WORKING_NOW: 'Working now',
  FINISHED_TODAY: 'Finished today',
  MISSING_CHECKOUT: 'Missing checkout',
  GPS_ISSUE: 'GPS issue',
  SYNC_ISSUE: 'Sync issue',
  DRAFT: 'Draft',
  SUBMITTED_MANUAL: 'Submitted manually',
  SUBMITTED_AUTO: 'Submitted automatically',
  AWAITING_FOREMAN: 'Awaiting foreman',
  RETURNED: 'Returned',
  READY_FOR_FINAL_APPROVAL: 'Ready for final approval',
  FINAL_APPROVED: 'Final approved',
  CORRECTION_OPEN: 'Correction open'
};

export function operationalStateLabel(state: OperationalState): string {
  return OPERATIONAL_STATE_LABELS[state] ?? state;
}

const ISSUE_STATES = new Set<OperationalState>(['MISSING_CHECKOUT', 'GPS_ISSUE', 'SYNC_ISSUE', 'RETURNED', 'CORRECTION_OPEN']);
const POSITIVE_STATES = new Set<OperationalState>(['WORKING_NOW', 'FINISHED_TODAY', 'READY_FOR_FINAL_APPROVAL', 'FINAL_APPROVED']);

/** Status is never conveyed by color alone (task §13) — this only adds a visual accent on top of
 * the always-present text label above. */
export function operationalStateBadgeClass(state: OperationalState): string {
  if (ISSUE_STATES.has(state)) return 'ov-badge ov-badge-issue';
  if (POSITIVE_STATES.has(state)) return 'ov-badge ov-badge-positive';
  return 'ov-badge ov-badge-neutral';
}

const FINAL_APPROVAL_BLOCKED_REASON_LABELS: Record<string, string> = {
  TIMESHEET_NOT_SUBMITTED: 'Timesheet not submitted yet',
  PENDING_SITE_REVIEW: 'Waiting on site foreman review',
  PENDING_NON_SITE_REVIEW: 'Waiting on non-site foreman review',
  RETURNED_SCOPE: 'A review scope was returned',
  OPEN_ATTENDANCE_EXCEPTION: 'Has an open attendance exception',
  OPEN_CORRECTION: 'Has an open correction request',
  AUTO_SUBMITTED_WITH_EXCEPTIONS: 'Auto-submitted while an exception was open'
};

/** Never hides an unrecognized future code (task §8) — falls back to a readable rendering of the
 * raw code instead of silently dropping it. */
export function finalApprovalBlockedReasonLabel(code: string): string {
  if (FINAL_APPROVAL_BLOCKED_REASON_LABELS[code]) {
    return FINAL_APPROVAL_BLOCKED_REASON_LABELS[code];
  }
  return code
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function submissionSourceLabel(source: string): string {
  switch (source) {
    case 'MANUAL':
      return 'Manual';
    case 'AUTO':
      return 'Automatic';
    default:
      return source;
  }
}

const CORRECTION_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pending',
  DRAFT_OPEN: 'Draft open',
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  REJECTED: 'Rejected'
};

export function correctionStatusLabel(status: string): string {
  return CORRECTION_STATUS_LABELS[status] ?? status;
}

/** Signed hours+minutes, e.g. `+2h 5m` / `-1h 30m` / `0m` — never loses the sign, never re-derives
 * from raw intervals (task §9: the number comes from the backend `diff`, this only formats it). */
export function formatSignedMinutes(minutes: number): string {
  const sign = minutes > 0 ? '+' : minutes < 0 ? '-' : '';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h === 0) {
    return `${sign}${m}m`;
  }
  return `${sign}${h}h ${m}m`;
}

export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m}m` : `${h}h ${m}m`;
}

/** Builds a `?a=b&c=d` query string from a plain filter/pagination record, dropping
 * null/undefined/empty-string entries. */
export function buildOverviewQueryString(params: Record<string, string | number | null | undefined>): string {
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
