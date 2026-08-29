'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

const CSRF_HEADER_VALUE = 'titanor-time';

export default function ResetPasswordTokenPage() {
  const params = useParams<{ token: string }>();
  const token = typeof params.token === 'string' ? params.token : '';
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setError(null);
    if (!token) return setError('Ссылка неполная или недействительна.');
    if (password.length < 8 || password.length > 256) return setError('Пароль должен содержать от 8 до 256 символов.');
    if (password !== confirmation) return setError('Пароли не совпадают.');
    setPending(true);
    try {
      const response = await fetch('/api/auth/password-reset/confirm', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE }, body: JSON.stringify({ token, password })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const code = body?.error?.code;
        setError(code === 'TOKEN_EXPIRED' ? 'Срок действия ссылки истёк. Запросите новую.' : code === 'TOKEN_USED' ? 'Эта ссылка уже использована. Запросите новую.' : 'Ссылка недействительна или больше не может быть использована.');
        return;
      }
      window.history.replaceState(null, '', '/reset-password');
      setCompleted(true);
    } catch {
      setError('Ошибка сети. Повторите попытку.');
    } finally {
      setPending(false);
    }
  }

  if (completed) return <main className="login-page"><div className="login-card"><h1>Пароль изменён</h1><p>Теперь войдите с новым паролем. Все предыдущие сеансы завершены.</p><Link className="login-submit" href="/login">Перейти ко входу</Link></div></main>;
  return <main className="login-page"><form className="login-card" onSubmit={submit} aria-busy={pending}>
    <h1>Новый пароль</h1><p>После сохранения все предыдущие сеансы будут завершены.</p>
    <div className="login-field"><label htmlFor="reset-password">Новый пароль</label><input id="reset-password" type="password" autoComplete="new-password" required disabled={pending} value={password} onChange={(event) => setPassword(event.target.value)} /></div>
    <div className="login-field"><label htmlFor="reset-password-confirmation">Повторите пароль</label><input id="reset-password-confirmation" type="password" autoComplete="new-password" required disabled={pending} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></div>
    {error ? <p className="login-error" role="alert">{error}</p> : null}<button className="login-submit" type="submit" disabled={pending}>{pending ? 'Сохранение…' : 'Сохранить новый пароль'}</button><Link className="login-secondary-link" href="/reset-password/request">Запросить новую ссылку</Link>
  </form></main>;
}
