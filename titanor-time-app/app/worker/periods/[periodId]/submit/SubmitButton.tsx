'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const CSRF_HEADER_VALUE = 'titanor-time';

function describeError(code: string | undefined): string {
  switch (code) {
    case 'INVALID_STATE_TRANSITION':
      return 'This timesheet can no longer be submitted (it may already be submitted).';
    case 'UNRESOLVED_PROPOSALS':
      return 'Some foreman proposals still need your response before you can submit.';
    default:
      return 'Could not submit — please try again.';
  }
}

export default function SubmitButton({ periodId, timesheetId }: { periodId: string; timesheetId: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/worker/timesheets/${timesheetId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE }
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(describeError(data?.error?.code));
        setSubmitting(false);
        return;
      }
      router.push(`/worker/periods/${periodId}`);
    } catch {
      setError('Network error — please try again.');
      setSubmitting(false);
    }
  }

  return (
    <>
      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="wk-action-button" onClick={handleSubmit} disabled={submitting}>
        {submitting ? 'Submitting…' : 'Submit timesheet'}
      </button>
    </>
  );
}
