'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §0 — required on every mutating request.
const CSRF_HEADER_VALUE = 'titanor-time';

export function NewPeriodForm() {
  const router = useRouter();
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Same reasoning as NewSiteForm.tsx: reused across a retry of an identical submission so a lost
  // response doesn't open a second period; cleared once a real response comes back.
  const idempotencyKeyRef = useRef<string | null>(null);

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
      const response = await fetch('/api/admin/periods', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE, 'Idempotency-Key': idempotencyKeyRef.current },
        body: JSON.stringify({ startDate, endDate })
      });

      if (!response.ok) {
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
            setErrorMessage(fieldErrors ? `Please check: ${Object.keys(fieldErrors).join(', ')}.` : 'Invalid form data.');
            break;
          case 'PERIOD_OVERLAP':
            setErrorMessage('This date range overlaps an existing period.');
            break;
          case 'FORBIDDEN':
            setErrorMessage('You no longer have permission to open periods.');
            break;
          default:
            setErrorMessage('Something went wrong. Please try again.');
        }
        setLoading(false);
        return;
      }

      const created = (await response.json()) as { id: string };
      router.push(`/admin/periods/${created.id}`);
    } catch {
      setErrorMessage('Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} aria-busy={loading}>
      <div className="login-field">
        <label htmlFor="period-start">Start date</label>
        <input id="period-start" name="startDate" type="date" required disabled={loading} value={startDate} onChange={(event) => setStartDate(event.target.value)} />
      </div>

      <div className="login-field">
        <label htmlFor="period-end">End date</label>
        <input id="period-end" name="endDate" type="date" required disabled={loading} value={endDate} onChange={(event) => setEndDate(event.target.value)} />
      </div>

      {errorMessage ? (
        <p className="login-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <button className="login-submit" type="submit" disabled={loading}>
        {loading ? 'Opening…' : 'Open period'}
      </button>
    </form>
  );
}
