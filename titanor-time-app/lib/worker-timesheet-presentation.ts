import { formatWorkedDuration } from '@/lib/reporting/report-format';
import { COMMON_STRINGS } from '@/lib/i18n/common';
import type { AppLocale } from '@/lib/i18n/locale';

/** A DRAFT describes workflow state, not whether it contains time. Never call a populated draft
 * "Not started": that hid successfully materialized Check In/Out time from workers. */
export function workerTimesheetStatusLabel(status: string, totalMinutes = 0, locale: AppLocale = 'RU'): string {
  const t = COMMON_STRINGS[locale];
  if (status === 'DRAFT') {
    return totalMinutes > 0 ? `${t.statusInProgress} · ${formatWorkedDuration(totalMinutes)}` : t.statusNotStarted;
  }
  const labels: Record<string, string> = {
    RETURNED: t.statusReturned,
    SUBMITTED: t.statusSubmitted,
    FOREMAN_APPROVED: t.statusForemanApproved,
    FINAL_APPROVED: t.statusFinalApproved
  };
  return labels[status] ?? status;
}
