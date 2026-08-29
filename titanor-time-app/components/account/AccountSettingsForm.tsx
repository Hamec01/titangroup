'use client';

import { useState, type FormEvent } from 'react';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

const CSRF_HEADER_VALUE = 'titanor-time';

export function AccountSettingsForm({ initialEmail, username, roles }: { initialEmail: string | null; username: string; roles: string[] }) {
  const locale = useAppLocale();
  const ru = locale === 'RU';
  const [email, setEmail] = useState(initialEmail ?? '');
  const [savedEmail, setSavedEmail] = useState(initialEmail);
  const [currentPassword, setCurrentPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
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
      setSavedEmail(body.email);
      setEmail(body.email);
      setCurrentPassword('');
      setMessage(ru ? 'Email для входа и восстановления пароля сохранён.' : 'Your sign-in and recovery email has been saved.');
    } catch {
      setError(ru ? 'Ошибка сети. Повторите попытку.' : 'Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function sendResetLink(): Promise<void> {
    if (!savedEmail || sending) return;
    setSending(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch('/api/auth/password-reset/request', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ email: savedEmail })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(body?.error?.code === 'DELIVERY_UNAVAILABLE'
          ? (ru ? 'Отправка писем пока не настроена. Обратитесь к администратору.' : 'Email delivery is not configured yet. Contact an administrator.')
          : (ru ? 'Не удалось отправить письмо. Повторите попытку позже.' : 'Could not send the email. Try again later.'));
        return;
      }
      setMessage(ru ? 'Если адрес привязан к учётной записи, ссылка для нового пароля уже отправлена.' : 'If this address is linked to an account, a password reset link is on its way.');
    } catch {
      setError(ru ? 'Ошибка сети. Повторите попытку.' : 'Network error. Please try again.');
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="account-settings" aria-labelledby="account-settings-title">
      <h2 id="account-settings-title">{ru ? 'Моя учётная запись' : 'My account'}</h2>
      <p className="setup-subtitle">{ru ? 'Привяжите личный email: по нему можно входить и восстанавливать пароль.' : 'Link a personal email to sign in and recover your password.'}</p>
      <dl className="account-settings-summary">
        <div><dt>{ru ? 'Логин' : 'Username'}</dt><dd>{username}</dd></div>
        <div><dt>{ru ? 'Роль' : 'Role'}</dt><dd>{roles.join(', ') || '—'}</dd></div>
      </dl>
      <form onSubmit={saveEmail} aria-busy={saving}>
        <div className="login-field">
          <label htmlFor="account-recovery-email">{ru ? 'Email для входа и восстановления' : 'Sign-in and recovery email'}</label>
          <input id="account-recovery-email" type="email" autoComplete="email" maxLength={255} required value={email} onChange={(event) => setEmail(event.target.value)} disabled={saving} />
        </div>
        <div className="login-field">
          <label htmlFor="account-current-password">{ru ? 'Текущий пароль (для подтверждения)' : 'Current password (to confirm)'}</label>
          <input id="account-current-password" type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} disabled={saving} />
        </div>
        <button className="login-submit" type="submit" disabled={saving}>{saving ? (ru ? 'Сохранение…' : 'Saving…') : (ru ? 'Сохранить email' : 'Save email')}</button>
      </form>
      <div className="account-reset-row">
        <div>
          <h3>{ru ? 'Забыли пароль?' : 'Forgot your password?'}</h3>
          <p>{ru ? 'Мы отправим одноразовую ссылку. После смены пароля все остальные сеансы завершатся.' : 'We will send a one-time link. Changing the password signs out all other sessions.'}</p>
        </div>
        <button type="button" className="wk-inline-secondary" onClick={sendResetLink} disabled={!savedEmail || sending}>
          {sending ? (ru ? 'Отправка…' : 'Sending…') : (ru ? 'Отправить ссылку' : 'Send reset link')}
        </button>
      </div>
      {error ? <p className="login-error" role="alert">{error}</p> : null}
      {message ? <p className="form-status" role="status">{message}</p> : null}
    </section>
  );
}
