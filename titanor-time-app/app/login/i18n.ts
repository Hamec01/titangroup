// Self-contained translation dictionary for /login only — no i18n library.
// docs/titanor-time/01_SCREEN_MAP.md §1 (/login): "переключатель языка
// (RU/EN, без отдельного route — persist в localStorage + cookie
// NEXT_LOCALE до входа)".

export type LoginLocale = 'EN' | 'RU';

export const LOGIN_LOCALES: LoginLocale[] = ['RU', 'EN'];
export const DEFAULT_LOGIN_LOCALE: LoginLocale = 'RU';
export const LOGIN_LOCALE_STORAGE_KEY = 'titanor-time-locale';
export const LOGIN_LOCALE_COOKIE_NAME = 'NEXT_LOCALE';

export interface LoginStrings {
  title: string;
  subtitle: string;
  identifierLabel: string;
  passwordLabel: string;
  submit: string;
  submitting: string;
  errorInvalidCredentials: string;
  errorPendingActivation: string;
  errorDeactivated: string;
  errorRateLimited: string;
  errorGeneric: string;
  noRole: string;
}

export const LOGIN_STRINGS: Record<LoginLocale, LoginStrings> = {
  EN: {
    title: 'Titanor Time',
    subtitle: 'Sign in',
    identifierLabel: 'Username or email',
    passwordLabel: 'Password',
    submit: 'Sign in',
    submitting: 'Signing in…',
    errorInvalidCredentials: 'Incorrect username/email or password.',
    errorPendingActivation: 'This account has not been activated yet.',
    errorDeactivated: 'This account has been deactivated.',
    errorRateLimited: 'Too many attempts. Try again later.',
    errorGeneric: 'Something went wrong. Please try again.',
    noRole: 'This account has no assigned role. Contact your administrator.'
  },
  RU: {
    title: 'Titanor Time',
    subtitle: 'Вход',
    identifierLabel: 'Имя пользователя или email',
    passwordLabel: 'Пароль',
    submit: 'Войти',
    submitting: 'Выполняется вход…',
    errorInvalidCredentials: 'Неверное имя пользователя/email или пароль.',
    errorPendingActivation: 'Учётная запись ещё не активирована.',
    errorDeactivated: 'Учётная запись отключена.',
    errorRateLimited: 'Слишком много попыток. Попробуйте позже.',
    errorGeneric: 'Что-то пошло не так. Попробуйте ещё раз.',
    noRole: 'У учётной записи нет роли. Обратитесь к администратору.'
  }
};

export function isLoginLocale(value: string): value is LoginLocale {
  return (LOGIN_LOCALES as string[]).includes(value);
}
