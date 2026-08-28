// docs/titanor-time/T8_REPORTS_DESIGN.md — presentation-only helpers shared by every T8 report UI
// (T8.1 /admin/reports, T8.2B /admin/reports/sites and /foreman/reports/sites). Moved here from
// the T8.1-only lib/worker-time-report-ui.ts so a second report never grows a second copy of the
// same formatting logic — same core/UI split already used by lib/attendance-overview.ts vs
// lib/attendance-overview-ui.ts.

import { computeSegmentMs, computeDayWorkedMs, msToMinutes, sumWorkedTimeMs, DEFAULT_AUTO_UNPAID_BREAK_THRESHOLD_MINUTES } from '@/lib/reporting/worked-time';
import type { AppLocale } from '@/lib/i18n/locale';

export interface IsoWorkedTimeSegment {
  startAt: string;
  endAt: string;
  breaks: { startAt: string; endAt: string; paid: boolean }[];
}

function toDateSegments(segments: IsoWorkedTimeSegment[]) {
  return segments.map((segment) => ({
    startAt: new Date(segment.startAt),
    endAt: new Date(segment.endAt),
    breaks: segment.breaks.map((item) => ({ startAt: new Date(item.startAt), endAt: new Date(item.endAt), paid: item.paid }))
  }));
}

/** Shared presentation adapter for draft/version DTOs whose timestamps are serialized ISO strings.
 *  Segment-level only (no T10-D auto unpaid-lunch) — use workedDayMinutesFromIso for a single day's
 *  worth of segments when the planned break is known, or when summing a whole timesheet where each
 *  day was already adjusted upstream. */
export function workedMinutesFromIsoSegments(segments: IsoWorkedTimeSegment[]): number {
  return msToMinutes(sumWorkedTimeMs(toDateSegments(segments).map((s) => computeSegmentMs(s))).workedMs);
}

/** T10-D — one day's worked minutes, WITH the automatic unpaid-lunch deduction (see
 *  computeDayWorkedMs). `plannedUnpaidBreakMinutes` is that day's planned break when unpaid (0 if
 *  paid / no plan); `grossThresholdMinutes` is CompanyAttendancePolicy.autoUnpaidBreakThresholdMinutes. */
export function workedDayMinutesFromIso(
  daySegments: IsoWorkedTimeSegment[],
  plannedUnpaidBreakMinutes: number,
  grossThresholdMinutes: number = DEFAULT_AUTO_UNPAID_BREAK_THRESHOLD_MINUTES
): number {
  return msToMinutes(computeDayWorkedMs(toDateSegments(daySegments), { plannedUnpaidBreakMinutes, grossThresholdMinutes }).workedMs);
}

/** "X h Y min" exactly, per the T8.1 task spec (reused verbatim by every later report). Negative
 * input is structurally impossible — every caller passes a value built from
 * computeSegmentMs/msToMinutes (lib/reporting/worked-time.ts), which never produces a negative
 * worked/gross/break minute count for well-formed segments. */
export function formatWorkedDuration(minutes: number, locale: AppLocale = 'EN'): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return locale === 'RU' ? `${h} ч ${m} мин` : `${h} h ${m} min`;
}

const TIMESHEET_STATUS_LABELS: Record<string, { en: string; ru: string }> = {
  DRAFT: { en: 'Draft', ru: 'Черновик' },
  SUBMITTED: { en: 'Submitted', ru: 'Отправлен' },
  RETURNED: { en: 'Returned', ru: 'Возвращён' },
  FOREMAN_APPROVED: { en: 'Review approved', ru: 'Проверка одобрена' },
  FINAL_APPROVED: { en: 'Final approved', ru: 'Окончательно одобрен' }
};

export function timesheetStatusLabel(status: string, locale: AppLocale = 'EN'): string {
  const entry = TIMESHEET_STATUS_LABELS[status];
  if (!entry) return status;
  return locale === 'RU' ? entry.ru : entry.en;
}

export function dataSourceLabel(dataSource: 'DRAFT' | 'CURRENT_VERSION', versionNumber: number | null, locale: AppLocale = 'EN'): string {
  if (dataSource === 'DRAFT') return locale === 'RU' ? 'Черновые данные' : 'Draft data';
  return locale === 'RU' ? `Неизменяемая версия ${versionNumber ?? '?'}` : `Immutable version ${versionNumber ?? '?'}`;
}

export function submissionSourceLabel(source: string | null, locale: AppLocale = 'EN'): string | null {
  if (!source) return null;
  if (source === 'MANUAL') return locale === 'RU' ? 'Вручную' : 'Manual';
  if (source === 'AUTO') return locale === 'RU' ? 'Автоматически' : 'Automatic';
  return source;
}
