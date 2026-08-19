// docs/titanor-time/T8_REPORTS_DESIGN.md — presentation-only helpers shared by every T8 report UI
// (T8.1 /admin/reports, T8.2B /admin/reports/sites and /foreman/reports/sites). Moved here from
// the T8.1-only lib/worker-time-report-ui.ts so a second report never grows a second copy of the
// same formatting logic — same core/UI split already used by lib/attendance-overview.ts vs
// lib/attendance-overview-ui.ts.

/** "X h Y min" exactly, per the T8.1 task spec (reused verbatim by every later report). Negative
 * input is structurally impossible — every caller passes a value built from
 * computeSegmentMs/msToMinutes (lib/reporting/worked-time.ts), which never produces a negative
 * worked/gross/break minute count for well-formed segments. */
export function formatWorkedDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h} h ${m} min`;
}

const TIMESHEET_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  RETURNED: 'Returned',
  FOREMAN_APPROVED: 'Foreman approved',
  FINAL_APPROVED: 'Final approved'
};

export function timesheetStatusLabel(status: string): string {
  return TIMESHEET_STATUS_LABELS[status] ?? status;
}

export function dataSourceLabel(dataSource: 'DRAFT' | 'CURRENT_VERSION', versionNumber: number | null): string {
  return dataSource === 'DRAFT' ? 'Draft data' : `Immutable version ${versionNumber ?? '?'}`;
}

export function submissionSourceLabel(source: string | null): string | null {
  if (!source) return null;
  return source === 'MANUAL' ? 'Manual' : source === 'AUTO' ? 'Automatic' : source;
}
