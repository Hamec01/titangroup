// UT4-B (Titanor Time — единый табель) — pure label/tone mapping for the new /admin/timesheets
// page, following the exact convention already established by lib/attendance-exceptions-ui.ts's
// exceptionStatusLabel/exceptionStatusBadgeClass and components/qualifications/QualificationBadge:
// color is never the only signal, and the UI never shows a technical field name (fingerprint,
// canonicalSource, CURRENT/SUPERSEDED, source revision) outside the collapsed "Диагностика" block —
// every string this module returns is safe for the main, always-visible UI.

import type { AppLocale } from '@/lib/i18n/locale';
import { exceptionTypeLabel } from '@/lib/attendance-exceptions-ui';
import type { WeeklyCustomerSliceRow, LedgerIssue } from '@/lib/reporting/time-ledger';

function pick(locale: AppLocale, en: string, ru: string): string {
  return locale === 'RU' ? ru : en;
}

export type BadgeTone = 'neutral' | 'warning' | 'success' | 'danger';

const APPROVAL_STATE_TEXT: Record<WeeklyCustomerSliceRow['approvalState'], { en: string; ru: string }> = {
  READY: { en: 'Ready', ru: 'Готово' },
  NEEDS_ATTENTION: { en: 'Needs attention', ru: 'Есть замечание' },
  APPROVED: { en: 'Approved', ru: 'Подтверждено' },
  CHANGED_AFTER_APPROVAL: { en: 'Changed after approval', ru: 'Изменено после подтверждения' }
};

// TZ §5.5 — red is reserved for a real error/blocker; an ordinary plan-vs-actual style mismatch is
// yellow, never red. CHANGED_AFTER_APPROVAL is a normal, expected state (the worker edited an
// already-approved week), not a failure, so it stays warning-tone, not danger-tone.
const APPROVAL_STATE_TONE: Record<WeeklyCustomerSliceRow['approvalState'], BadgeTone> = {
  READY: 'neutral',
  NEEDS_ATTENTION: 'warning',
  APPROVED: 'success',
  CHANGED_AFTER_APPROVAL: 'warning'
};

export function approvalStateLabel(state: WeeklyCustomerSliceRow['approvalState'], locale: AppLocale): string {
  const entry = APPROVAL_STATE_TEXT[state];
  return locale === 'RU' ? entry.ru : entry.en;
}

export function approvalStateTone(state: WeeklyCustomerSliceRow['approvalState']): BadgeTone {
  return APPROVAL_STATE_TONE[state];
}

export function submissionStateLabel(state: WeeklyCustomerSliceRow['submissionState'], locale: AppLocale): string {
  return state === 'SUBMITTED' ? pick(locale, 'Submitted', 'Сдано') : pick(locale, 'Not submitted yet', 'Ещё не сдано');
}

export function notSubmittedRowLabel(locale: AppLocale): string {
  return pick(locale, "Hasn't submitted", 'Ещё не сдал(а)');
}

export function sourceErrorRowLabel(locale: AppLocale): string {
  return pick(locale, 'Data error', 'Ошибка данных');
}

/** workAreaId === null system group — TZ §2.4/§5.4. */
export function noCustomerGroupLabel(locale: AppLocale): string {
  return pick(locale, 'No customer', 'Без заказчика');
}

const ISSUE_TEXT: Record<string, { en: string; ru: string }> = {
  SELF_APPROVAL_FORBIDDEN: { en: 'Cannot approve own hours', ru: 'Нельзя подтвердить свои часы' },
  OPEN_SHIFT: { en: 'Open shift not closed', ru: 'Незакрытая смена' },
  OPEN_CORRECTION_REQUEST: { en: 'Correction in progress', ru: 'Идёт правка часов' },
  AUTOMATIC_SUBMISSION: { en: 'Submitted automatically', ru: 'Отправлено автоматически' },
  EDIT_WINDOW_STILL_OPEN: { en: 'Worker can still edit', ru: 'Работник ещё может изменить' },
  CONFIRMED_ZERO_DAY_PRESENT: { en: 'A zero-hour day was confirmed', ru: 'Подтверждён нулевой день' },
  SUPERSEDED_FINGERPRINT_MATCH: { en: 'Matches an earlier approval — needs review', ru: 'Совпадает с прежним подтверждением, нужна проверка' },
  PLAN_ACTUAL_MISMATCH: { en: 'Plan differs from actual', ru: 'План отличается от факта' }
};

const OPEN_EXCEPTION_PREFIX = 'OPEN_ATTENDANCE_EXCEPTION_';

/** Never returns a raw code or a server-internal string — either a mapped human sentence, or (for
 *  an attendance-exception-backed warning) the SAME localized exception-type text already used
 *  elsewhere in the app, or — only as a last resort — the server's own already-human-readable
 *  `message` (never `code`, never a technical identifier). */
export function issueLabel(issue: LedgerIssue, locale: AppLocale): string {
  if (issue.code.startsWith(OPEN_EXCEPTION_PREFIX)) {
    const exceptionType = issue.code.slice(OPEN_EXCEPTION_PREFIX.length);
    return pick(locale, `Open exception: ${exceptionTypeLabel(exceptionType, locale)}`, `Открытое замечание: ${exceptionTypeLabel(exceptionType, locale)}`);
  }
  const entry = ISSUE_TEXT[issue.code];
  if (entry) return locale === 'RU' ? entry.ru : entry.en;
  return issue.message;
}

export function issueCountLabel(count: number, kind: 'blocker' | 'warning', locale: AppLocale): string {
  if (kind === 'blocker') return pick(locale, `${count} blocker${count === 1 ? '' : 's'}`, `${count} ${blockerWordRu(count)}`);
  return pick(locale, `${count} warning${count === 1 ? '' : 's'}`, `${count} ${warningWordRu(count)}`);
}

function blockerWordRu(n: number): string {
  return pluralRu(n, 'блокировка', 'блокировки', 'блокировок');
}
function warningWordRu(n: number): string {
  return pluralRu(n, 'замечание', 'замечания', 'замечаний');
}
function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
