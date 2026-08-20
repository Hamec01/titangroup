'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

const CSRF_HEADER_VALUE = 'titanor-time';

interface Attempt {
  key: string;
  body: string;
}

export function NewCityForm() {
  const router = useRouter();
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
        router.push('/admin/setup');
        router.refresh();
        return;
      }

      attemptRef.current = null;
      setUnknownResult(false);
      const responseBody = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      switch (responseBody?.error?.code) {
        case 'DUPLICATE_CITY_NAME':
          setErrorMessage('A city with this name already exists.');
          break;
        case 'VALIDATION_ERROR':
          setErrorMessage('Enter a city name between 1 and 255 characters.');
          break;
        case 'FORBIDDEN':
          setErrorMessage('You no longer have permission to create cities.');
          break;
        case 'NOT_AUTHENTICATED':
          setErrorMessage('Your session expired — please sign in again.');
          break;
        default:
          setErrorMessage('Could not create the city. Please try again.');
      }
    } catch {
      setUnknownResult(true);
      setErrorMessage('Result unknown because the connection was lost. Retry sends the exact same request safely.');
    } finally {
      pendingRef.current = false;
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} aria-busy={loading} noValidate>
      <div className="login-field">
        <label htmlFor="city-name">City name</label>
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
        {loading ? 'Creating…' : unknownResult ? 'Retry same request' : 'Create city'}
      </button>
    </form>
  );
}
