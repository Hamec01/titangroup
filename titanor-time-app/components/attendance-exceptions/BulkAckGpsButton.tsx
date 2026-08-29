'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';

const CSRF_HEADER_VALUE = 'titanor-time';

// T14.5c — "accept every still-OPEN GPS_NOT_VERIFIED matching the current filter". Rendered by
// ExceptionsListView only for an admin holding attendance.exception.resolve.all, and only when the
// filter is narrowed to a site / employee / payroll period.
export function BulkAckGpsButton({ filter }: { filter: { siteId: string | null; employeeId: string | null; payrollPeriodId: string | null; from: string | null; to: string | null } }) {
  const locale = useAppLocale();
  const ru = locale === 'RU';
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function run(): Promise<void> {
    if (busy) return;
    const confirmText = ru
      ? 'Принять как верные все ещё открытые отметки «GPS не подтверждён» по текущему фильтру? Это действие записывается в журнал.'
      : 'Accept every still-open "GPS not verified" exception matching the current filter as valid? This is written to the audit log.';
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/attendance/exceptions/bulk-acknowledge-gps', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify(filter)
      });
      const body = (await res.json().catch(() => null)) as { acknowledgedCount?: number; error?: { code?: string; message?: string } } | null;
      if (res.ok) {
        const n = body?.acknowledgedCount ?? 0;
        setMessage({
          kind: 'ok',
          text: n === 0 ? (ru ? 'Подходящих открытых отметок не найдено.' : 'No matching open exceptions found.') : ru ? `Принято отметок: ${n}.` : `Acknowledged ${n} exception${n === 1 ? '' : 's'}.`
        });
        if (n > 0) router.refresh();
      } else if (body?.error?.code === 'BULK_LIMIT_EXCEEDED') {
        setMessage({ kind: 'error', text: body.error.message ?? (ru ? 'Слишком много отметок — сузьте фильтр.' : 'Too many exceptions — narrow the filter.') });
      } else {
        setMessage({ kind: 'error', text: ru ? 'Не удалось выполнить действие.' : 'Could not complete the action.' });
      }
    } catch {
      setMessage({ kind: 'error', text: ru ? 'Ошибка сети.' : 'Network error.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="exc-bulk-ack">
      <button type="button" className="exc-apply-button" onClick={() => void run()} disabled={busy}>
        {busy
          ? ru
            ? 'Обработка…'
            : 'Working…'
          : ru
            ? 'Принять все «GPS не подтверждён» по фильтру'
            : 'Acknowledge all "GPS not verified" in this filter'}
      </button>
      {message && (
        <p className={message.kind === 'error' ? 'login-error' : 'setup-subtitle'} role={message.kind === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
    </div>
  );
}
