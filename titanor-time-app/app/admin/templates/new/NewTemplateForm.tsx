'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  TemplateDaysEditor,
  defaultTemplateDays,
  toggleTemplateWorkingDay,
  updateTemplateDay,
  templateDaysToRequestPayload,
  type TemplateDayState
} from '../TemplateDaysEditor';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §0 — required on every mutating request.
const CSRF_HEADER_VALUE = 'titanor-time';

export function NewTemplateForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [days, setDays] = useState<TemplateDayState[]>(defaultTemplateDays);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Same reuse-only-after-a-network-failure pattern as /admin/sites/new's form —
  // see the comment there for why.
  const idempotencyKeyRef = useRef<string | null>(null);

  function updateDay(weekday: number, patch: Partial<TemplateDayState>): void {
    setDays((current) => updateTemplateDay(current, weekday, patch));
  }

  function toggleWorkingDay(weekday: number, isWorkingDay: boolean): void {
    setDays((current) => toggleTemplateWorkingDay(current, weekday, isWorkingDay));
  }

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
      const response = await fetch('/api/admin/templates', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': CSRF_HEADER_VALUE,
          'Idempotency-Key': idempotencyKeyRef.current
        },
        body: JSON.stringify({
          name,
          description: description || undefined,
          days: templateDaysToRequestPayload(days)
        })
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
            setErrorMessage(fieldErrors?.days?.[0] ?? fieldErrors?.name?.[0] ?? 'Invalid form data.');
            break;
          case 'NOT_AUTHENTICATED':
            setErrorMessage('Your session expired — please sign in again.');
            break;
          case 'FORBIDDEN':
            setErrorMessage('You no longer have permission to create templates.');
            break;
          default:
            setErrorMessage('Something went wrong. Please try again.');
        }
        setLoading(false);
        return;
      }

      router.push('/admin/setup');
    } catch {
      setErrorMessage('Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} aria-busy={loading}>
      <div className="login-field">
        <label htmlFor="template-name">Name</label>
        <input
          id="template-name"
          type="text"
          required
          disabled={loading}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className="login-field">
        <label htmlFor="template-description">Description (optional)</label>
        <textarea
          id="template-description"
          rows={2}
          disabled={loading}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <TemplateDaysEditor days={days} loading={loading} onToggleWorkingDay={toggleWorkingDay} onUpdateDay={updateDay} />

      {errorMessage ? (
        <p className="login-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <button className="login-submit" type="submit" disabled={loading}>
        {loading ? 'Creating…' : 'Create template'}
      </button>
    </form>
  );
}
