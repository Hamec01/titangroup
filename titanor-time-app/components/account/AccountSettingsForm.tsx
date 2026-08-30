'use client';

import { useState, type FormEvent } from 'react';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

const CSRF_HEADER_VALUE = 'titanor-time';

export function AccountSettingsForm({
  initialEmail,
  username,
  roles,
  lastLoginAt
}: {
  initialEmail: string | null;
  username: string;
  roles: string[];
  lastLoginAt?: string | null;
}) {
  const locale = useAppLocale();
  const ru = locale === 'RU';
  const [email, setEmail] = useState(initialEmail ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function saveEmail(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch('/api/me/account', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ email, currentPassword })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (body?.error?.code === 'INVALID_CURRENT_PASSWORD') setError(ru ? 'Текущий пароль указан неверно.' : 'The current password is incorrect.');
        else if (body?.error?.code === 'EMAIL_IN_USE') setError(ru ? 'Этот email уже привязан к другой учётной записи.' : 'This email is already linked to another account.');
        else if (body?.error?.fieldErrors?.email) setError(ru ? 'Введите корректный email.' : 'Enter a valid email address.');
        else setError(ru ? 'Не удалось сохранить email. Повторите попытку.' : 'Could not save the email. Please try again.');
        return;
      }
      setEmail(body.email);
      setCurrentPassword('');
      setMessage(ru ? 'Email для входа и связи сохранён.' : 'Your sign-in and contact email has been saved.');
    } catch {
      setError(ru ? 'Ошибка сети. Повторите попытку.' : 'Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="account-settings" aria-labelledby="account-settings-title">
      <h2 id="account-settings-title">{ru ? 'Моя учётная запись' : 'My account'}</h2>
      <p className="setup-subtitle">{ru ? 'Личный email можно использовать вместо логина при входе. Он не используется для восстановления пароля.' : 'Your personal email can be used instead of your username to sign in. It is not used for password recovery.'}</p>
      <dl className="account-settings-summary">
        <div><dt>{ru ? 'Логин' : 'Username'}</dt><dd>{username}</dd></div>
        <div><dt>{ru ? 'Роль' : 'Role'}</dt><dd>{roles.join(', ') || '—'}</dd></div>
        <div>
          <dt>{ru ? 'Последний вход' : 'Last sign-in'}</dt>
          <dd>{lastLoginAt ? new Date(lastLoginAt).toLocaleString(ru ? 'ru-RU' : 'en-GB') : (ru ? '—' : '—')}</dd>
        </div>
      </dl>
      <form onSubmit={saveEmail} aria-busy={saving}>
        <div className="login-field">
          <label htmlFor="account-recovery-email">{ru ? 'Email для входа и связи' : 'Sign-in and contact email'}</label>
          <input id="account-recovery-email" type="email" autoComplete="email" maxLength={255} required value={email} onChange={(event) => setEmail(event.target.value)} disabled={saving} />
        </div>
        <div className="login-field">
          <label htmlFor="account-current-password">{ru ? 'Текущий пароль (для подтверждения)' : 'Current password (to confirm)'}</label>
          <input id="account-current-password" type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} disabled={saving} />
        </div>
        <button className="login-submit" type="submit" disabled={saving}>{saving ? (ru ? 'Сохранение…' : 'Saving…') : (ru ? 'Сохранить email' : 'Save email')}</button>
      </form>
      <p className="setup-subtitle">
        {ru
          ? 'Забыли пароль — обратитесь к администратору. Он выдаст одноразовый код для страницы «Сброс пароля».'
          : 'Forgot your password — ask an administrator. They will issue a one-time code for the “Reset password” page.'}
      </p>
      {error ? <p className="login-error" role="alert">{error}</p> : null}
      {message ? <p className="form-status" role="status">{message}</p> : null}
    </section>
  );
}
