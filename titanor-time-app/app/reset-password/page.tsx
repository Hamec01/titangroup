'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { DEFAULT_LOGIN_LOCALE, LOGIN_LOCALE_STORAGE_KEY, isLoginLocale, type LoginLocale } from '../login/i18n';

const CSRF_HEADER_VALUE = 'titanor-time';

function readLocale(): LoginLocale {
  try {
    const stored = window.localStorage.getItem(LOGIN_LOCALE_STORAGE_KEY);
    if (stored && isLoginLocale(stored)) return stored;
  } catch {
    /* private mode */
  }
  const cookie = document.cookie.split('; ').find((c) => c.startsWith('NEXT_LOCALE='))?.split('=')[1];
  return cookie && isLoginLocale(cookie) ? cookie : DEFAULT_LOGIN_LOCALE;
}

const T = {
  RU: {
    title: 'Сброс пароля',
    intro: 'Введите свой логин, одноразовый код от администратора и новый пароль. После сохранения все прежние сеансы будут завершены.',
    loginLabel: 'Логин (или email)',
    codeLabel: 'Код восстановления',
    codeHint: 'Формат: XXXX-XXXX-XXXX',
    passwordLabel: 'Новый пароль',
    confirmLabel: 'Повторите пароль',
    submit: 'Сохранить новый пароль',
    submitting: 'Сохранение…',
    mismatch: 'Пароли не совпадают.',
    tooShort: 'Пароль должен содержать не менее 8 символов.',
    invalid: 'Логин и код не совпадают с активным запросом на восстановление. Обратитесь к администратору за новым кодом.',
    rateLimited: 'Слишком много попыток. Повторите позже.',
    network: 'Ошибка сети. Повторите попытку.',
    doneTitle: 'Пароль изменён',
    doneBody: 'Войдите с новым паролем. Все предыдущие сеансы завершены.',
    toLogin: 'Перейти ко входу'
  },
  EN: {
    title: 'Reset password',
    intro: 'Enter your login, the one-time code from your administrator, and a new password. Saving it signs out every other session.',
    loginLabel: 'Username (or email)',
    codeLabel: 'Recovery code',
    codeHint: 'Format: XXXX-XXXX-XXXX',
    passwordLabel: 'New password',
    confirmLabel: 'Repeat password',
    submit: 'Save new password',
    submitting: 'Saving…',
    mismatch: 'The passwords do not match.',
    tooShort: 'The password must be at least 8 characters.',
    invalid: 'This login and code do not match an active recovery request. Ask your administrator for a new code.',
    rateLimited: 'Too many attempts. Try again later.',
    network: 'Network error. Please try again.',
    doneTitle: 'Password changed',
    doneBody: 'Sign in with your new password. Every previous session has ended.',
    toLogin: 'Go to sign in'
  }
} as const;

export default function ResetPasswordPage() {
  const [locale, setLocale] = useState<LoginLocale>(DEFAULT_LOGIN_LOCALE);
  const [login, setLogin] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLocale(readLocale());
  }, []);

  const t = T[locale];

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setError(null);
    if (password.length < 8 || password.length > 256) return setError(t.tooShort);
    if (password !== confirmation) return setError(t.mismatch);
    setPending(true);
    try {
      const response = await fetch('/api/auth/password-reset/confirm', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ login: login.trim(), code: code.trim(), password })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const errorCode = body?.error?.code;
        setError(
          errorCode === 'VALIDATION_ERROR'
            ? t.tooShort
            : errorCode === 'RATE_LIMITED'
              ? t.rateLimited
              : t.invalid
        );
        return;
      }
      setCompleted(true);
    } catch {
      setError(t.network);
    } finally {
      setPending(false);
    }
  }

  if (completed) {
    return (
      <main className="login-page">
        <div className="login-card">
          <h1>{t.doneTitle}</h1>
          <p>{t.doneBody}</p>
          <Link className="login-submit" href="/login">{t.toLogin}</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit} aria-busy={pending}>
        <h1>{t.title}</h1>
        <p>{t.intro}</p>
        <div className="login-field">
          <label htmlFor="reset-login">{t.loginLabel}</label>
          <input id="reset-login" type="text" autoComplete="username" required disabled={pending} value={login} onChange={(e) => setLogin(e.target.value)} />
        </div>
        <div className="login-field">
          <label htmlFor="reset-code">{t.codeLabel}</label>
          <input id="reset-code" type="text" inputMode="text" autoCapitalize="characters" autoComplete="one-time-code" placeholder={t.codeHint} required disabled={pending} value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
        <div className="login-field">
          <label htmlFor="reset-password">{t.passwordLabel}</label>
          <input id="reset-password" type="password" autoComplete="new-password" required disabled={pending} value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="login-field">
          <label htmlFor="reset-confirm">{t.confirmLabel}</label>
          <input id="reset-confirm" type="password" autoComplete="new-password" required disabled={pending} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
        </div>
        {error ? <p className="login-error" role="alert">{error}</p> : null}
        <button className="login-submit" type="submit" disabled={pending}>{pending ? t.submitting : t.submit}</button>
        <Link className="login-secondary-link" href="/login">{t.toLogin}</Link>
      </form>
    </main>
  );
}
