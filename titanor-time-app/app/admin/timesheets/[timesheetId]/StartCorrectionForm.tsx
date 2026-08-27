'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

const CSRF_HEADER_VALUE = 'titanor-time';

function describeError(code: string | undefined, ru: boolean): string {
  switch (code) {
    case 'CORRECTION_ALREADY_OPEN':
      return ru ? 'Для этого табеля уже открыта корректировка — откройте её в разделе «Корректировки».' : 'A correction is already open for this timesheet — open it under Corrections.';
    case 'INVALID_STATE_TRANSITION':
      return ru ? 'Этот табель нельзя исправить в текущем статусе.' : 'This timesheet cannot be corrected in its current status.';
    default:
      return ru ? 'Что-то пошло не так. Попробуйте снова.' : 'Something went wrong. Please try again.';
  }
}

// Task A — admin starts an inline correction on a SUBMITTED / FOREMAN_APPROVED timesheet, then
// edits days on the existing /admin/corrections/[id] page and hits "Применить изменения" there.
export function StartCorrectionForm({ timesheetId }: { timesheetId: string }) {
  const router = useRouter();
  const ru = useAppLocale() === 'RU';
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStart(): Promise<void> {
    if (reason.trim().length === 0) {
      setError(ru ? 'Укажите причину — её увидит работник.' : 'Enter a reason — the worker will see it.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/timesheets/${timesheetId}/correction`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ reason: reason.trim() })
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

  if (!open) {
    return (
      <div className="setup-card form">
        <button className="wk-inline-secondary" type="button" onClick={() => setOpen(true)}>
          {ru ? 'Исправить часы' : 'Edit hours'}
        </button>
      </div>
    );
  }

  return (
    <div className="setup-card form">
      <p className="setup-subtitle">
        {ru
          ? 'Вы правите часы за работника. После «Применить изменения» табель вернётся в очередь на утверждение, а в истории работника появится «Исправлено администратором» с вашим именем и причиной.'
          : "You are editing the worker's hours. After “Apply changes” the timesheet goes back to the review queue, and the worker's history shows “Edited by administrator” with your name and the reason."}
      </p>
      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="login-field">
        <label htmlFor="inline-correction-reason">{ru ? 'Причина' : 'Reason'}</label>
        <textarea id="inline-correction-reason" rows={3} disabled={loading} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <button className="login-submit" type="button" disabled={loading} onClick={handleStart}>
        {loading ? (ru ? 'Открытие…' : 'Opening…') : (ru ? 'Открыть редактор' : 'Open editor')}
      </button>
      <button className="wk-clock-cancel-button" type="button" disabled={loading} onClick={() => setOpen(false)}>
        {ru ? 'Отмена' : 'Cancel'}
      </button>
    </div>
  );
}
