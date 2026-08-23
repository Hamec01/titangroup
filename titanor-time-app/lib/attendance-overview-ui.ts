import type { OperationalState } from '@/lib/attendance-overview';
import type { AppLocale } from '@/lib/i18n/locale';

// T7A.9B — pure presentation-only label/formatting helpers for the /admin and /foreman overview
// pages, mirroring lib/attendance-exceptions-ui.ts's split (no scope/filter/aggregation logic
// here — that stays exclusively in lib/attendance-overview.ts). Shared verbatim by the admin and
// foreman overview views, which differ only in scope/links, not in how a given value is labelled.

const OPERATIONAL_STATE_LABELS: Record<OperationalState, { en: string; ru: string }> = {
  WORKING_NOW: { en: 'Working now', ru: 'Сейчас на смене' },
  FINISHED_TODAY: { en: 'Finished today', ru: 'Завершил сегодня' },
  MISSING_CHECKOUT: { en: 'Missing checkout', ru: 'Нет ухода' },
  GPS_ISSUE: { en: 'GPS issue', ru: 'Проблема с GPS' },
  SYNC_ISSUE: { en: 'Sync issue', ru: 'Проблема синхронизации' },
  DRAFT: { en: 'Draft', ru: 'Черновик' },
  SUBMITTED_MANUAL: { en: 'Submitted manually', ru: 'Отправлен вручную' },
  SUBMITTED_AUTO: { en: 'Submitted automatically', ru: 'Отправлен автоматически' },
  AWAITING_FOREMAN: { en: 'Awaiting foreman', ru: 'Ожидает прораба' },
  RETURNED: { en: 'Returned', ru: 'Возвращён' },
  READY_FOR_FINAL_APPROVAL: { en: 'Ready for final approval', ru: 'Готов к окончательному одобрению' },
  FINAL_APPROVED: { en: 'Final approved', ru: 'Окончательно одобрен' },
  CORRECTION_OPEN: { en: 'Correction open', ru: 'Открыта корректировка' }
};

export function operationalStateLabel(state: OperationalState, locale: AppLocale = 'EN'): string {
  const entry = OPERATIONAL_STATE_LABELS[state];
  if (!entry) return state;
  return locale === 'RU' ? entry.ru : entry.en;
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

const FINAL_APPROVAL_BLOCKED_REASON_LABELS: Record<string, { en: string; ru: string }> = {
  TIMESHEET_NOT_SUBMITTED: { en: 'Timesheet not submitted yet', ru: 'Табель ещё не отправлен' },
  PENDING_SITE_REVIEW: { en: 'Waiting on site foreman review', ru: 'Ожидает проверки прорабом объекта' },
  PENDING_NON_SITE_REVIEW: { en: 'Waiting on non-site foreman review', ru: 'Ожидает проверки прорабом вне объекта' },
  RETURNED_SCOPE: { en: 'A review scope was returned', ru: 'Раздел проверки был возвращён' },
  OPEN_ATTENDANCE_EXCEPTION: { en: 'Has an open attendance exception', ru: 'Есть открытое исключение учёта' },
  OPEN_CORRECTION: { en: 'Has an open correction request', ru: 'Есть открытый запрос на корректировку' },
  AUTO_SUBMITTED_WITH_EXCEPTIONS: { en: 'Auto-submitted while an exception was open', ru: 'Отправлен автоматически при открытом исключении' }
};

/** Never hides an unrecognized future code (task §8) — falls back to a readable rendering of the
 * raw code instead of silently dropping it. */
export function finalApprovalBlockedReasonLabel(code: string, locale: AppLocale = 'EN'): string {
  const entry = FINAL_APPROVAL_BLOCKED_REASON_LABELS[code];
  if (entry) {
    return locale === 'RU' ? entry.ru : entry.en;
  }
  return code
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function submissionSourceLabel(source: string, locale: AppLocale = 'EN'): string {
  switch (source) {
    case 'MANUAL':
      return locale === 'RU' ? 'Вручную' : 'Manual';
    case 'AUTO':
      return locale === 'RU' ? 'Автоматически' : 'Automatic';
    default:
      return source;
  }
}

const CORRECTION_STATUS_LABELS: Record<string, { en: string; ru: string }> = {
  PENDING: { en: 'Pending', ru: 'Ожидание' },
  DRAFT_OPEN: { en: 'Draft open', ru: 'Черновик открыт' },
  SUBMITTED: { en: 'Submitted', ru: 'Отправлен' },
  APPROVED: { en: 'Approved', ru: 'Одобрено' },
  REJECTED: { en: 'Rejected', ru: 'Отклонено' }
};

export function correctionStatusLabel(status: string, locale: AppLocale = 'EN'): string {
  const entry = CORRECTION_STATUS_LABELS[status];
  if (!entry) return status;
  return locale === 'RU' ? entry.ru : entry.en;
}

/** Signed hours+minutes, e.g. `+2h 5m` / `-1h 30m` / `0m` — never loses the sign, never re-derives
 * from raw intervals (task §9: the number comes from the backend `diff`, this only formats it). */
export function formatSignedMinutes(minutes: number, locale: AppLocale = 'EN'): string {
  const sign = minutes > 0 ? '+' : minutes < 0 ? '-' : '';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const hUnit = locale === 'RU' ? 'ч' : 'h';
  const mUnit = locale === 'RU' ? 'м' : 'm';
  if (h === 0) {
    return `${sign}${m}${mUnit}`;
  }
  return `${sign}${h}${hUnit} ${m}${mUnit}`;
}

export function formatMinutes(minutes: number, locale: AppLocale = 'EN'): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hUnit = locale === 'RU' ? 'ч' : 'h';
  const mUnit = locale === 'RU' ? 'м' : 'm';
  return h === 0 ? `${m}${mUnit}` : `${h}${hUnit} ${m}${mUnit}`;
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
