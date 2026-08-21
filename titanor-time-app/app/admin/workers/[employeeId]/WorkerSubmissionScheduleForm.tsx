'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { WorkerSubmissionScheduleView } from '@/lib/timesheet-submission-schedules';

interface FrozenAttempt {
  key: string;
  body: { scheduleId: string; effectiveFrom: string };
}

export function WorkerSubmissionScheduleForm({ employeeId, view }: { employeeId: string; view: WorkerSubmissionScheduleView }) {
  const router = useRouter();
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
        setMessage('Submission cycle saved. The current and next periods are ready.');
        router.refresh();
      } else {
        const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
        const code = body?.error?.code;
        attemptRef.current = null;
        if (code === 'PERIOD_OVERLAP') {
          setMessage('This worker is still inside an old overlapping payroll period. Shorten that open legacy period first, then save this cycle again.');
        } else if (code === 'EXISTING_PERIOD_HAS_DATA') {
          setMessage('The selected change would replace a generated period that already contains recorded or submitted data. Start from a later cycle.');
        } else if (code === 'EFFECTIVE_FROM_NOT_BOUNDARY') {
          setMessage('Choose the first day shown for one of the cycles below.');
        } else if (code === 'EFFECTIVE_FROM_BEFORE_CURRENT') {
          setMessage('A later cycle change is already scheduled. Reload and change that same future boundary instead.');
        } else if (code === 'FORBIDDEN') {
          setMessage('You no longer have permission to change submission cycles.');
        } else {
          setMessage('The cycle could not be saved. Please reload and try again.');
        }
      }
    } catch {
      setMessage('The result is unknown because the network connection failed. Retry sends exactly the same request.');
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
        <label htmlFor="worker-cycle">Timesheet submission cycle</label>
        <select id="worker-cycle" value={scheduleId} disabled={pending} onChange={(event) => {
          const nextId = event.target.value;
          setScheduleId(nextId);
          const nextOption = view.options.find((option) => option.id === nextId);
          if (nextOption?.periods[0]) setEffectiveFrom(nextOption.periods[0].startDate);
        }}>
          {view.options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}{option.isCompanyDefault ? ' — company default' : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="login-field">
        <label htmlFor="worker-cycle-start">Start from cycle beginning</label>
        <select id="worker-cycle-start" value={effectiveFrom} disabled={pending} onChange={(event) => setEffectiveFrom(event.target.value)}>
          {selectedOption.periods.map((period) => (
            <option key={period.startDate} value={period.startDate}>{period.startDate} – {period.endDate}</option>
          ))}
        </select>
      </div>
      <p className="setup-subtitle">
        {view.inheritedCompanyDefault ? 'Currently using the company default.' : 'A worker-specific cycle is active.'} Saving automatically prepares this worker&apos;s current and next timesheets.
      </p>
      <button type="submit" className="login-button" disabled={pending}>{pending ? 'Saving…' : 'Save submission cycle'}</button>
      {retryable && attemptRef.current ? (
        <button type="button" className="secondary-button" disabled={pending} onClick={() => void send(attemptRef.current!)}>Retry same request</button>
      ) : null}
      {message ? <p className="form-status" role="status" aria-live="polite">{message}</p> : null}
    </form>
  );
}
