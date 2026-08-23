'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

const CSRF_HEADER_VALUE = 'titanor-time';

function describeError(code: string | undefined, ru: boolean): string {
  switch (code) {
    case 'INVALID_STATE_TRANSITION':
      return ru ? 'Этот табель больше не в статусе «Одобрен прорабом».' : 'This timesheet is no longer in FOREMAN_APPROVED status.';
    case 'TIMESHEET_NOT_FOUND':
      return ru ? 'Этот табель больше не существует.' : 'This timesheet no longer exists.';
    default:
      return ru ? 'Что-то пошло не так. Попробуйте снова.' : 'Something went wrong. Please try again.';
  }
}

export function FinalApprovalActions({ timesheetId }: { timesheetId: string }) {
  const router = useRouter();
  const ru = useAppLocale() === 'RU';
  const [returnReason, setReturnReason] = useState('');
  const [loading, setLoading] = useState<'approve' | 'return' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFinalApprove(): Promise<void> {
    setLoading('approve');
    setError(null);
    try {
      const response = await fetch(`/api/admin/timesheets/${timesheetId}/final-approve`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE }
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(describeError(body?.error?.code, ru));
        setLoading(null);
        return;
      }
      router.push('/admin/timesheets');
    } catch {
      setError(ru ? 'Ошибка сети. Попробуйте снова.' : 'Network error. Please try again.');
      setLoading(null);
    }
  }

  async function handleReturn(): Promise<void> {
    if (returnReason.trim().length === 0) {
      setError(ru ? 'Для возврата табеля требуется указать причину.' : 'A reason is required to return a timesheet.');
      return;
    }
    setLoading('return');
    setError(null);
    try {
      const response = await fetch(`/api/admin/timesheets/${timesheetId}/return`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ returnReason: returnReason.trim() })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(describeError(body?.error?.code, ru));
        setLoading(null);
        return;
      }
      router.push('/admin/timesheets');
    } catch {
      setError(ru ? 'Ошибка сети. Попробуйте снова.' : 'Network error. Please try again.');
      setLoading(null);
    }
  }

  return (
    <div className="setup-card form">
      <p className="setup-subtitle">{ru ? 'На этом экране нельзя редактировать часы — окончательное одобрение никогда не меняет данные. Не согласны? Верните весь табель целиком.' : 'No hours can be edited from this screen — final approval never changes data. Disagree? Return the whole timesheet instead.'}</p>

      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}

      <button className="login-submit" type="button" disabled={loading !== null} onClick={handleFinalApprove}>
        {loading === 'approve' ? (ru ? 'Одобрение…' : 'Approving…') : (ru ? 'Окончательно одобрить' : 'Final approve')}
      </button>

      <div className="login-field">
        <label htmlFor="override-return-reason">{ru ? 'Причина возврата (весь табель)' : 'Return reason (whole timesheet)'}</label>
        <textarea id="override-return-reason" rows={3} disabled={loading !== null} value={returnReason} onChange={(event) => setReturnReason(event.target.value)} />
      </div>
      <button className="login-submit" type="button" disabled={loading !== null} onClick={handleReturn}>
        {loading === 'return' ? (ru ? 'Возврат…' : 'Returning…') : (ru ? 'Вернуть весь табель' : 'Return whole timesheet')}
      </button>
    </div>
  );
}
