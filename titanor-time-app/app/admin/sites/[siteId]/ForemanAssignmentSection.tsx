'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { SiteForemanAssignment } from '@/lib/sites';
import type { AssignableForeman } from '@/lib/foreman-assignments';

const CSRF_HEADER_VALUE = 'titanor-time';

function errorMessageFor(code: string | undefined): string {
  switch (code) {
    case 'VALIDATION_ERROR':
      return 'Please check the fields above.';
    case 'FOREMAN_NOT_FOUND':
      return 'That foreman account no longer exists.';
    case 'USER_NOT_FOREMAN':
      return 'That user does not currently hold an active FOREMAN role.';
    case 'FOREMAN_NOT_ELIGIBLE':
      return "That user's account status does not allow a foreman assignment (offboarded or deactivated).";
    case 'FORBIDDEN':
      return 'You no longer have permission to assign foremen.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

// Visible label only — the underlying option value is the User UUID, never shown to the admin.
function labelFor(foreman: AssignableForeman): string {
  if (foreman.employee) {
    return `${foreman.employee.firstName} ${foreman.employee.lastName} (#${foreman.employee.employeeNumber}) — ${foreman.username} — ${foreman.status}`;
  }
  return `${foreman.username} — ${foreman.status}`;
}

// docs/titanor-time/T9_INTERNAL_TEST_PLAN.md §4 (defect D4) — POST
// /api/admin/foreman-assignments/:id/end was already fully implemented but had no UI anywhere
// calling it. Minimal UI for the existing contract, same shape as EndAssignmentAction.tsx.
function EndForemanAssignmentAction({ assignmentId }: { assignmentId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [validTo, setValidTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading) {
      return;
    }
    setErrorMessage(null);
    setLoading(true);

    try {
      const response = await fetch(`/api/admin/foreman-assignments/${assignmentId}/end`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ validTo })
      });

      if (!response.ok) {
        let code: string | undefined;
        try {
          const body = (await response.json()) as { error?: { code?: string } };
          code = body.error?.code;
        } catch {
          // Non-JSON error body — fall through to the generic message.
        }
        setErrorMessage(code === 'FORBIDDEN' ? 'You no longer have permission to end foreman assignments.' : 'Please check the end date.');
        setLoading(false);
        return;
      }

      router.refresh();
      setLoading(false);
      setOpen(false);
    } catch {
      setErrorMessage('Network error. Please try again.');
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="setup-action" onClick={() => setOpen(true)}>
        End
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} aria-busy={loading} className="assignment-end-form">
      <label htmlFor={`foreman-end-valid-to-${assignmentId}`}>End date</label>
      <input
        id={`foreman-end-valid-to-${assignmentId}`}
        type="date"
        required
        disabled={loading}
        value={validTo}
        onChange={(event) => setValidTo(event.target.value)}
      />
      {errorMessage ? (
        <p className="login-error" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <button type="submit" className="setup-action" disabled={loading}>
        {loading ? 'Ending…' : 'Confirm end'}
      </button>
      <button type="button" className="setup-action" disabled={loading} onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

export function ForemanAssignmentSection({
  siteId,
  foremanAssignments,
  assignableForemen
}: {
  siteId: string;
  foremanAssignments: SiteForemanAssignment[];
  assignableForemen: AssignableForeman[];
}) {
  const router = useRouter();
  const [foremanUserId, setForemanUserId] = useState('');
  const [isSubstitute, setIsSubstitute] = useState(false);
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectedForeman = assignableForemen.find((foreman) => foreman.id === foremanUserId) ?? null;
  const hasCandidates = assignableForemen.length > 0;

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
              <EndForemanAssignmentAction assignmentId={assignment.id} />
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleCreate} aria-busy={loading}>
        <div className="login-field">
          <label htmlFor="foreman-select">Foreman</label>
          {hasCandidates ? (
            <select
              id="foreman-select"
              required
              disabled={loading}
              value={foremanUserId}
              onChange={(event) => setForemanUserId(event.target.value)}
            >
              <option value="" disabled>
                Select a foreman…
              </option>
              {assignableForemen.map((foreman) => (
                <option key={foreman.id} value={foreman.id}>
                  {labelFor(foreman)}
                </option>
              ))}
            </select>
          ) : (
            <p>
              No eligible foremen yet.{' '}
              <Link href="/admin/users/new">Create or activate a foreman account first.</Link>
            </p>
          )}
        </div>
        {selectedForeman?.status === 'PENDING_ACTIVATION' ? (
          <p className="setup-subtitle">
            This assignment will be saved now, but this foreman can only log in once their account is activated.
          </p>
        ) : null}
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
        <button className="login-submit" type="submit" disabled={loading || !hasCandidates}>
          {loading ? 'Assigning…' : 'Assign foreman'}
        </button>
      </form>
    </>
  );
}
