'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';

const CSRF_HEADER_VALUE = 'titanor-time';

export default function PasswordResetRequestPage() {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch('/api/auth/password-reset/request', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ email })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(body?.error?.code === 'DELIVERY_UNAVAILABLE' ? 'Отправка писем временно недоступна. Обратитесь к администратору.' : body?.error?.code === 'RATE_LIMITED' ? 'Слишком много запросов. Попробуйте позже.' : 'Введите корректный email.');
        return;
      }
      setMessage('Если этот email привязан к учётной записи, на него уже отправлена ссылка для нового пароля.');
    } catch {
      setError('Ошибка сети. Повторите попытку.');
    } finally {
      setPending(false);
    }
  }

  return <main className="login-page"><form className="login-card" onSubmit={submit} aria-busy={pending}>
    <h1>Восстановление пароля</h1><p>Введите email, привязанный к вашей учётной записи.</p>
    <div className="login-field"><label htmlFor="recovery-email">Email</label><input id="recovery-email" type="email" autoComplete="email" required maxLength={255} value={email} onChange={(event) => setEmail(event.target.value)} disabled={pending} /></div>
    {error ? <p className="login-error" role="alert">{error}</p> : null}{message ? <p className="form-status" role="status">{message}</p> : null}
    <button className="login-submit" type="submit" disabled={pending}>{pending ? 'Отправка…' : 'Отправить ссылку'}</button><Link className="login-secondary-link" href="/login">Вернуться ко входу</Link>
  </form></main>;
}
