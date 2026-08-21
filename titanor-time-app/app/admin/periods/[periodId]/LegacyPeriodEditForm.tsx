'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export function LegacyPeriodEditForm({ period }: { period: { id: string; startDate: string; endDate: string; version: number } }) {
  const router = useRouter();
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
        setMessage('Period dates saved. You can now assign weekly or two-week cycles to workers.');
        router.refresh();
      } else {
        const body = await response.json().catch(() => null) as { error?: { code?: string } } | null;
        const code = body?.error?.code;
        setMessage(code === 'DATA_OUTSIDE_RANGE'
          ? 'Cannot shorten this far: recorded or submitted time exists outside the new dates.'
          : code === 'PERIOD_OVERLAP'
            ? 'These dates overlap another period for one of the workers.'
            : code === 'VERSION_CONFLICT'
              ? 'The period changed elsewhere. Reload and try again.'
              : 'The period could not be changed.');
      }
    } catch {
      setMessage('Network error. Reload before trying again so the result is not repeated accidentally.');
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="worker-cycle-form" aria-busy={pending}>
      <h2>Correct old manual period</h2>
      <p className="setup-subtitle">Only an OPEN legacy period with no submitted versions can be changed. Existing recorded time is never deleted.</p>
      <div className="login-field"><label htmlFor="legacy-period-start">Start date</label><input id="legacy-period-start" type="date" required value={startDate} disabled={pending} onChange={(e) => setStartDate(e.target.value)} /></div>
      <div className="login-field"><label htmlFor="legacy-period-end">End date</label><input id="legacy-period-end" type="date" required value={endDate} disabled={pending} min={startDate} onChange={(e) => setEndDate(e.target.value)} /></div>
      <button type="submit" className="login-button" disabled={pending}>{pending ? 'Saving…' : 'Save period dates'}</button>
      {message ? <p role="status" aria-live="polite" className="form-status">{message}</p> : null}
    </form>
  );
}
