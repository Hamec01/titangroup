// docs/titanor-time/T9_INTERNAL_TEST_PLAN.md-adjacent i18n slice — app-wide (post-login) locale
// support, EN/RU only. Deliberately separate from app/login/i18n.ts's own EN/RU
// LoginLocale/LOGIN_STRINGS (pre-auth, unauthenticated visitor) — that file is untouched by this
// slice. The two cookie/storage-key constants below are intentionally literal-duplicated rather
// than imported from app/login/i18n.ts, to keep this a self-contained additive change with zero
// touch-surface on a file that may be edited elsewhere in parallel; both values are load-bearing
// across the whole site so accidental drift between the two copies is low-risk (they're simple
// constant strings, not logic).

export type AppLocale = 'EN' | 'RU';

export const APP_LOCALES: AppLocale[] = ['EN', 'RU'];
// Russian is the pilot default. The database still contains legacy FI values from the original
// three-language prototype; until Finnish is translated end-to-end those accounts must not fall
// back to a language the owner did not select.
export const DEFAULT_APP_LOCALE: AppLocale = 'RU';
export const LOCALE_COOKIE_NAME = 'NEXT_LOCALE';
export const LOCALE_STORAGE_KEY = 'titanor-time-locale';

export function isAppLocale(value: string): value is AppLocale {
  return (APP_LOCALES as string[]).includes(value);
}

/**
 * Folds any raw value (a DB `User.locale` enum value including legacy `'FI'`, a cookie value, or
 * garbage) down to a supported `AppLocale` — never throws. Legacy `'FI'` accounts see Russian
 * until Finnish is implemented as a complete third language.
 */
export function normalizeToAppLocale(value: string | null | undefined): AppLocale {
  if (value && isAppLocale(value)) {
    return value;
  }
  return DEFAULT_APP_LOCALE;
}

/** Small typed selector for copy that belongs to one screen rather than a shared dictionary. */
export function localeText(locale: AppLocale, en: string, ru: string): string {
  return locale === 'RU' ? ru : en;
}
