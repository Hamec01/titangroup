'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

const CSRF_HEADER_VALUE = 'titanor-time';

function describeError(code: string | undefined, fieldErrors: Record<string, string[]> | undefined, ru: boolean): string {
  switch (code) {
    case 'NO_CORRECTION_CHANGES':
      return ru ? 'Черновик идентичен исходному — нечего отправлять. Сначала измените день.' : 'The draft is identical to the original — nothing to submit. Edit a day first.';
    case 'SELF_APPROVAL_FORBIDDEN':
      return ru ? 'Эту корректировку должен решить другой администратор (принцип «четырёх глаз»), если только вы не используете переопределение SUPER_ADMIN ниже.' : 'A different admin must decide this correction (four-eyes), unless you use the SUPER_ADMIN override below.';
    case 'INVALID_STATE_TRANSITION':
      return ru ? 'Эта корректировка больше не в ожидаемом статусе — обновите страницу.' : 'This correction is no longer in the expected status — refresh the page.';
    case 'VALIDATION_ERROR':
      return fieldErrors
        ? Object.entries(fieldErrors)
            .map(([field, messages]) => `${field}: ${messages.join(', ')}`)
            .join('; ')
        : (ru ? 'Некорректные данные.' : 'Invalid input.');
    default:
      return ru ? 'Что-то пошло не так. Попробуйте снова.' : 'Something went wrong. Please try again.';
  }
}

interface CorrectionActionsProps {
  correctionRequestId: string;
  status: string;
  isSuperAdmin: boolean;
}

export function CorrectionActions({ correctionRequestId, status, isSuperAdmin }: CorrectionActionsProps) {
  const router = useRouter();
  const ru = useAppLocale() === 'RU';
  const [loading, setLoading] = useState<'open' | 'submit' | 'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [useOverride, setUseOverride] = useState(false);

  async function post(path: string, body?: unknown): Promise<{ ok: boolean; data: unknown }> {
    const res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, data };
  }

  async function handleOpenDraft(): Promise<void> {
    setLoading('open');
    setError(null);
    const { ok, data } = await post(`/api/admin/corrections/${correctionRequestId}/draft`);
    if (!ok) {
      setError(describeError((data as { error?: { code?: string } })?.error?.code, undefined, ru));
      setLoading(null);
      return;
    }
    router.refresh();
    setLoading(null);
  }

  async function handleSubmit(): Promise<void> {
    setLoading('submit');
    setError(null);
    const { ok, data } = await post(`/api/admin/corrections/${correctionRequestId}/submit`);
    if (!ok) {
      setError(describeError((data as { error?: { code?: string } })?.error?.code, undefined, ru));
      setLoading(null);
      return;
    }
    router.refresh();
    setLoading(null);
  }

  async function handleDecide(decision: 'APPROVED' | 'REJECTED'): Promise<void> {
    setLoading(decision === 'APPROVED' ? 'approve' : 'reject');
    setError(null);
    if (useOverride && overrideReason.trim().length === 0) {
      setError(ru ? 'Для переопределения самостоятельного решения требуется причина.' : 'A reason is required to use the self-decide override.');
      setLoading(null);
      return;
    }
    const { ok, data } = await post(`/api/admin/corrections/${correctionRequestId}/decide`, {
      decision,
      approvalOverride: useOverride,
      overrideReason: useOverride ? overrideReason.trim() : undefined
    });
    if (!ok) {
      const errObj = (data as { error?: { code?: string; fieldErrors?: Record<string, string[]> } })?.error;
      setError(describeError(errObj?.code, errObj?.fieldErrors, ru));
      setLoading(null);
      return;
    }
    router.push('/admin/corrections');
  }

  if (status === 'PENDING') {
    return (
      <div className="setup-card form">
        {error ? (
          <p className="login-error" role="alert">
            {error}
          </p>
        ) : null}
        <button className="login-submit" type="button" disabled={loading !== null} onClick={handleOpenDraft}>
          {loading === 'open' ? (ru ? 'Открытие…' : 'Opening…') : (ru ? 'Открыть черновик' : 'Open draft')}
        </button>
      </div>
    );
  }

  if (status === 'DRAFT_OPEN') {
    return (
      <div className="setup-card form">
        {error ? (
          <p className="login-error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="setup-subtitle">{ru ? 'Измените дни ниже, затем отправьте, когда содержимое действительно будет отличаться от исходного.' : 'Edit days below, then submit once the content actually differs from the original.'}</p>
        <button className="login-submit" type="button" disabled={loading !== null} onClick={handleSubmit}>
          {loading === 'submit' ? (ru ? 'Отправка…' : 'Submitting…') : (ru ? 'Отправить корректировку' : 'Submit correction')}
        </button>
      </div>
    );
  }

  if (status === 'SUBMITTED') {
    return (
      <div className="setup-card form">
        {error ? (
          <p className="login-error" role="alert">
            {error}
          </p>
        ) : null}
        {isSuperAdmin ? (
          <label className="wk-checkbox-row">
            <input type="checkbox" checked={useOverride} onChange={(e) => setUseOverride(e.target.checked)} disabled={loading !== null} />
            {ru ? 'Переопределение самостоятельного решения (только SUPER_ADMIN, требуется причина)' : 'Self-decide override (SUPER_ADMIN only, requires a reason)'}
          </label>
        ) : null}
        {useOverride ? (
          <div className="login-field">
            <label htmlFor="override-reason">{ru ? 'Причина переопределения' : 'Override reason'}</label>
            <textarea id="override-reason" rows={2} disabled={loading !== null} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
          </div>
        ) : null}
        <button className="login-submit" type="button" disabled={loading !== null} onClick={() => handleDecide('APPROVED')}>
          {loading === 'approve' ? (ru ? 'Одобрение…' : 'Approving…') : (ru ? 'Одобрить' : 'Approve')}
        </button>
        <button className="login-submit" type="button" disabled={loading !== null} onClick={() => handleDecide('REJECTED')}>
          {loading === 'reject' ? (ru ? 'Отклонение…' : 'Rejecting…') : (ru ? 'Отклонить' : 'Reject')}
        </button>
      </div>
    );
  }

  return null;
}
