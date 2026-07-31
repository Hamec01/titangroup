'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §0 — required on every
// mutating request, same as /login.
const CSRF_HEADER_VALUE = 'titanor-time';

interface CityOption {
  id: string;
  name: string;
}

export function NewSiteForm() {
  const router = useRouter();
  const [cities, setCities] = useState<CityOption[]>([]);
  const [name, setName] = useState('');
  const [cityId, setCityId] = useState('');
  const [address, setAddress] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Reused across a retry of an identical submission (see below) so a lost
  // response doesn't create a second site; cleared whenever the previous
  // attempt got a real HTTP response, since the user is then editing before
  // trying again — a changed body under the old key would just get
  // IDEMPOTENCY_KEY_REUSED instead of being processed.
  const idempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/cities', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((body: { items?: CityOption[] }) => {
        if (!cancelled) {
          setCities(body.items ?? []);
        }
      })
      .catch(() => {
        // City list is a convenience (city is optional per the contract) —
        // a failed fetch just leaves the dropdown empty, not a form error.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading) {
      return;
    }
    setErrorMessage(null);
    setLoading(true);

    if (idempotencyKeyRef.current === null) {
      idempotencyKeyRef.current = crypto.randomUUID();
    }

    try {
      const response = await fetch('/api/admin/sites', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': CSRF_HEADER_VALUE,
          'Idempotency-Key': idempotencyKeyRef.current
        },
        body: JSON.stringify({
          name,
          cityId: cityId || undefined,
          address: address || undefined,
          description: description || undefined
        })
      });

      if (!response.ok) {
        // A real response was received (even if an error) — this key is
        // spent for this exact body. Clear it so the next attempt (likely
        // with edited fields) gets a fresh one.
        idempotencyKeyRef.current = null;

        let code: string | undefined;
        let fieldErrors: Record<string, string[]> | undefined;
        try {
          const body = (await response.json()) as { error?: { code?: string; fieldErrors?: Record<string, string[]> } };
          code = body.error?.code;
          fieldErrors = body.error?.fieldErrors;
        } catch {
          // Non-JSON error body — fall through to the generic message.
        }

        switch (code) {
          case 'VALIDATION_ERROR':
            setErrorMessage(
              fieldErrors ? `Please check: ${Object.keys(fieldErrors).join(', ')}.` : 'Invalid form data.'
            );
            break;
          case 'CITY_NOT_FOUND':
            setErrorMessage('Selected city no longer exists — please pick another one.');
            break;
          case 'NOT_AUTHENTICATED':
            setErrorMessage('Your session expired — please sign in again.');
            break;
          case 'FORBIDDEN':
            setErrorMessage('You no longer have permission to create sites.');
            break;
          default:
            setErrorMessage('Something went wrong. Please try again.');
        }
        setLoading(false);
        return;
      }

      router.push('/admin/setup');
      // Deliberately not resetting `loading` here, same as /login — the
      // form stays disabled through navigation.
    } catch {
      // Network-level failure — keep idempotencyKeyRef so a manual retry of
      // this exact request is safely deduped server-side if it actually
      // went through.
      setErrorMessage('Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} aria-busy={loading}>
      <div className="login-field">
        <label htmlFor="site-name">Name</label>
        <input
          id="site-name"
          name="name"
          type="text"
          required
          disabled={loading}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className="login-field">
        <label htmlFor="site-city">City (optional)</label>
        <select
          id="site-city"
          name="cityId"
          disabled={loading}
          value={cityId}
          onChange={(event) => setCityId(event.target.value)}
        >
          <option value="">No city</option>
          {cities.map((city) => (
            <option key={city.id} value={city.id}>
              {city.name}
            </option>
          ))}
        </select>
      </div>

      <div className="login-field">
        <label htmlFor="site-address">Address (optional)</label>
        <input
          id="site-address"
          name="address"
          type="text"
          disabled={loading}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
      </div>

      <div className="login-field">
        <label htmlFor="site-description">Description (optional)</label>
        <textarea
          id="site-description"
          name="description"
          rows={3}
          disabled={loading}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      {errorMessage ? (
        <p className="login-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <button className="login-submit" type="submit" disabled={loading}>
        {loading ? 'Creating…' : 'Create site'}
      </button>
    </form>
  );
}
