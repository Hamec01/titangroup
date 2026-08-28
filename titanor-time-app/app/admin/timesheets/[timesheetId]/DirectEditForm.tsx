'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

const CSRF_HEADER_VALUE = 'titanor-time';

function describeError(code: string | undefined, ru: boolean): string {
  switch (code) {
    case 'CORRECTION_ALREADY_OPEN':
      return ru ? 'Для этого табеля уже открыта правка — откройте её в разделе «Корректировки».' : 'An edit is already open for this timesheet — open it under Corrections.';
    case 'INVALID_STATE_TRANSITION':
      return ru ? 'Этот табель нельзя изменить в текущем статусе.' : 'This timesheet cannot be edited in its current status.';
    default:
      return ru ? 'Что-то пошло не так. Попробуйте снова.' : 'Something went wrong. Please try again.';
  }
}

// T12 §1b — one click, no reason. Distinct from StartCorrectionForm (which asks for a reason the
// worker sees). Opens the shared /admin/corrections/[id] editor; the applied version is
// source=ADMIN_EDIT so the worker gets no "Часы исправил администратор" notice.
export function DirectEditForm({ timesheetId }: { timesheetId: string }) {
  const router = useRouter();
  const ru = useAppLocale() === 'RU';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStart(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/timesheets/${timesheetId}/direct-edit`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE }
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(describeError(data?.error?.code, ru));
        setLoading(false);
        return;
      }
      router.push(`/admin/corrections/${data.correctionRequestId}`);
    } catch {
      setError(ru ? 'Ошибка сети. Попробуйте снова.' : 'Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <div className="setup-card form">
      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="login-submit" type="button" disabled={loading} onClick={handleStart}>
        {loading ? (ru ? 'Открытие…' : 'Opening…') : (ru ? 'Изменить часы' : 'Edit hours')}
      </button>
      <p className="setup-subtitle" style={{ marginTop: 6 }}>
        {ru
          ? 'Быстрая правка часов по дням без указания причины. Работник уведомление не получает; изменение фиксируется в журнале аудита.'
          : 'Quick per-day hours edit, no reason needed. The worker is not notified; the change is recorded in the audit log.'}
      </p>
    </div>
  );
}
