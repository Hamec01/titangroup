'use client';

import { useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { ForemanSelectableEmployee } from '@/lib/users';
import { ActivationCodeIssuer } from '../ActivationCodeIssuer';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §14 — POST /api/admin/users, both modes.
const CSRF_HEADER_VALUE = 'titanor-time';
const LOCALES = ['FI', 'EN', 'RU'] as const;
type Locale = (typeof LOCALES)[number];
type Mode = 'STANDALONE' | 'EXISTING_EMPLOYEE';

interface CreatedUser {
  id: string;
  username: string;
  status: string;
}

function describeCreateError(code: string | undefined, fieldErrors: Record<string, string[]> | undefined): string {
  switch (code) {
    case 'VALIDATION_ERROR':
      return fieldErrors ? `Please check: ${Object.keys(fieldErrors).join(', ')}.` : 'Please check the fields above.';
    case 'DUPLICATE_USERNAME':
      return 'That username is already in use.';
    case 'DUPLICATE_EMAIL':
      return 'That email is already in use.';
    case 'EMPLOYEE_NOT_FOUND':
      return 'That worker no longer exists.';
    case 'EMPLOYEE_USER_MISSING':
      return 'That worker has no linked account.';
    case 'USER_NOT_ELIGIBLE':
      return "That worker's account is not eligible for the FOREMAN role right now (offboarded or deactivated).";
    case 'USER_ALREADY_FOREMAN':
      return 'That worker already has an active or scheduled FOREMAN role.';
    case 'NOT_AUTHENTICATED':
      return 'Your session expired — please sign in again.';
    case 'FORBIDDEN':
      return 'You no longer have permission to create foreman accounts.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

export function NewUserForm({ employees }: { employees: ForemanSelectableEmployee[] }) {
  const [mode, setMode] = useState<Mode>('STANDALONE');

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [locale, setLocale] = useState<Locale>('FI');
  const [employeeId, setEmployeeId] = useState('');

  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);

  const [createdStandalone, setCreatedStandalone] = useState<CreatedUser | null>(null);
  const [createdDualRole, setCreatedDualRole] = useState<{ username: string; status: string } | null>(null);

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

    const body =
      mode === 'STANDALONE'
        ? { mode: 'STANDALONE', username, email: email.trim() ? email : undefined, locale }
        : { mode: 'EXISTING_EMPLOYEE', employeeId };

    try {
      const response = await fetch('/api/admin/users', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': CSRF_HEADER_VALUE,
          'Idempotency-Key': idempotencyKeyRef.current
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        idempotencyKeyRef.current = null;
        let code: string | undefined;
        let fieldErrors: Record<string, string[]> | undefined;
        try {
          const errorResponseBody = (await response.json()) as { error?: { code?: string; fieldErrors?: Record<string, string[]> } };
          code = errorResponseBody.error?.code;
          fieldErrors = errorResponseBody.error?.fieldErrors;
        } catch {
          // Non-JSON error body — fall through to the generic message.
        }
        setErrorMessage(describeCreateError(code, fieldErrors));
        setLoading(false);
        return;
      }

      const result = (await response.json()) as { id: string; username: string; status: string };
      if (mode === 'STANDALONE') {
        setCreatedStandalone({ id: result.id, username: result.username, status: result.status });
      } else {
        setCreatedDualRole({ username: result.username, status: result.status });
      }
      setLoading(false);
    } catch {
      setErrorMessage('Network error. Please try again.');
      setLoading(false);
    }
  }

  if (createdStandalone) {
    return (
      <div>
        <p>
          Account created: <strong>{createdStandalone.username}</strong>
        </p>
        <ActivationCodeIssuer userId={createdStandalone.id} autoIssue />
        <p>
          <Link href="/admin/users">Back to Users list</Link>
        </p>
      </div>
    );
  }

  if (createdDualRole) {
    return (
      <div>
        <p>
          FOREMAN role granted to <strong>{createdDualRole.username}</strong>.
        </p>
        {createdDualRole.status === 'ACTIVE' ? (
          <p>This worker already has a password and can log in as usual — no new code is needed.</p>
        ) : (
          <p>
            This worker will set their password through the normal worker activation flow — a separate system
            activation code is not needed.
          </p>
        )}
        <p>
          <Link href="/admin/users">Back to Users list</Link>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} aria-busy={loading}>
      <div className="login-locale-switch" role="group" aria-label="Creation mode">
        <button type="button" aria-pressed={mode === 'STANDALONE'} disabled={loading} onClick={() => setMode('STANDALONE')}>
          Standalone foreman
        </button>
        <button
          type="button"
          aria-pressed={mode === 'EXISTING_EMPLOYEE'}
          disabled={loading}
          onClick={() => setMode('EXISTING_EMPLOYEE')}
        >
          Existing worker (dual-role)
        </button>
      </div>

      {mode === 'STANDALONE' ? (
        <>
          <div className="login-field">
            <label htmlFor="user-username">Username</label>
            <input
              id="user-username"
              name="username"
              type="text"
              required
              minLength={3}
              maxLength={64}
              disabled={loading}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>

          <div className="login-field">
            <label htmlFor="user-email">Email (optional)</label>
            <input
              id="user-email"
              name="email"
              type="email"
              maxLength={255}
              disabled={loading}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="login-field">
            <label>Locale</label>
            <div className="login-locale-switch" role="group" aria-label="Locale">
              {LOCALES.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={locale === candidate}
                  disabled={loading}
                  onClick={() => setLocale(candidate)}
                >
                  {candidate}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : employees.length === 0 ? (
        <p>No workers yet — create one from Workers first.</p>
      ) : (
        <>
          <div className="login-field">
            <label htmlFor="user-employee">Worker</label>
            <select
              id="user-employee"
              required
              disabled={loading}
              value={employeeId}
              onChange={(event) => setEmployeeId(event.target.value)}
            >
              <option value="" disabled>
                Select a worker…
              </option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.firstName} {employee.lastName} — #{employee.employeeNumber}
                  {employee.userStatus ? ` (${employee.userStatus})` : ''}
                </option>
              ))}
            </select>
          </div>
          <p className="setup-subtitle">
            If the selected worker is ACTIVE, they keep their existing password — no new code is issued. If
            PENDING_ACTIVATION, they will set their password through the normal worker activation flow — a
            separate system activation code is not needed.
          </p>
        </>
      )}

      {errorMessage ? (
        <p className="login-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <button
        className="login-submit"
        type="submit"
        disabled={loading || (mode === 'EXISTING_EMPLOYEE' && employees.length === 0)}
      >
        {loading ? 'Creating…' : mode === 'STANDALONE' ? 'Create foreman' : 'Grant FOREMAN role'}
      </button>
    </form>
  );
}
