'use client';

import { useRef, useState, type FormEvent } from 'react';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §0 — required on every
// mutating request, same as /login and the sites/templates forms.
const CSRF_HEADER_VALUE = 'titanor-time';

export function NewWorkerForm() {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [employeeNumber, setEmployeeNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Idempotency-Key is mandatory for this endpoint (unlike /admin/sites,
  // where it's merely supported) — see POST /api/admin/workers/route.ts.
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
      const response = await fetch('/api/admin/workers', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': CSRF_HEADER_VALUE,
          'Idempotency-Key': idempotencyKeyRef.current
        },
        body: JSON.stringify({
          firstName,
          lastName,
          phone: phone || undefined,
          employeeNumber: employeeNumber || undefined
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
            setErrorMessage(
              fieldErrors ? `Please check: ${Object.keys(fieldErrors).join(', ')}.` : 'Invalid form data.'
            );
            break;
          case 'DUPLICATE_EMPLOYEE_NUMBER':
            setErrorMessage('That employee number is already in use — try another one or leave it blank.');
            break;
          case 'NOT_AUTHENTICATED':
            setErrorMessage('Your session expired — please sign in again.');
            break;
          case 'FORBIDDEN':
            setErrorMessage('You no longer have permission to create workers.');
            break;
          default:
            setErrorMessage('Something went wrong. Please try again.');
        }
        setLoading(false);
        return;
      }

      const body = (await response.json()) as { employee: { id: string } };
      window.location.assign(`/admin/workers/${body.employee.id}`);
      // Deliberately not resetting `loading` here, same as the sites/templates forms.
    } catch {
      setErrorMessage('Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} aria-busy={loading}>
      <div className="login-field">
        <label htmlFor="worker-first-name">First name</label>
        <input
          id="worker-first-name"
          name="firstName"
          type="text"
          required
          disabled={loading}
          value={firstName}
          onChange={(event) => setFirstName(event.target.value)}
        />
      </div>

      <div className="login-field">
        <label htmlFor="worker-last-name">Last name</label>
        <input
          id="worker-last-name"
          name="lastName"
          type="text"
          required
          disabled={loading}
          value={lastName}
          onChange={(event) => setLastName(event.target.value)}
        />
      </div>

      <div className="login-field">
        <label htmlFor="worker-phone">Phone (optional)</label>
        <input
          id="worker-phone"
          name="phone"
          type="tel"
          disabled={loading}
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
        />
      </div>

      <div className="login-field">
        <label htmlFor="worker-employee-number">Employee number (optional — auto-generated if left blank)</label>
        <input
          id="worker-employee-number"
          name="employeeNumber"
          type="text"
          disabled={loading}
          value={employeeNumber}
          onChange={(event) => setEmployeeNumber(event.target.value)}
        />
      </div>

      {errorMessage ? (
        <p className="login-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <button className="login-submit" type="submit" disabled={loading}>
        {loading ? 'Creating…' : 'Create worker'}
      </button>
    </form>
  );
}
