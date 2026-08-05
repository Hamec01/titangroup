'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const CSRF_HEADER_VALUE = 'titanor-time';

interface Blocker {
  employeeId: string;
  employeeName: string;
  timesheetId: string | null;
  status: string | null;
}

export function LockPeriodAction({ periodId }: { periodId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<Blocker[] | null>(null);

  async function handleLock(): Promise<void> {
    setLoading(true);
    setError(null);
    setBlockers(null);
    try {
      const response = await fetch(`/api/admin/periods/${periodId}/lock`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': CSRF_HEADER_VALUE }
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        if (body?.error?.code === 'NOT_ALL_FINAL_APPROVED' && Array.isArray(body.error.blockers)) {
          setBlockers(body.error.blockers);
        } else {
          setError('Something went wrong. Please try again.');
        }
        setLoading(false);
        return;
      }
      router.refresh();
    } catch {
      setError('Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <div className="setup-card form">
      <button className="login-submit" type="button" disabled={loading} onClick={handleLock}>
        {loading ? 'Locking…' : 'Lock period'}
      </button>

      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}

      {blockers && blockers.length > 0 ? (
        <div>
          <p className="login-error" role="alert">
            Not every participant has reached final approval yet:
          </p>
          <ul className="setup-list">
            {blockers.map((b) => (
              <li key={b.employeeId} className="setup-item">
                <span className="setup-label">{b.employeeName}</span>
                <span className="setup-status setup-status-pending">{b.status ?? 'no timesheet'}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
