'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const CSRF_HEADER_VALUE = 'titanor-time';

function describeError(code: string | undefined): string {
  switch (code) {
    case 'STALE_REVIEW_SCOPE':
      return 'This scope is no longer pending against the current version (it may have already been reviewed, or the worker resubmitted).';
    case 'SELF_APPROVAL_FORBIDDEN':
      return 'You cannot review your own timesheet.';
    case 'REVIEW_SCOPE_NOT_FOUND':
      return 'This scope no longer exists.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

export function ReviewActions({ reviewScopeId }: { reviewScopeId: string }) {
  const router = useRouter();
  const [returnReason, setReturnReason] = useState('');
  const [loading, setLoading] = useState<'approve' | 'return' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleApprove(): Promise<void> {
    setLoading('approve');
    setError(null);
    try {
      const response = await fetch(`/api/admin/review-scopes/${reviewScopeId}/approve`, {
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
      router.push('/admin/review-scopes');
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
      const response = await fetch(`/api/admin/review-scopes/${reviewScopeId}/return`, {
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
      router.push('/admin/review-scopes');
    } catch {
      setError('Network error. Please try again.');
      setLoading(null);
    }
  }

  return (
    <div className="setup-card form">
      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}

      <button className="login-submit" type="button" disabled={loading !== null} onClick={handleApprove}>
        {loading === 'approve' ? 'Approving…' : 'Approve'}
      </button>

      <div className="login-field">
        <label htmlFor="return-reason">Return reason</label>
        <textarea id="return-reason" rows={3} disabled={loading !== null} value={returnReason} onChange={(event) => setReturnReason(event.target.value)} />
      </div>
      <button className="login-submit" type="button" disabled={loading !== null} onClick={handleReturn}>
        {loading === 'return' ? 'Returning…' : 'Return to worker'}
      </button>
    </div>
  );
}
