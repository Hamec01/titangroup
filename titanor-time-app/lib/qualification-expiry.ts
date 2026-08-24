// Single reusable expiry-status helper for the Qualifications Matrix feature. Every UI surface
// (worker profile, admin worker profile, /admin/qualifications matrix, notification generation)
// must call this instead of computing its own thresholds/colors — see
// docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md-adjacent task spec §15 for the exact boundary
// table this implements. Pure, no I/O, no Prisma types — takes a calendar date already resolved
// to the Europe/Helsinki calendar (same convention as the rest of the reporting layer).

export type QualificationExpiryStatus =
  | 'VALID'
  | 'EXPIRING_SOON'
  | 'CRITICAL'
  | 'EXPIRED'
  | 'MISSING_EXPIRY';

export type QualificationStatusColor = 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED';

export interface QualificationExpiryResult {
  status: QualificationExpiryStatus;
  color: QualificationStatusColor;
  /** Calendar-day difference (expiresOn - today), Helsinki calendar. Null when there is no expiresOn. */
  daysUntilExpiry: number | null;
  /** True only for the exact boundary expiresOn === today (still CRITICAL, but always RED, not ORANGE). */
  isExpiringToday: boolean;
}

function toUtcMidnight(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Calendar-day difference between two dates that already represent Helsinki calendar days (stored as @db.Date / UTC-midnight). */
export function diffCalendarDays(from: Date, to: Date): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((toUtcMidnight(to) - toUtcMidnight(from)) / MS_PER_DAY);
}

export function computeQualificationExpiryStatus(
  expiryMode: 'REQUIRED' | 'OPTIONAL' | 'NONE',
  expiresOn: Date | null,
  today: Date
): QualificationExpiryResult {
  if (!expiresOn) {
    if (expiryMode === 'REQUIRED') {
      return { status: 'MISSING_EXPIRY', color: 'RED', daysUntilExpiry: null, isExpiringToday: false };
    }
    return { status: 'VALID', color: 'GREEN', daysUntilExpiry: null, isExpiringToday: false };
  }

  const days = diffCalendarDays(today, expiresOn);

  if (days < 0) {
    return { status: 'EXPIRED', color: 'RED', daysUntilExpiry: days, isExpiringToday: false };
  }
  if (days === 0) {
    return { status: 'CRITICAL', color: 'RED', daysUntilExpiry: 0, isExpiringToday: true };
  }
  if (days <= 14) {
    return { status: 'CRITICAL', color: 'ORANGE', daysUntilExpiry: days, isExpiringToday: false };
  }
  if (days <= 60) {
    return { status: 'EXPIRING_SOON', color: 'YELLOW', daysUntilExpiry: days, isExpiringToday: false };
  }
  return { status: 'VALID', color: 'GREEN', daysUntilExpiry: days, isExpiringToday: false };
}

export const QUALIFICATION_STATUS_LABEL: Record<QualificationExpiryStatus, { en: string; ru: string }> = {
  VALID: { en: 'Valid', ru: 'Действительно' },
  EXPIRING_SOON: { en: 'Expiring soon', ru: 'Скоро истекает' },
  CRITICAL: { en: 'Critical', ru: 'Критично' },
  EXPIRED: { en: 'Expired', ru: 'Истекло' },
  MISSING_EXPIRY: { en: 'Missing expiry date', ru: 'Не указан срок действия' }
};

export function qualificationStatusLabel(status: QualificationExpiryStatus, locale: 'EN' | 'RU', isExpiringToday?: boolean): string {
  if (isExpiringToday) {
    return locale === 'RU' ? 'Истекает сегодня' : 'Expires today';
  }
  return QUALIFICATION_STATUS_LABEL[status][locale === 'RU' ? 'ru' : 'en'];
}
