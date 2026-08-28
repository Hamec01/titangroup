'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

const CSRF_HEADER_VALUE = 'titanor-time';

function describeError(code: string | undefined, fieldErrors: Record<string, string[]> | undefined, ru: boolean): string {
  switch (code) {
    case 'NO_CORRECTION_CHANGES':
      return ru ? 'Черновик идентичен исходному — нечего применять. Сначала измените день.' : 'The draft is identical to the original — nothing to apply. Edit a day first.';
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
  /** Task A — SUBMITTED/FOREMAN_APPROVED => this is an in-review admin edit (apply / discard),
   * not the FINAL_APPROVED four-eyes decision flow. */
  timesheetStatus: string;
  /** T12 §1b — no-reason direct edit: same apply/discard flow, softer wording ("Сохранить"). */
  directEdit?: boolean;
}

export function CorrectionActions({ correctionRequestId, status, isSuperAdmin, timesheetStatus, directEdit = false }: CorrectionActionsProps) {
  const router = useRouter();
  const ru = useAppLocale() === 'RU';
  const [loading, setLoading] = useState<'open' | 'submit' | 'approve' | 'reject' | 'apply' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [useOverride, setUseOverride] = useState(false);

  const inReview = timesheetStatus === 'SUBMITTED' || timesheetStatus === 'FOREMAN_APPROVED';

  async function handleApplyInReview(): Promise<void> {
    setLoading('apply');
    setError(null);
    const { ok, data } = await post(`/api/admin/corrections/${correctionRequestId}/apply-in-review`);
    if (!ok) {
      setError(describeError((data as { error?: { code?: string } })?.error?.code, undefined, ru));
      setLoading(null);
      return;
    }
    router.push('/admin/review-scopes');
  }

  async function handleDiscard(): Promise<void> {
    setLoading('discard');
    setError(null);
    const { ok, data } = await post(`/api/admin/corrections/${correctionRequestId}/discard`);
    if (!ok) {
      setError(describeError((data as { error?: { code?: string } })?.error?.code, undefined, ru));
      setLoading(null);
      return;
    }
    router.push('/admin/timesheets?status=SUBMITTED');
  }

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

  // Task A — an in-review admin edit: apply (-> new CORRECTION version, timesheet back to
  // SUBMITTED, every scope PENDING) or discard. No four-eyes / override / reject — the review
  // pass that follows is the second pair of eyes.
  if (inReview) {
    if (status === 'APPROVED') {
      return (
        <div className="setup-card form">
          <p className="setup-subtitle">
            {directEdit
              ? ru
                ? 'Часы сохранены. Табель вернулся в очередь на утверждение.'
                : 'Hours saved. The timesheet is back in the review queue.'
              : ru
                ? 'Изменения применены. Табель вернулся в очередь на утверждение.'
                : 'Changes applied. The timesheet is back in the review queue.'}
          </p>
          <button className="login-submit" type="button" onClick={() => router.push('/admin/review-scopes')}>
            {ru ? 'К очереди проверки' : 'To the review queue'}
          </button>
        </div>
      );
    }
    if (status === 'REJECTED') {
      return (
        <p className="setup-subtitle">
          {directEdit
            ? ru
              ? 'Правка отменена — табель не менялся.'
              : 'Edit discarded — the timesheet was not changed.'
            : ru
              ? 'Исправление отменено — табель не менялся.'
              : 'Correction discarded — the timesheet was not changed.'}
        </p>
      );
    }
    return (
      <div className="setup-card form">
        {error ? (
          <p className="login-error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="setup-subtitle">
          {directEdit
            ? ru
              ? 'Измените дни ниже. «Сохранить часы» создаст новую версию за вашей подписью (работник не уведомляется), и табель вернётся в очередь на утверждение.'
              : 'Edit the days below. “Save hours” freezes a new version under your name (the worker is not notified) and sends the timesheet back to the review queue.'
            : ru
              ? 'Измените дни ниже. «Применить изменения» создаст новую версию за вашей подписью, и табель вернётся в очередь на утверждение.'
              : 'Edit the days below. “Apply changes” freezes a new version under your name and sends the timesheet back to the review queue.'}
        </p>
        <button className="login-submit" type="button" disabled={loading !== null} onClick={handleApplyInReview}>
          {loading === 'apply'
            ? ru
              ? 'Сохранение…'
              : 'Saving…'
            : directEdit
              ? ru
                ? 'Сохранить часы'
                : 'Save hours'
              : ru
                ? 'Применить изменения'
                : 'Apply changes'}
        </button>
        <button className="wk-clock-cancel-button" type="button" disabled={loading !== null} onClick={handleDiscard}>
          {loading === 'discard'
            ? ru
              ? 'Отмена…'
              : 'Discarding…'
            : directEdit
              ? ru
                ? 'Отменить правку'
                : 'Discard edit'
              : ru
                ? 'Отменить исправление'
                : 'Discard correction'}
        </button>
      </div>
    );
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
