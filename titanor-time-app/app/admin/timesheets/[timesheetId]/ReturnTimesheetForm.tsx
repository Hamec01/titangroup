'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

const CSRF = 'titanor-time';

// Task B — return the WHOLE timesheet to the worker with a reason. Works for SUBMITTED and
// FOREMAN_APPROVED (lib/admin-timesheets.ts returnTimesheetOverride). Collapsed by default so the
// card's primary action stays "Approve".
export function ReturnTimesheetForm({ timesheetId }: { timesheetId: string }) {
  const router = useRouter();
  const ru = useAppLocale() === 'RU';
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReturn(): Promise<void> {
    if (reason.trim().length === 0) {
      setError(ru ? 'Укажите причину — её увидит работник.' : 'Enter a reason — the worker will see it.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/timesheets/${timesheetId}/return`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF },
        body: JSON.stringify({ returnReason: reason.trim() })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(
          body?.error?.code === 'INVALID_STATE_TRANSITION'
            ? ru
              ? 'Табель больше не в статусе для возврата — обновите страницу.'
              : 'This timesheet is no longer returnable — refresh.'
            : ru
              ? 'Что-то пошло не так. Попробуйте снова.'
              : 'Something went wrong. Please try again.'
        );
        setLoading(false);
        return;
      }
      router.push('/admin/review');
    } catch {
      setError(ru ? 'Ошибка сети. Попробуйте снова.' : 'Network error. Please try again.');
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <div className="setup-card form">
        <button type="button" className="wk-clock-cancel-button" onClick={() => setOpen(true)}>
          {ru ? 'Вернуть работнику' : 'Return to worker'}
        </button>
      </div>
    );
  }

  return (
    <div className="setup-card form">
      <p className="setup-subtitle">
        {ru
          ? 'Весь табель вернётся работнику на доработку. Мелкую ошибку быстрее исправить самому — «Исправить часы».'
          : "The whole timesheet goes back to the worker to redo. For a small mistake, “Edit hours” is faster."}
      </p>
      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="login-field">
        <label htmlFor="return-ts-reason">{ru ? 'Причина возврата' : 'Return reason'}</label>
        <textarea id="return-ts-reason" rows={3} disabled={loading} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <button type="button" className="login-submit" disabled={loading} onClick={handleReturn}>
        {loading ? (ru ? 'Возврат…' : 'Returning…') : (ru ? 'Вернуть весь табель' : 'Return whole timesheet')}
      </button>
      <button type="button" className="wk-clock-cancel-button" disabled={loading} onClick={() => setOpen(false)}>
        {ru ? 'Отмена' : 'Cancel'}
      </button>
    </div>
  );
}
