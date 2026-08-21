'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';

export function LegacyPeriodEditForm({ period }: { period: { id: string; startDate: string; endDate: string; version: number } }) {
  const router = useRouter();
  const locale = useAppLocale();
  const [startDate, setStartDate] = useState(period.startDate);
  const [endDate, setEndDate] = useState(period.endDate);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pendingRef = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/periods/${period.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'titanor-time', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ startDate, endDate, version: period.version })
      });
      if (response.ok) {
        setMessage(localeText(locale, 'Period dates saved. You can now assign weekly or two-week cycles to workers.', 'Даты периода сохранены. Теперь работникам можно назначить недельный или двухнедельный цикл.'));
        router.refresh();
      } else {
        const body = await response.json().catch(() => null) as { error?: { code?: string } } | null;
        const code = body?.error?.code;
        setMessage(code === 'DATA_OUTSIDE_RANGE'
          ? localeText(locale, 'Cannot shorten this far: recorded or submitted time exists outside the new dates.', 'Нельзя сократить период: за новыми датами уже есть записанные или отправленные часы.')
          : code === 'PERIOD_OVERLAP'
            ? localeText(locale, 'These dates overlap another period for one of the workers.', 'Эти даты пересекаются с другим периодом одного из работников.')
            : code === 'VERSION_CONFLICT'
              ? localeText(locale, 'The period changed elsewhere. Reload and try again.', 'Период был изменён в другом окне. Обновите страницу и повторите.')
              : localeText(locale, 'The period could not be changed.', 'Не удалось изменить период.'));
      }
    } catch {
      setMessage(localeText(locale, 'Network error. Reload before trying again so the result is not repeated accidentally.', 'Ошибка сети. Перед повтором обновите страницу, чтобы случайно не повторить операцию.'));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="worker-cycle-form" aria-busy={pending}>
      <h2>{localeText(locale, 'Correct old manual period', 'Исправить старый ручной период')}</h2>
      <p className="setup-subtitle">{localeText(locale, 'Only an OPEN legacy period with no submitted versions can be changed. Existing recorded time is never deleted.', 'Можно изменить только открытый старый период без отправленных версий. Уже записанное время никогда не удаляется.')}</p>
      <div className="login-field"><label htmlFor="legacy-period-start">{localeText(locale, 'Start date', 'Дата начала')}</label><input id="legacy-period-start" type="date" required value={startDate} disabled={pending} onChange={(e) => setStartDate(e.target.value)} /></div>
      <div className="login-field"><label htmlFor="legacy-period-end">{localeText(locale, 'End date', 'Дата окончания')}</label><input id="legacy-period-end" type="date" required value={endDate} disabled={pending} min={startDate} onChange={(e) => setEndDate(e.target.value)} /></div>
      <button type="submit" className="login-button" disabled={pending}>{pending ? localeText(locale, 'Saving…', 'Сохранение…') : localeText(locale, 'Save period dates', 'Сохранить даты периода')}</button>
      {message ? <p role="status" aria-live="polite" className="form-status">{message}</p> : null}
    </form>
  );
}
