'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

const CSRF = 'titanor-time';

function describeError(code: string | undefined, message: string | undefined, ru: boolean): string {
  switch (code) {
    case 'FOREMAN_REVIEW_PENDING':
      return message ?? (ru ? 'Ожидает проверки прораба.' : 'Awaiting foreman review.');
    case 'SELF_APPROVAL_FORBIDDEN':
      return ru ? 'Нельзя утвердить свой собственный табель.' : 'You cannot approve your own timesheet.';
    case 'INVALID_STATE_TRANSITION':
      return ru ? 'Табель больше не ожидает утверждения — обновите страницу.' : 'This timesheet is no longer awaiting approval — refresh.';
    default:
      return ru ? 'Что-то пошло не так. Попробуйте снова.' : 'Something went wrong. Please try again.';
  }
}

interface Props {
  timesheetId: string;
  /** 'inline' — compact button for a list row; 'card' — full-width primary on the timesheet card. */
  variant?: 'inline' | 'card';
  /** Where to go after a successful approve. Default: refresh in place. */
  onDoneHref?: string;
  label?: string;
}

export function ApproveTimesheetButton({ timesheetId, variant = 'card', onDoneHref, label }: Props) {
  const router = useRouter();
  const ru = useAppLocale() === 'RU';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleApprove(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/timesheets/${timesheetId}/approve`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF }
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(describeError(body?.error?.code, body?.error?.message, ru));
        setLoading(false);
        return;
      }
      if (onDoneHref) router.push(onDoneHref);
      else router.refresh();
    } catch {
      setError(ru ? 'Ошибка сети. Попробуйте снова.' : 'Network error. Please try again.');
      setLoading(false);
    }
  }

  const text = loading ? (ru ? 'Утверждение…' : 'Approving…') : (label ?? (ru ? 'Утвердить' : 'Approve'));

  if (variant === 'inline') {
    return (
      <span>
        <button type="button" className="wk-inline-secondary" disabled={loading} onClick={handleApprove}>
          {text}
        </button>
        {error ? (
          <span className="field-error" role="alert" style={{ display: 'block' }}>
            {error}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <div className="setup-card form">
      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="button" className="login-submit" disabled={loading} onClick={handleApprove}>
        {loading ? (ru ? 'Утверждение…' : 'Approving…') : (label ?? (ru ? 'Утвердить часы' : 'Approve hours'))}
      </button>
    </div>
  );
}
