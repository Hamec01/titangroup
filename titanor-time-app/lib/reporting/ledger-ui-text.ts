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

// UT5-B — single weekly-customer-hours approval action text.
export function confirmWeekButtonLabel(locale: AppLocale): string {
  return pick(locale, 'Confirm this week', 'Подтвердить эту неделю');
}
export function approvedStatusNote(locale: AppLocale): string {
  return pick(locale, 'Already confirmed.', 'Уже подтверждено.');
}
export function approveLoadingLabel(locale: AppLocale): string {
  return pick(locale, 'Checking…', 'Проверяем…');
}
export function approveCommittingLabel(locale: AppLocale): string {
  return pick(locale, 'Confirming…', 'Подтверждаем…');
}
export function approveStaleLabel(locale: AppLocale): string {
  return pick(locale, 'The data changed — refresh this row.', 'Данные изменились — обновите строку.');
}
export function approveRefreshButtonLabel(locale: AppLocale): string {
  return pick(locale, 'Refresh', 'Обновить');
}
export function approveWarningIntroLabel(locale: AppLocale): string {
  return pick(locale, 'This week has notes — confirm anyway?', 'По этой неделе есть замечания — всё равно подтвердить?');
}
export function approveWarningConfirmButtonLabel(locale: AppLocale): string {
  return pick(locale, 'Confirm anyway', 'Всё равно подтвердить');
}
export function approveErrorLabel(locale: AppLocale): string {
  return pick(locale, 'Could not confirm this week.', 'Не удалось подтвердить неделю.');
}
export function approveRetryButtonLabel(locale: AppLocale): string {
  return pick(locale, 'Try again', 'Повторить');
}
export function approveBlockedIntroLabel(locale: AppLocale): string {
  return pick(locale, 'Cannot confirm yet:', 'Пока нельзя подтвердить:');
}
export function approveDraftWarningLabel(locale: AppLocale): string {
  return pick(locale, 'Not submitted yet — the worker can still change these hours before you confirm.', 'Ещё не сдано — работник ещё может изменить эти часы до подтверждения.');
}
export function approveSuccessLabel(locale: AppLocale, result: 'APPROVED' | 'ALREADY_APPROVED'): string {
  return result === 'ALREADY_APPROVED' ? pick(locale, 'Already confirmed — nothing to change.', 'Уже было подтверждено — менять нечего.') : pick(locale, 'Confirmed.', 'Подтверждено.');
}

// UT6-B — mass (bulk) weekly-customer-hours approval action text.
export function selectRowCheckboxLabel(locale: AppLocale): string {
  return pick(locale, 'Select this week', 'Выбрать эту неделю');
}
export function selectVisibleLabel(locale: AppLocale): string {
  return pick(locale, 'Select visible', 'Выбрать видимые');
}
export function confirmAllMatchingLabel(customerName: string, locale: AppLocale): string {
  return pick(locale, `Confirm all matching hours for ${customerName}`, `Подтвердить все подходящие часы ${customerName}`);
}
export function massSelectedCountLabel(count: number, locale: AppLocale): string {
  return pick(locale, `${count} selected`, `Выбрано: ${count}`);
}
export function massClearSelectionLabel(locale: AppLocale): string {
  return pick(locale, 'Clear selection', 'Снять выбор');
}
export function massConfirmSelectedLabel(locale: AppLocale): string {
  return pick(locale, 'Confirm selected hours', 'Подтвердить выбранные часы');
}
export function massDifferentCustomerNote(locale: AppLocale): string {
  return pick(locale, 'Clear the current selection to select rows for a different customer.', 'Чтобы выбрать строки другого заказчика, сначала снимите текущий выбор.');
}
export function massSelectionLockedNote(locale: AppLocale): string {
  return pick(
    locale,
    'The selection is locked while a preview is open — change or cancel the preview below to edit it.',
    'Выбор заблокирован, пока открыт предпросмотр — измените или отмените его ниже, чтобы изменить выбор.'
  );
}
export function massTooManyLabel(totalItems: number, max: number, locale: AppLocale): string {
  return pick(
    locale,
    `${totalItems} rows match — narrow the period or filter to select at most ${max} at once.`,
    `Подходит строк: ${totalItems} — сузьте период или фильтр, чтобы выбрать не более ${max} за раз.`
  );
}
export function massPreviewLoadingLabel(locale: AppLocale): string {
  return pick(locale, 'Checking the selection…', 'Проверяем выбор…');
}
export function massCommittingLabel(locale: AppLocale): string {
  return pick(locale, 'Confirming…', 'Подтверждаем…');
}
// UT6-B-fixup #2 — same DD.MM.YYYY (RU) / DD/MM/YYYY (EN) convention as LedgerTopBar.tsx's own
// (private) formatRangeDisplay, exposed here as a shared label since MassApprovePreviewPanel needs
// it too. periodStart/periodEnd are always server-computed from the validated selection, never
// client text (see the mass-approval-preview route) — this function only formats them for display.
export function massPeriodLabel(periodStart: string, periodEnd: string, locale: AppLocale): string {
  const fmt = (iso: string) => {
    const [y, m, d] = iso.split('-');
    return locale === 'RU' ? `${d}.${m}.${y}` : `${d}/${m}/${y}`;
  };
  return `${fmt(periodStart)} – ${fmt(periodEnd)}`;
}

export function massPreviewSummaryLabel(employeeCount: number, weekPartCount: number, locale: AppLocale): string {
  return pick(
    locale,
    `${employeeCount} worker${employeeCount === 1 ? '' : 's'}, ${weekPartCount} week${weekPartCount === 1 ? '' : 's'}`,
    `${employeeCount} ${pluralRu(employeeCount, 'работник', 'работника', 'работников')}, ${weekPartCount} ${pluralRu(weekPartCount, 'неделя', 'недели', 'недель')}`
  );
}
export function massAlreadyApprovedLabel(count: number, locale: AppLocale): string {
  return pick(locale, `Already confirmed: ${count}`, `Уже подтверждено: ${count}`);
}
export function massTechnicallyBlockedIntroLabel(locale: AppLocale): string {
  return pick(locale, 'These rows cannot be processed — nothing will be confirmed until they are removed from the selection:', 'Эти строки нельзя обработать — ничего не будет подтверждено, пока они выбраны:');
}
export function massWarningsIntroLabel(locale: AppLocale): string {
  return pick(locale, 'Some selected rows have notes — review before confirming:', 'У части выбранных строк есть замечания — проверьте перед подтверждением:');
}
export function massConfirmAnywayLabel(locale: AppLocale): string {
  return pick(locale, 'Confirm anyway', 'Всё равно подтвердить');
}
export function massConfirmCleanLabel(locale: AppLocale): string {
  return pick(locale, 'Confirm this selection', 'Подтвердить этот выбор');
}
export function massErrorLabel(locale: AppLocale): string {
  return pick(locale, 'Could not confirm this selection.', 'Не удалось подтвердить выбор.');
}
export function massStaleLabel(locale: AppLocale): string {
  return pick(locale, 'The data changed — refresh and select again.', 'Данные изменились — обновите и выберите заново.');
}
export function massSuccessLabel(itemCount: number, alreadyApprovedCount: number, locale: AppLocale): string {
  const parts: string[] = [];
  if (itemCount > 0) parts.push(pick(locale, `${itemCount} confirmed`, `подтверждено: ${itemCount}`));
  if (alreadyApprovedCount > 0) parts.push(pick(locale, `${alreadyApprovedCount} already confirmed`, `уже было подтверждено: ${alreadyApprovedCount}`));
  if (parts.length === 0) return pick(locale, 'Nothing to confirm.', 'Нечего подтверждать.');
  return parts.join(locale === 'RU' ? ', ' : ', ');
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

// UT7-B — "было / стало" diff panel for a row that changed after approval.
function shortDateLabel(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}
export function diffLoadingLabel(locale: AppLocale): string {
  return pick(locale, 'Loading what changed…', 'Загружаем, что изменилось…');
}
export function diffErrorLabel(locale: AppLocale): string {
  return pick(locale, 'Could not load what changed.', 'Не удалось загрузить изменения.');
}
export function diffBeforeAfterLabel(beforeText: string, afterText: string, locale: AppLocale): string {
  return pick(locale, `Before: ${beforeText} · After: ${afterText}`, `Было: ${beforeText} · Стало: ${afterText}`);
}
export function diffApprovedByLabel(approvedByUserName: string, approvedAtText: string, locale: AppLocale): string {
  return pick(locale, `Confirmed by ${approvedByUserName}, ${approvedAtText}.`, `Подтвердил(а) ${approvedByUserName}, ${approvedAtText}.`);
}
export function diffDeltaLabel(deltaWorkedMinutes: number, locale: AppLocale): string {
  const sign = deltaWorkedMinutes > 0 ? '+' : deltaWorkedMinutes < 0 ? '−' : '';
  const abs = Math.abs(deltaWorkedMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const text = h > 0 ? `${h} ${pick(locale, 'h', 'ч')} ${m} ${pick(locale, 'min', 'мин')}` : `${m} ${pick(locale, 'min', 'мин')}`;
  return pick(locale, `Difference: ${sign}${text}`, `Разница: ${sign}${text}`);
}
export function diffChangedDatesLabel(dates: string[], locale: AppLocale): string {
  const list = dates.map(shortDateLabel).join(', ');
  return pick(locale, `Changed days: ${list}`, `Изменившиеся дни: ${list}`);
}
export function diffSliceRemovedLabel(locale: AppLocale): string {
  return pick(locale, 'These hours were removed entirely after this was confirmed.', 'Эти часы были полностью удалены после подтверждения.');
}
export function diffSourceUnreadableLabel(locale: AppLocale): string {
  return pick(locale, "Current data for this week can't be read right now — a technical issue, not a real change.", 'Сейчас не удаётся прочитать текущие данные по этой неделе — техническая ошибка, не реальное изменение.');
}
// UT7-B-fixup #2 — historical approval rows (SLICE_REMOVED / SOURCE_UNREADABLE with approval
// history), shown inside their customer's CustomerGroupSection so a removed/unreadable week's past
// confirmation stays visible instead of silently disappearing from the ledger.
export function historicalRemovedStatusLabel(locale: AppLocale): string {
  return pick(locale, 'Hours removed after confirmation', 'Часы удалены после подтверждения');
}
export function historicalUnreadableStatusLabel(locale: AppLocale): string {
  return pick(locale, "The source for these hours is currently unavailable", 'Источник часов сейчас недоступен');
}
export function historicalOpenLabel(locale: AppLocale, open: boolean): string {
  if (open) return pick(locale, 'Close', 'Свернуть');
  return pick(locale, 'Show what changed', 'Показать, что изменилось');
}
// UT7-B-fixup-2 #5 — shown once above a group's historical rows so they are never mistaken for
// current hours or counted toward the page/pagination totals shown elsewhere on the same page.
export function historicalSectionNoteLabel(locale: AppLocale): string {
  return pick(
    locale,
    'History of changed or removed confirmed hours. Not included in the current total.',
    'История изменённых или удалённых подтверждённых часов. Не входит в текущий итог.'
  );
}
// UT7-B-fixup-2 #1/#2 — the historical-approvals list is an explicitly secondary, best-effort
// diagnostic source: a failure loading it never blocks or breaks the main "Табель" view, it just
// shows this small, non-blocking warning with its own retry.
export function historicalLoadErrorLabel(locale: AppLocale): string {
  return pick(locale, 'Could not load the history of changed confirmations.', 'Не удалось загрузить историю изменённых подтверждений.');
}
export function historicalRetryLabel(locale: AppLocale): string {
  return pick(locale, 'Try again', 'Повторить');
}
// UT7-B-fixup-2 #3 — MAX_HISTORICAL_ROWS was reached: the list below is a genuine subset, not the
// complete set, and this says so explicitly rather than silently presenting a partial list as full.
export function historicalTruncatedLabel(locale: AppLocale): string {
  return pick(locale, 'Not all historical rows are shown — narrow the filter.', 'Показаны не все исторические строки — сузьте фильтр.');
}

export function diffUnchangedLabel(locale: AppLocale): string {
  return pick(locale, 'Nothing actually changed.', 'На самом деле ничего не изменилось.');
}
