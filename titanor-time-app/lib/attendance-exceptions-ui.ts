import type { ExceptionStatusFilter, ExceptionTypeFilter } from '@/lib/attendance-exceptions';
import { formatHelsinkiDateTime } from '@/lib/helsinki-datetime';
import type { AppLocale } from '@/lib/i18n/locale';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §11 — T7A.8C.1 UI foundation. Pure,
// presentation-only label/formatting helpers shared by the admin and foreman exception list/detail
// pages. No scope/filter/pagination logic lives here — that stays exclusively in
// lib/attendance-exceptions.ts (listAttendanceExceptions/parseExceptionListQuery/etc.), reused
// as-is by the pages that import this module.

function pick(locale: AppLocale, en: string, ru: string): string {
  return locale === 'RU' ? ru : en;
}

const EXCEPTION_TYPE_LABELS: Record<ExceptionTypeFilter, { en: string; ru: string }> = {
  GPS_NOT_VERIFIED: { en: 'GPS not verified', ru: 'GPS не подтверждён' },
  OUTSIDE_GEOFENCE_CHECKIN: { en: 'Checked in outside geofence', ru: 'Приход зафиксирован вне геозоны' },
  OUTSIDE_GEOFENCE_CHECKOUT: { en: 'Checked out outside geofence', ru: 'Уход зафиксирован вне геозоны' },
  SITE_MISMATCH_CHECKOUT: { en: 'Site mismatch at checkout', ru: 'Несовпадение объекта при уходе' },
  DOUBLE_CHECK_IN: { en: 'Double check-in', ru: 'Повторный приход' },
  CHECKOUT_WITHOUT_OPEN_SHIFT: { en: 'Checkout without open shift', ru: 'Уход без открытой смены' },
  STALE_ASSIGNMENT: { en: 'Stale assignment', ru: 'Устаревшее назначение' },
  GEOFENCE_VERSION_MISMATCH: { en: 'Geofence version mismatch', ru: 'Несовпадение версии геозоны' },
  LATE_SYNC_AFTER_SUBMIT: { en: 'Late sync after submit', ru: 'Поздняя синхронизация после отправки' },
  MISSING_CHECKOUT_AT_CUTOFF: { en: 'Missing checkout at cutoff', ru: 'Нет ухода к моменту закрытия периода' },
  EXCESSIVE_CLOCK_SKEW: { en: 'Excessive clock skew', ru: 'Чрезмерное расхождение времени' },
  CHECKOUT_CHRONOLOGY_ANOMALY: { en: 'Checkout chronology anomaly', ru: 'Нарушение хронологии ухода' },
  EXCESSIVE_SHIFT_DURATION: { en: 'Excessive shift duration', ru: 'Чрезмерная длительность смены' },
  SHIFT_AUTO_CLOSED_MAX_DURATION: { en: 'Shift auto-closed (no checkout)', ru: 'Смена закрыта автоматически (нет ухода)' },
  PERIOD_BOUNDARY_SPAN: { en: 'Period boundary span', ru: 'Смена пересекает границу периода' },
  OVERLAPPING_SHIFT: { en: 'Overlapping shift', ru: 'Пересечение смен' }
};

export function exceptionTypeLabel(type: string, locale: AppLocale): string {
  const entry = EXCEPTION_TYPE_LABELS[type as ExceptionTypeFilter];
  if (!entry) return type;
  return locale === 'RU' ? entry.ru : entry.en;
}

const EXCEPTION_STATUS_LABELS: Record<ExceptionStatusFilter, { en: string; ru: string }> = {
  OPEN: { en: 'Open', ru: 'Открыто' },
  RESOLVED: { en: 'Resolved', ru: 'Решено' },
  // T12 — the DISMISS action is now surfaced as "Clear alert / Снять сигнал"; the terminal status
  // matches (it never meant "the hours were rejected").
  DISMISSED: { en: 'Cleared', ru: 'Снято' }
};

export function exceptionStatusLabel(status: string, locale: AppLocale): string {
  const entry = EXCEPTION_STATUS_LABELS[status as ExceptionStatusFilter];
  if (!entry) return status;
  return locale === 'RU' ? entry.ru : entry.en;
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

export function channelLabel(channel: string, locale: AppLocale): string {
  switch (channel) {
    case 'ONLINE':
      return pick(locale, 'Online', 'Онлайн');
    case 'OFFLINE_SYNC':
      return pick(locale, 'Offline (synced)', 'Оффлайн (синхронизировано)');
    default:
      return channel;
  }
}

export function gpsVerificationLabel(state: string, locale: AppLocale): string {
  switch (state) {
    case 'VERIFIED_INSIDE':
      return pick(locale, 'Verified — inside geofence', 'Подтверждено — внутри геозоны');
    case 'VERIFIED_OUTSIDE':
      return pick(locale, 'Verified — outside geofence', 'Подтверждено — вне геозоны');
    case 'NOT_VERIFIED':
      return pick(locale, 'Not verified', 'Не подтверждено');
    default:
      return state;
  }
}

export function gpsUnavailableReasonLabel(reason: string, locale: AppLocale): string {
  switch (reason) {
    case 'PERMISSION_DENIED':
      return pick(locale, 'Location permission denied', 'Доступ к геолокации запрещён');
    case 'TIMEOUT':
      return pick(locale, 'Location request timed out', 'Истекло время ожидания геолокации');
    case 'POSITION_UNAVAILABLE':
      return pick(locale, 'Position unavailable', 'Местоположение недоступно');
    case 'LOW_ACCURACY':
      return pick(locale, 'Accuracy too low', 'Слишком низкая точность');
    default:
      return reason;
  }
}

export function operationTypeLabel(type: string, locale: AppLocale): string {
  switch (type) {
    case 'CHECK_IN':
      return pick(locale, 'Check In', 'Приход');
    case 'CHECK_OUT':
      return pick(locale, 'Check Out', 'Уход');
    default:
      return type;
  }
}

export function materializationStateLabel(state: string, locale: AppLocale): string {
  switch (state) {
    case 'PENDING':
      return pick(locale, 'Pending', 'Ожидание');
    case 'MATERIALIZED':
      return pick(locale, 'Materialized', 'Обработано');
    default:
      return state;
  }
}

export function projectionStateLabel(state: string, locale: AppLocale): string {
  switch (state) {
    case 'PENDING':
      return pick(locale, 'Pending', 'Ожидание');
    case 'SETTLED':
      return pick(locale, 'Settled', 'Урегулировано');
    default:
      return state;
  }
}

const TIMESHEET_STATUS_LABELS: Record<string, { en: string; ru: string }> = {
  DRAFT: { en: 'Draft', ru: 'Черновик' },
  SUBMITTED: { en: 'Submitted', ru: 'Отправлен' },
  RETURNED: { en: 'Returned', ru: 'Возвращён' },
  FOREMAN_APPROVED: { en: 'Foreman Approved', ru: 'Одобрен прорабом' },
  FINAL_APPROVED: { en: 'Final Approved', ru: 'Окончательно одобрен' }
};

export function timesheetStatusLabel(status: string, locale: AppLocale): string {
  const entry = TIMESHEET_STATUS_LABELS[status];
  if (entry) return locale === 'RU' ? entry.ru : entry.en;
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

const DETAIL_KEY_LABELS: Record<string, { en: string; ru: string }> = {
  distanceMeters: { en: 'Distance (m)', ru: 'Расстояние (м)' },
  accuracyMeters: { en: 'GPS accuracy (m)', ru: 'Точность GPS (м)' },
  thresholdMeters: { en: 'Threshold (m)', ru: 'Порог (м)' },
  distanceToSiteMeters: { en: 'Distance to site centre (m)', ru: 'Расстояние до центра объекта (м)' },
  geofenceRadiusMeters: { en: 'Site geofence radius (m)', ru: 'Радиус геозоны объекта (м)' },
  pointInsideGeofence: { en: 'Point inside geofence (ignoring accuracy)', ru: 'Точка внутри геозоны (без учёта точности)' },
  reason: { en: 'Reason', ru: 'Причина' },
  clockSkewMs: { en: 'Clock skew (ms)', ru: 'Расхождение времени (мс)' },
  assumedSiteId: { en: 'Assumed site', ru: 'Предполагаемый объект' },
  authoritativeSiteId: { en: 'Authoritative site', ru: 'Фактический объект' },
  claimedEffectiveAt: { en: 'Claimed time', ru: 'Заявленное время' },
  openedAt: { en: 'Opened at', ru: 'Открыто в' },
  clampedTo: { en: 'Clamped to', ru: 'Ограничено до' },
  durationHours: { en: 'Duration (h)', ru: 'Длительность (ч)' },
  thresholdHours: { en: 'Threshold (h)', ru: 'Порог (ч)' },
  timesheetStatus: { en: 'Timesheet status', ru: 'Статус табеля' },
  triggeringClockShiftId: { en: 'Triggering shift', ru: 'Инициирующая смена' },
  cachedGeofenceVersionId: { en: 'Cached geofence version', ru: 'Закэшированная версия геозоны' },
  currentGeofenceVersionId: { en: 'Current geofence version', ru: 'Текущая версия геозоны' }
};

export function detailKeyLabel(key: string, locale: AppLocale): string {
  const entry = DETAIL_KEY_LABELS[key];
  if (!entry) return key;
  return locale === 'RU' ? entry.ru : entry.en;
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
