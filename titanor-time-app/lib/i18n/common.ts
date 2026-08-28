import type { AppLocale } from './locale';

// Cross-cutting copy reused across ≥2 of the Phase-1 (Worker) files — nav chrome, generic
// fallback errors, and the shared timesheet status vocabulary that both the live pages and the
// offline snapshot view render. Foreman/Admin phases add their own lib/i18n/foreman.ts /
// lib/i18n/admin.ts later and may extend this file additively if a new string is genuinely
// shared, but this task doesn't touch it beyond what Worker needs.

export interface CommonStrings {
  accessDeniedWorker: string;
  noEmployeeProfile: string;
  networkError: string;
  genericError: string;
  loading: string;
  save: string;
  saving: string;
  backToClock: string;
  backToYourPeriods: string;
  // Nav (WorkerAppNavigation)
  navHome: string;
  navCalendarAndHours: string;
  navHistory: string;
  navProfile: string;
  navInstallApp: string;
  navWorkerAccount: string;
  navSignedInAs: string;
  navSignOut: string;
  navSigningOut: string;
  navSignOutError: string;
  navOpenMenu: string;
  navCloseMenu: string;
  navLanguage: string;
  navLanguageError: string;
  // Timesheet status vocabulary (worker-facing labels)
  statusNotStarted: string;
  statusInProgress: string; // interpolate with a duration, e.g. "In progress · {duration}"
  statusReturned: string;
  statusSubmitted: string;
  statusForemanApproved: string;
  statusFinalApproved: string;
  // Return-reason notice (ReturnReasonsNotice.tsx + WorkerSnapshotView.tsx's read-only twin)
  returnedForCorrectionTitle: string;
  returnedReasonUnavailable: string;
  returnedAtPrefix: string; // "Returned {date}"
  unknownSite: string;
  generalNonSite: string; // "General / non-site"
}

export const COMMON_STRINGS: Record<AppLocale, CommonStrings> = {
  EN: {
    accessDeniedWorker: 'Access denied — this page requires the WORKER role.',
    noEmployeeProfile: 'Your account has no linked employee profile.',
    networkError: 'Network error — please try again.',
    genericError: 'Something went wrong. Please try again.',
    loading: 'Loading…',
    save: 'Save',
    saving: 'Saving…',
    backToClock: '← Back to clock',
    backToYourPeriods: 'Back to your periods',
    navHome: 'Home',
    navCalendarAndHours: 'Calendar and hours',
    navHistory: 'History',
    navProfile: 'Profile',
    navInstallApp: 'Install app',
    navWorkerAccount: 'Worker account',
    navSignedInAs: 'Signed in as',
    navSignOut: 'Sign out',
    navSigningOut: 'Signing out…',
    navSignOutError: 'Could not sign out. Check your connection and try again.',
    navOpenMenu: 'Open menu',
    navCloseMenu: 'Close menu',
    navLanguage: 'Language',
    navLanguageError: 'Could not change language. Check your connection and try again.',
    statusNotStarted: 'Not started',
    statusInProgress: 'In progress',
    statusReturned: 'Returned — needs your attention',
    statusSubmitted: 'Submitted — awaiting review',
    statusForemanApproved: 'Review complete — awaiting final approval',
    statusFinalApproved: 'Finalized',
    returnedForCorrectionTitle: 'Open for edits again',
    returnedReasonUnavailable: 'Your timesheet is open for edits again. Review the hours and send it when it looks right — your manager will take it from there.',
    returnedAtPrefix: 'Returned',
    unknownSite: 'Unknown site',
    generalNonSite: 'General / non-site'
  },
  RU: {
    accessDeniedWorker: 'Доступ запрещён — эта страница доступна только для роли WORKER.',
    noEmployeeProfile: 'К вашей учётной записи не привязан профиль работника.',
    networkError: 'Ошибка сети — попробуйте ещё раз.',
    genericError: 'Что-то пошло не так. Попробуйте ещё раз.',
    loading: 'Загрузка…',
    save: 'Сохранить',
    saving: 'Сохранение…',
    backToClock: '← К учёту времени',
    backToYourPeriods: 'Назад к вашим периодам',
    navHome: 'Главная',
    navCalendarAndHours: 'Календарь и часы',
    navHistory: 'История',
    navProfile: 'Профиль',
    navInstallApp: 'Установить приложение',
    navWorkerAccount: 'Аккаунт работника',
    navSignedInAs: 'Вы вошли как',
    navSignOut: 'Выйти',
    navSigningOut: 'Выполняется выход…',
    navSignOutError: 'Не удалось выйти. Проверьте соединение и попробуйте ещё раз.',
    navOpenMenu: 'Открыть меню',
    navCloseMenu: 'Закрыть меню',
    navLanguage: 'Язык',
    navLanguageError: 'Не удалось сменить язык. Проверьте соединение и попробуйте ещё раз.',
    statusNotStarted: 'Не начат',
    statusInProgress: 'В процессе',
    statusReturned: 'Возвращён — требует внимания',
    statusSubmitted: 'Отправлен — ожидает проверки',
    statusForemanApproved: 'Проверка завершена — ожидает окончательного утверждения',
    statusFinalApproved: 'Утверждён окончательно',
    returnedForCorrectionTitle: 'Табель снова открыт для правок',
    returnedReasonUnavailable: 'Табель снова открыт для изменений. Проверьте часы и отправьте, когда всё будет в порядке — дальше разберётся руководитель.',
    returnedAtPrefix: 'Возвращён',
    unknownSite: 'Неизвестный объект',
    generalNonSite: 'Общее / вне объекта'
  }
};
