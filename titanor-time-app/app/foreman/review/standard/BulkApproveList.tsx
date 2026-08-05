'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

const CSRF_HEADER_VALUE = 'titanor-time';

interface Item {
  id: string;
  timesheetId: string;
  employeeName: string;
  siteName: string;
}

export function BulkApproveList({ items }: { items: Item[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalidIds, setInvalidIds] = useState<Set<string>>(new Set());

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function handleBulkApprove(): Promise<void> {
    if (selected.size === 0) {
      return;
    }
    setLoading(true);
    setError(null);
    setInvalidIds(new Set());
    try {
      const response = await fetch('/api/foreman/review-scopes/bulk-approve', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ reviewScopeIds: [...selected] })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        if (body?.error?.code === 'INVALID_SCOPES' && Array.isArray(body.error.invalidScopeIds)) {
          setInvalidIds(new Set(body.error.invalidScopeIds));
          setError('Some selected timesheets are no longer eligible — nothing was approved. Unselect the highlighted rows and try again.');
        } else {
          setError('Something went wrong. Please try again.');
        }
        setLoading(false);
        return;
      }
      router.refresh();
      setSelected(new Set());
      setLoading(false);
    } catch {
      setError('Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <div>
      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}

      <ul className="setup-list">
        {items.map((item) => (
          <li key={item.id} className={`setup-item${invalidIds.has(item.id) ? ' login-error' : ''}`}>
            <label>
              <input type="checkbox" checked={selected.has(item.id)} disabled={loading} onChange={() => toggle(item.id)} />{' '}
              <Link href={`/foreman/review/${item.timesheetId}`}>
                {item.employeeName} — {item.siteName}
              </Link>
            </label>
          </li>
        ))}
      </ul>

      <button className="login-submit" type="button" disabled={loading || selected.size === 0} onClick={handleBulkApprove}>
        {loading ? 'Approving…' : `Approve selected (${selected.size})`}
      </button>
    </div>
  );
}
