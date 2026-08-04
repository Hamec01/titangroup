'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { SiteForemanAssignment } from '@/lib/sites';

const CSRF_HEADER_VALUE = 'titanor-time';

function errorMessageFor(code: string | undefined): string {
  switch (code) {
    case 'VALIDATION_ERROR':
      return 'Please check the fields above.';
    case 'FOREMAN_NOT_FOUND':
      return 'No user with that id.';
    case 'USER_NOT_FOREMAN':
      return 'That user does not currently hold an active FOREMAN role.';
    case 'FORBIDDEN':
      return 'You no longer have permission to assign foremen.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

export function ForemanAssignmentSection({
  siteId,
  foremanAssignments
}: {
  siteId: string;
  foremanAssignments: SiteForemanAssignment[];
}) {
  const router = useRouter();
  const [foremanUserId, setForemanUserId] = useState('');
  const [isSubstitute, setIsSubstitute] = useState(false);
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading) {
      return;
    }
    setErrorMessage(null);
    setLoading(true);

    try {
      const response = await fetch('/api/admin/foreman-assignments', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ foremanUserId, siteId, isSubstitute, validFrom, validTo: validTo || undefined })
      });

      if (!response.ok) {
        let code: string | undefined;
        try {
          const body = (await response.json()) as { error?: { code?: string } };
          code = body.error?.code;
        } catch {
          // Non-JSON error body — fall through to the generic message.
        }
        setErrorMessage(errorMessageFor(code));
        setLoading(false);
        return;
      }

      setForemanUserId('');
      setIsSubstitute(false);
      setValidFrom('');
      setValidTo('');
      router.refresh();
      setLoading(false);
    } catch {
      setErrorMessage('Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <>
      <h2>Foremen</h2>
      {foremanAssignments.length === 0 ? (
        <p>None currently assigned.</p>
      ) : (
        <ul className="setup-list">
          {foremanAssignments.map((assignment) => (
            <li key={assignment.id} className="setup-item">
              <span className="setup-label">
                {assignment.foremanUsername}
                {assignment.isSubstitute ? ' (substitute)' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleCreate} aria-busy={loading}>
        <div className="login-field">
          <label htmlFor="foreman-user-id">Foreman user id (must already have the FOREMAN role)</label>
          <input
            id="foreman-user-id"
            type="text"
            required
            disabled={loading}
            value={foremanUserId}
            onChange={(event) => setForemanUserId(event.target.value)}
          />
        </div>
        <div className="login-field">
          <label htmlFor="foreman-valid-from">Start date</label>
          <input
            id="foreman-valid-from"
            type="date"
            required
            disabled={loading}
            value={validFrom}
            onChange={(event) => setValidFrom(event.target.value)}
          />
        </div>
        <div className="login-field">
          <label htmlFor="foreman-valid-to">End date (optional — leave blank for indefinite)</label>
          <input
            id="foreman-valid-to"
            type="date"
            disabled={loading}
            value={validTo}
            onChange={(event) => setValidTo(event.target.value)}
          />
        </div>
        <div className="login-field">
          <label htmlFor="foreman-is-substitute">
            <input
              id="foreman-is-substitute"
              type="checkbox"
              disabled={loading}
              checked={isSubstitute}
              onChange={(event) => setIsSubstitute(event.target.checked)}
            />{' '}
            Substitute (not the primary foreman)
          </label>
        </div>
        {errorMessage ? (
          <p className="login-error" role="alert">
            {errorMessage}
          </p>
        ) : null}
        <button className="login-submit" type="submit" disabled={loading}>
          {loading ? 'Assigning…' : 'Assign foreman'}
        </button>
      </form>
    </>
  );
}
