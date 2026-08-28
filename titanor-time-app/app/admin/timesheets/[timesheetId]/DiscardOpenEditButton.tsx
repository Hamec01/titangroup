'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

const CSRF_HEADER_VALUE = 'titanor-time';

// T12 — on the timesheet card, when an admin edit / correction draft is open, let the admin drop
// it right here (rather than only being able to go into the editor). After discard the card shows
// the normal Approve / Edit / Return actions again.
export function DiscardOpenEditButton({ correctionRequestId }: { correctionRequestId: string }) {
  const router = useRouter();
  const ru = useAppLocale() === 'RU';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDiscard(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/corrections/${correctionRequestId}/discard`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE }
      });
      if (!res.ok) {
        setError(ru ? 'Не удалось отменить правку — обновите страницу.' : 'Could not discard the edit — refresh the page.');
        setLoading(false);
        return;
      }
      router.refresh();
    } catch {
      setError(ru ? 'Ошибка сети. Попробуйте снова.' : 'Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <>
      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="wk-clock-cancel-button" type="button" disabled={loading} onClick={handleDiscard}>
        {loading ? (ru ? 'Отмена…' : 'Discarding…') : ru ? 'Отменить правку и вернуться к утверждению' : 'Discard the edit and go back to approval'}
      </button>
    </>
  );
}
