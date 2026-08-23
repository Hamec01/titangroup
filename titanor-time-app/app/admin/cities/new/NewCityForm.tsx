'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

const CSRF_HEADER_VALUE = 'titanor-time';

interface Attempt {
  key: string;
  body: string;
}

export function NewCityForm() {
  const router = useRouter();
  const ru = useAppLocale() === 'RU';
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [unknownResult, setUnknownResult] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const attemptRef = useRef<Attempt | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) return;
    pendingRef.current = true;
    setLoading(true);
    setErrorMessage(null);

    const attempt = attemptRef.current ?? { key: crypto.randomUUID(), body: JSON.stringify({ name }) };
    attemptRef.current = attempt;

    try {
      const response = await fetch('/api/admin/cities', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': CSRF_HEADER_VALUE,
          'Idempotency-Key': attempt.key
        },
        body: attempt.body
      });

      if (response.ok) {
        router.push('/admin/cities');
        router.refresh();
        return;
      }

      attemptRef.current = null;
      setUnknownResult(false);
      const responseBody = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      switch (responseBody?.error?.code) {
        case 'DUPLICATE_CITY_NAME':
          setErrorMessage(ru ? 'Город с таким названием уже существует.' : 'A city with this name already exists.');
          break;
        case 'VALIDATION_ERROR':
          setErrorMessage(ru ? 'Введите название города от 1 до 255 символов.' : 'Enter a city name between 1 and 255 characters.');
          break;
        case 'FORBIDDEN':
          setErrorMessage(ru ? 'У вас больше нет права создавать города.' : 'You no longer have permission to create cities.');
          break;
        case 'NOT_AUTHENTICATED':
          setErrorMessage(ru ? 'Сессия истекла — войдите снова.' : 'Your session expired — please sign in again.');
          break;
        default:
          setErrorMessage(ru ? 'Не удалось создать город. Попробуйте снова.' : 'Could not create the city. Please try again.');
      }
    } catch {
      setUnknownResult(true);
      setErrorMessage(ru ? 'Результат неизвестен из-за потери соединения. Повторная отправка безопасна — уйдёт точно такой же запрос.' : 'Result unknown because the connection was lost. Retry sends the exact same request safely.');
    } finally {
      pendingRef.current = false;
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} aria-busy={loading} noValidate>
      <div className="login-field">
        <label htmlFor="city-name">{ru ? 'Название города' : 'City name'}</label>
        <input
          id="city-name"
          name="name"
          type="text"
          required
          maxLength={255}
          disabled={loading || unknownResult}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      {errorMessage ? (
        <p className="login-error" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <button className="login-submit" type="submit" disabled={loading}>
        {loading ? (ru ? 'Создание…' : 'Creating…') : unknownResult ? (ru ? 'Повторить запрос' : 'Retry same request') : (ru ? 'Создать город' : 'Create city')}
      </button>
    </form>
  );
}
