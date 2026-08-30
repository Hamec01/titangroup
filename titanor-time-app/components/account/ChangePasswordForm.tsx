'use client';

import { useState, type FormEvent } from 'react';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

const CSRF_HEADER_VALUE = 'titanor-time';

export function ChangePasswordForm() {
  const locale = useAppLocale();
  const ru = locale === 'RU';
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    setMessage(null);
    setError(null);
    if (newPassword.length < 8 || newPassword.length > 256) {
      setError(ru ? 'Новый пароль должен содержать не менее 8 символов.' : 'The new password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmation) {
      setError(ru ? 'Пароли не совпадают.' : 'The passwords do not match.');
      return;
    }
    setSaving(true);
    try {
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const code = body?.error?.code;
        setError(
          code === 'INVALID_CURRENT_PASSWORD'
            ? (ru ? 'Текущий пароль указан неверно.' : 'The current password is incorrect.')
            : code === 'SAME_AS_CURRENT'
              ? (ru ? 'Новый пароль должен отличаться от текущего.' : 'Choose a password different from the current one.')
              : code === 'VALIDATION_ERROR'
                ? (ru ? 'Новый пароль должен содержать не менее 8 символов.' : 'The new password must be at least 8 characters.')
                : code === 'RATE_LIMITED'
                  ? (ru ? 'Слишком много попыток. Повторите позже.' : 'Too many attempts. Try again later.')
                  : (ru ? 'Не удалось изменить пароль. Повторите попытку.' : 'Could not change the password. Please try again.')
        );
        return;
      }
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
      setMessage(ru ? 'Пароль изменён. Остальные сеансы завершены.' : 'Password changed. Your other sessions have been signed out.');
    } catch {
      setError(ru ? 'Ошибка сети. Повторите попытку.' : 'Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="account-settings" aria-labelledby="change-password-title">
      <h2 id="change-password-title">{ru ? 'Смена пароля' : 'Change password'}</h2>
      <p className="setup-subtitle">{ru ? 'После смены пароля все остальные сеансы будут завершены.' : 'Changing your password signs out every other session.'}</p>
      <form onSubmit={submit} aria-busy={saving}>
        <div className="login-field">
          <label htmlFor="cp-current">{ru ? 'Текущий пароль' : 'Current password'}</label>
          <input id="cp-current" type="password" autoComplete="current-password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} disabled={saving} />
        </div>
        <div className="login-field">
          <label htmlFor="cp-new">{ru ? 'Новый пароль' : 'New password'}</label>
          <input id="cp-new" type="password" autoComplete="new-password" required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} disabled={saving} />
        </div>
        <div className="login-field">
          <label htmlFor="cp-confirm">{ru ? 'Повторите новый пароль' : 'Repeat new password'}</label>
          <input id="cp-confirm" type="password" autoComplete="new-password" required value={confirmation} onChange={(e) => setConfirmation(e.target.value)} disabled={saving} />
        </div>
        <button className="login-submit" type="submit" disabled={saving}>{saving ? (ru ? 'Сохранение…' : 'Saving…') : (ru ? 'Изменить пароль' : 'Change password')}</button>
      </form>
      {error ? <p className="login-error" role="alert">{error}</p> : null}
      {message ? <p className="form-status" role="status">{message}</p> : null}
    </section>
  );
}
