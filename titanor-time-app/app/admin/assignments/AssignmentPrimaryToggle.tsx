'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AssignmentListItem } from '@/lib/assignments';

const CSRF_HEADER_VALUE = 'titanor-time';

// Only isPrimary — endedReason editing needs a real assignment detail page
// (not built yet) to be a reasonable UX; this list row only exposes the one
// action that's genuinely a one-click toggle.
export function AssignmentPrimaryToggle({ assignment }: { assignment: AssignmentListItem }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleClick(): Promise<void> {
    if (loading) {
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/assignments/${assignment.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ version: assignment.version, isPrimary: !assignment.isPrimary })
      });
      if (!response.ok) {
        let code: string | undefined;
        try {
          const body = (await response.json()) as { error?: { code?: string } };
          code = body.error?.code;
        } catch {
          // Non-JSON error body — fall through to the generic message.
        }
        window.alert(
          code === 'VERSION_CONFLICT'
            ? 'This assignment was changed elsewhere — reloading.'
            : code === 'FORBIDDEN'
              ? 'You no longer have permission to edit assignments.'
              : 'Something went wrong. Please try again.'
        );
        if (code === 'VERSION_CONFLICT') {
          router.refresh();
        }
        setLoading(false);
        return;
      }
      router.refresh();
    } catch {
      window.alert('Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <button type="button" className="setup-action" onClick={handleClick} disabled={loading}>
      {assignment.isPrimary ? 'Unset primary' : 'Set primary'}
    </button>
  );
}
