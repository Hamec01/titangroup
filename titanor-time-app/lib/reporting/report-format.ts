// docs/titanor-time/T8_REPORTS_DESIGN.md — presentation-only helpers shared by every T8 report UI
// (T8.1 /admin/reports, T8.2B /admin/reports/sites and /foreman/reports/sites). Moved here from
// the T8.1-only lib/worker-time-report-ui.ts so a second report never grows a second copy of the
// same formatting logic — same core/UI split already used by lib/attendance-overview.ts vs
// lib/attendance-overview-ui.ts.

import { computeSegmentMs, msToMinutes, sumWorkedTimeMs } from '@/lib/reporting/worked-time';
import type { AppLocale } from '@/lib/i18n/locale';

export interface IsoWorkedTimeSegment {
  startAt: string;
  endAt: string;
  breaks: { startAt: string; endAt: string; paid: boolean }[];
}

/** Shared presentation adapter for draft/version DTOs whose timestamps are serialized ISO strings. */
export function workedMinutesFromIsoSegments(segments: IsoWorkedTimeSegment[]): number {
  return msToMinutes(
    sumWorkedTimeMs(
      segments.map((segment) =>
        computeSegmentMs({
          startAt: new Date(segment.startAt),
          endAt: new Date(segment.endAt),
          breaks: segment.breaks.map((item) => ({ startAt: new Date(item.startAt), endAt: new Date(item.endAt), paid: item.paid }))
        })
      )
    ).workedMs
  );
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
