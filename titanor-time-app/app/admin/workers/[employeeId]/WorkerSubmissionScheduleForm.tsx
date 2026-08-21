'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { WorkerSubmissionScheduleView } from '@/lib/timesheet-submission-schedules';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';

interface FrozenAttempt {
  key: string;
  body: { scheduleId: string; effectiveFrom: string };
}

export function WorkerSubmissionScheduleForm({ employeeId, view }: { employeeId: string; view: WorkerSubmissionScheduleView }) {
  const router = useRouter();
  const locale = useAppLocale();
  const [scheduleId, setScheduleId] = useState(view.selectedScheduleId);
  const [effectiveFrom, setEffectiveFrom] = useState(view.periods[0]?.startDate ?? view.effectiveFrom);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  const pendingRef = useRef(false);
  const attemptRef = useRef<FrozenAttempt | null>(null);
  const selectedOption = view.options.find((option) => option.id === scheduleId) ?? view.options[0];

  async function send(attempt: FrozenAttempt): Promise<void> {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setMessage(null);
    setRetryable(false);
    try {
      const response = await fetch(`/api/admin/workers/${employeeId}/timesheet-schedule`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'titanor-time',
          'Idempotency-Key': attempt.key
        },
        body: JSON.stringify(attempt.body)
      });
      if (response.ok) {
        attemptRef.current = null;
        setMessage(localeText(locale, 'Submission cycle saved. The current and next periods are ready.', 'Цикл отправки сохранён. Текущий и следующий периоды готовы.'));
        router.refresh();
      } else {
        const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
        const code = body?.error?.code;
        attemptRef.current = null;
        if (code === 'PERIOD_OVERLAP') {
          setMessage(localeText(locale, 'This worker is still inside an old overlapping payroll period. Shorten that open legacy period first, then save this cycle again.', 'Работник всё ещё входит в старый пересекающийся период. Сначала сократите открытый старый период, затем снова сохраните цикл.'));
        } else if (code === 'EXISTING_PERIOD_HAS_DATA') {
          setMessage(localeText(locale, 'The selected change would replace a generated period that already contains recorded or submitted data. Start from a later cycle.', 'Изменение заменило бы период, где уже есть записанные или отправленные данные. Выберите более поздний цикл.'));
        } else if (code === 'EFFECTIVE_FROM_NOT_BOUNDARY') {
          setMessage(localeText(locale, 'Choose the first day shown for one of the cycles below.', 'Выберите первый день одного из показанных ниже циклов.'));
        } else if (code === 'EFFECTIVE_FROM_BEFORE_CURRENT') {
          setMessage(localeText(locale, 'A later cycle change is already scheduled. Reload and change that same future boundary instead.', 'Более позднее изменение цикла уже запланировано. Обновите страницу и измените ту же будущую границу.'));
        } else if (code === 'FORBIDDEN') {
          setMessage(localeText(locale, 'You no longer have permission to change submission cycles.', 'У вас больше нет права менять циклы отправки.'));
        } else {
          setMessage(localeText(locale, 'The cycle could not be saved. Please reload and try again.', 'Не удалось сохранить цикл. Обновите страницу и повторите.'));
        }
      }
    } catch {
      setMessage(localeText(locale, 'The result is unknown because the network connection failed. Retry sends exactly the same request.', 'Результат неизвестен из-за сбоя сети. Повтор отправит точно тот же запрос.'));
      setRetryable(true);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const attempt = { key: crypto.randomUUID(), body: { scheduleId, effectiveFrom } };
    attemptRef.current = attempt;
    void send(attempt);
  }

  return (
    <form onSubmit={submit} aria-busy={pending} className="worker-cycle-form">
      <div className="login-field">
        <label htmlFor="worker-cycle">{localeText(locale, 'Timesheet submission cycle', 'Цикл отправки табеля')}</label>
        <select id="worker-cycle" value={scheduleId} disabled={pending} onChange={(event) => {
          const nextId = event.target.value;
          setScheduleId(nextId);
          const nextOption = view.options.find((option) => option.id === nextId);
          if (nextOption?.periods[0]) setEffectiveFrom(nextOption.periods[0].startDate);
        }}>
          {view.options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}{option.isCompanyDefault ? localeText(locale, ' — company default', ' — по умолчанию для компании') : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="login-field">
        <label htmlFor="worker-cycle-start">{localeText(locale, 'Start from cycle beginning', 'Начать с начала цикла')}</label>
        <select id="worker-cycle-start" value={effectiveFrom} disabled={pending} onChange={(event) => setEffectiveFrom(event.target.value)}>
          {selectedOption.periods.map((period) => (
            <option key={period.startDate} value={period.startDate}>{period.startDate} – {period.endDate}</option>
          ))}
        </select>
      </div>
      <p className="setup-subtitle">
        {view.inheritedCompanyDefault ? localeText(locale, 'Currently using the company default.', 'Сейчас используется цикл компании по умолчанию.') : localeText(locale, 'A worker-specific cycle is active.', 'Для работника действует индивидуальный цикл.')} {localeText(locale, "Saving automatically prepares this worker's current and next timesheets.", 'После сохранения текущий и следующий табели работника будут подготовлены автоматически.')}
      </p>
      <button type="submit" className="login-button" disabled={pending}>{pending ? localeText(locale, 'Saving…', 'Сохранение…') : localeText(locale, 'Save submission cycle', 'Сохранить цикл')}</button>
      {retryable && attemptRef.current ? (
        <button type="button" className="secondary-button" disabled={pending} onClick={() => void send(attemptRef.current!)}>{localeText(locale, 'Retry same request', 'Повторить тот же запрос')}</button>
      ) : null}
      {message ? <p className="form-status" role="status" aria-live="polite">{message}</p> : null}
    </form>
  );
}
