'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const CSRF_HEADER_VALUE = 'titanor-time';

function describeError(code: string | undefined): string {
  switch (code) {
    case 'INVALID_STATE_TRANSITION':
      return 'This timesheet is no longer in FOREMAN_APPROVED status.';
    case 'TIMESHEET_NOT_FOUND':
      return 'This timesheet no longer exists.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

export function FinalApprovalActions({ timesheetId }: { timesheetId: string }) {
  const router = useRouter();
  const [returnReason, setReturnReason] = useState('');
  const [loading, setLoading] = useState<'approve' | 'return' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFinalApprove(): Promise<void> {
    setLoading('approve');
    setError(null);
    try {
      const response = await fetch(`/api/admin/timesheets/${timesheetId}/final-approve`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE }
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(describeError(body?.error?.code));
        setLoading(null);
        return;
      }
      router.push('/admin/timesheets');
    } catch {
      setError('Network error. Please try again.');
      setLoading(null);
    }
  }

  async function handleReturn(): Promise<void> {
    if (returnReason.trim().length === 0) {
      setError('A reason is required to return a timesheet.');
      return;
    }
    setLoading('return');
    setError(null);
    try {
      const response = await fetch(`/api/admin/timesheets/${timesheetId}/return`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ returnReason: returnReason.trim() })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(describeError(body?.error?.code));
        setLoading(null);
        return;
      }
      router.push('/admin/timesheets');
    } catch {
      setError('Network error. Please try again.');
      setLoading(null);
    }
  }

  return (
    <div className="setup-card form">
      <p className="setup-subtitle">No hours can be edited from this screen — final approval never changes data. Disagree? Return the whole timesheet instead.</p>

      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}

      <button className="login-submit" type="button" disabled={loading !== null} onClick={handleFinalApprove}>
        {loading === 'approve' ? 'Approving…' : 'Final approve'}
      </button>

      <div className="login-field">
        <label htmlFor="override-return-reason">Return reason (whole timesheet)</label>
        <textarea id="override-return-reason" rows={3} disabled={loading !== null} value={returnReason} onChange={(event) => setReturnReason(event.target.value)} />
      </div>
      <button className="login-submit" type="button" disabled={loading !== null} onClick={handleReturn}>
        {loading === 'return' ? 'Returning…' : 'Return whole timesheet'}
      </button>
    </div>
  );
}
