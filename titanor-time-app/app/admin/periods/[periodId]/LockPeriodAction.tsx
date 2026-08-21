'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';

const CSRF_HEADER_VALUE = 'titanor-time';

interface Blocker {
  employeeId: string;
  employeeName: string;
  timesheetId: string | null;
  status: string | null;
}

export function LockPeriodAction({ periodId, canLock }: { periodId: string; canLock: boolean }) {
  const router = useRouter();
  const locale = useAppLocale();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<Blocker[] | null>(null);

  async function handleLock(): Promise<void> {
    setLoading(true);
    setError(null);
    setBlockers(null);
    try {
      const response = await fetch(`/api/admin/periods/${periodId}/lock`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': CSRF_HEADER_VALUE }
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        if (body?.error?.code === 'NOT_ALL_FINAL_APPROVED' && Array.isArray(body.error.blockers)) {
          setBlockers(body.error.blockers);
        } else {
          setError(localeText(locale, 'Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.'));
        }
        setLoading(false);
        return;
      }
      router.refresh();
    } catch {
      setError(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
      setLoading(false);
    }
  }

  return (
    <div className="setup-card form">
      <p className="setup-subtitle">
        {localeText(locale, 'Locking closes this period for normal work. It becomes available only after every participant is final approved.', 'Блокировка закрывает период для обычной работы. Она доступна только после окончательного утверждения табелей всех участников.')}
      </p>
      <button className="login-submit" type="button" disabled={loading || !canLock} onClick={handleLock}>
        {loading ? localeText(locale, 'Locking…', 'Блокировка…') : localeText(locale, 'Lock period', 'Заблокировать период')}
      </button>

      {!canLock ? <p>{localeText(locale, 'Nothing to press yet — finish reviewing and final approving all worker timesheets first.', 'Пока блокировать нельзя — сначала проверьте и окончательно утвердите табели всех работников.')}</p> : null}

      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}

      {blockers && blockers.length > 0 ? (
        <div>
          <p className="login-error" role="alert">
            {localeText(locale, 'Not every participant has reached final approval yet:', 'Ещё не все участники получили окончательное утверждение:')}
          </p>
          <ul className="setup-list">
            {blockers.map((b) => (
              <li key={b.employeeId} className="setup-item">
                <span className="setup-label">{b.employeeName}</span>
                <span className="setup-status setup-status-pending">{b.status ?? localeText(locale, 'no timesheet', 'нет табеля')}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
