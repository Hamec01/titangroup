'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

const CSRF_HEADER_VALUE = 'titanor-time';

function describeError(code: string | undefined, ru: boolean): string {
  switch (code) {
    case 'CORRECTION_ALREADY_OPEN':
      return ru ? 'Для этого табеля уже открыта корректировка.' : 'A correction is already open for this timesheet.';
    case 'INVALID_STATE_TRANSITION':
      return ru ? 'Скорректировать можно только окончательно одобренный табель.' : 'Only a FINAL_APPROVED timesheet can be corrected.';
    default:
      return ru ? 'Что-то пошло не так. Попробуйте снова.' : 'Something went wrong. Please try again.';
  }
}

export function RequestCorrectionForm({ timesheetId }: { timesheetId: string }) {
  const router = useRouter();
  const ru = useAppLocale() === 'RU';
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(): Promise<void> {
    if (reason.trim().length === 0) {
      setError(ru ? 'Требуется указать причину.' : 'A reason is required.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/corrections', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ timesheetId, reason: reason.trim() })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(describeError(data?.error?.code, ru));
        setLoading(false);
        return;
      }
      router.push(`/admin/corrections/${data.id}`);
    } catch {
      setError(ru ? 'Ошибка сети. Попробуйте снова.' : 'Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <div className="setup-card form">
      <p className="setup-subtitle">{ru ? 'Запросите корректировку — исходная отправка работника остаётся без изменений, пока она не будет одобрена.' : "Request a correction — the worker's original submission stays untouched until this is approved."}</p>
      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="login-field">
        <label htmlFor="correction-reason">{ru ? 'Причина' : 'Reason'}</label>
        <textarea id="correction-reason" rows={3} disabled={loading} value={reason} onChange={(event) => setReason(event.target.value)} />
      </div>
      <button className="login-submit" type="button" disabled={loading} onClick={handleSubmit}>
        {loading ? (ru ? 'Отправка запроса…' : 'Requesting…') : (ru ? 'Запросить корректировку' : 'Request correction')}
      </button>
    </div>
  );
}
