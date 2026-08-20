import { formatWorkedDuration } from '@/lib/reporting/report-format';

const STATUS_LABELS: Record<string, string> = {
  RETURNED: 'Returned — needs your attention',
  SUBMITTED: 'Submitted — awaiting review',
  FOREMAN_APPROVED: 'Review complete — awaiting final approval',
  FINAL_APPROVED: 'Finalized'
};

/** A DRAFT describes workflow state, not whether it contains time. Never call a populated draft
 * "Not started": that hid successfully materialized Check In/Out time from workers. */
export function workerTimesheetStatusLabel(status: string, totalMinutes = 0): string {
  if (status === 'DRAFT') {
    return totalMinutes > 0 ? `In progress · ${formatWorkedDuration(totalMinutes)}` : 'Not started';
  }
  return STATUS_LABELS[status] ?? status;
}
