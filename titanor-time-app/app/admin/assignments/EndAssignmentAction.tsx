'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { AssignmentListItem } from '@/lib/assignments';

const CSRF_HEADER_VALUE = 'titanor-time';

// docs/titanor-time/T9_INTERNAL_TEST_PLAN.md §4 (defect D3) — POST
// /api/admin/assignments/:assignmentId/end was already fully implemented (validation, audit,
// reason-required-if-early) but had no UI anywhere calling it. This is the minimal UI for the
// existing contract — no new backend behavior.
export function EndAssignmentAction({ assignment }: { assignment: AssignmentListItem }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [validTo, setValidTo] = useState('');
  const [reason, setReason] = useState('');
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
      const response = await fetch(`/api/admin/assignments/${assignment.id}/end`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ validTo, reason: reason || undefined })
      });

      if (!response.ok) {
        let code: string | undefined;
        let fieldErrors: Record<string, string[]> | undefined;
        try {
          const body = (await response.json()) as { error?: { code?: string; fieldErrors?: Record<string, string[]> } };
          code = body.error?.code;
          fieldErrors = body.error?.fieldErrors;
        } catch {
          // Non-JSON error body — fall through to the generic message.
        }
        if (code === 'VALIDATION_ERROR' && fieldErrors?.reason) {
          setErrorMessage('A reason is required when ending earlier than planned.');
        } else if (code === 'VALIDATION_ERROR') {
          setErrorMessage('Please check the end date.');
        } else if (code === 'FORBIDDEN') {
          setErrorMessage('You no longer have permission to end assignments.');
        } else {
          setErrorMessage('Something went wrong. Please try again.');
        }
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
      <label htmlFor={`end-valid-to-${assignment.id}`}>End date</label>
      <input
        id={`end-valid-to-${assignment.id}`}
        type="date"
        required
        disabled={loading}
        value={validTo}
        onChange={(event) => setValidTo(event.target.value)}
      />
      <label htmlFor={`end-reason-${assignment.id}`}>Reason (required if ending earlier than planned)</label>
      <input
        id={`end-reason-${assignment.id}`}
        type="text"
        disabled={loading}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
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
