'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

const CSRF_HEADER_VALUE = 'titanor-time';

// T12 (owner model) — the worker already sent this week but wants to keep editing. While the
// period is open and before the cutoff, "Отправить" is a soft signal — this takes it back.
export function ReopenForEditsButton({ timesheetId, label }: { timesheetId: string; label?: string }) {
  const router = useRouter();
  const ru = useAppLocale() === 'RU';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReopen(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/worker/timesheets/${timesheetId}/reopen`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE }
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(
          data?.error?.code === 'EDIT_WINDOW_CLOSED'
            ? ru
              ? 'Неделя уже закрыта — правки больше нельзя вносить.'
              : 'This week is already closed — no more edits.'
            : ru
              ? 'Не получилось. Обновите страницу и попробуйте снова.'
              : "Couldn't do that. Refresh and try again."
        );
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
      <button type="button" className="wk-action-button" disabled={loading} onClick={handleReopen}>
        {loading ? (ru ? 'Открываю…' : 'Opening…') : (label ?? (ru ? 'Внести правки' : 'Make changes'))}
      </button>
    </>
  );
}
