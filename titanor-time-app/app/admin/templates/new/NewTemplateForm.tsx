'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §0 — required on every mutating request.
const CSRF_HEADER_VALUE = 'titanor-time';

// docs/titanor-time/03_DATA_MODEL_ERD.md §4.5 — weekday 0=Mon..6=Sun.
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface DayState {
  weekday: number;
  isWorkingDay: boolean;
  plannedStartTime: string;
  plannedEndTime: string;
  plannedBreakMinutes: number;
}

function defaultDays(): DayState[] {
  return WEEKDAY_LABELS.map((_, weekday) => ({
    weekday,
    isWorkingDay: weekday < 5,
    plannedStartTime: '09:00',
    plannedEndTime: '17:00',
    plannedBreakMinutes: weekday < 5 ? 30 : 0
  }));
}

export function NewTemplateForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [days, setDays] = useState<DayState[]>(defaultDays);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Same reuse-only-after-a-network-failure pattern as /admin/sites/new's form —
  // see the comment there for why.
  const idempotencyKeyRef = useRef<string | null>(null);

  function updateDay(weekday: number, patch: Partial<DayState>): void {
    setDays((current) => current.map((day) => (day.weekday === weekday ? { ...day, ...patch } : day)));
  }

  function toggleWorkingDay(weekday: number, isWorkingDay: boolean): void {
    updateDay(
      weekday,
      isWorkingDay
        ? { isWorkingDay: true, plannedStartTime: '09:00', plannedEndTime: '17:00', plannedBreakMinutes: 30 }
        : { isWorkingDay: false, plannedStartTime: '', plannedEndTime: '', plannedBreakMinutes: 0 }
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading) {
      return;
    }
    setErrorMessage(null);
    setLoading(true);

    if (idempotencyKeyRef.current === null) {
      idempotencyKeyRef.current = crypto.randomUUID();
    }

    try {
      const response = await fetch('/api/admin/templates', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': CSRF_HEADER_VALUE,
          'Idempotency-Key': idempotencyKeyRef.current
        },
        body: JSON.stringify({
          name,
          description: description || undefined,
          days: days.map((day) => ({
            weekday: day.weekday,
            isWorkingDay: day.isWorkingDay,
            plannedStartTime: day.isWorkingDay ? day.plannedStartTime : undefined,
            plannedEndTime: day.isWorkingDay ? day.plannedEndTime : undefined,
            plannedBreakMinutes: day.plannedBreakMinutes
          }))
        })
      });

      if (!response.ok) {
        idempotencyKeyRef.current = null;

        let code: string | undefined;
        let fieldErrors: Record<string, string[]> | undefined;
        try {
          const body = (await response.json()) as { error?: { code?: string; fieldErrors?: Record<string, string[]> } };
          code = body.error?.code;
          fieldErrors = body.error?.fieldErrors;
        } catch {
          // Non-JSON error body — fall through to the generic message.
        }

        switch (code) {
          case 'VALIDATION_ERROR':
            setErrorMessage(fieldErrors?.days?.[0] ?? fieldErrors?.name?.[0] ?? 'Invalid form data.');
            break;
          case 'NOT_AUTHENTICATED':
            setErrorMessage('Your session expired — please sign in again.');
            break;
          case 'FORBIDDEN':
            setErrorMessage('You no longer have permission to create templates.');
            break;
          default:
            setErrorMessage('Something went wrong. Please try again.');
        }
        setLoading(false);
        return;
      }

      router.push('/admin/setup');
    } catch {
      setErrorMessage('Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} aria-busy={loading}>
      <div className="login-field">
        <label htmlFor="template-name">Name</label>
        <input
          id="template-name"
          type="text"
          required
          disabled={loading}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className="login-field">
        <label htmlFor="template-description">Description (optional)</label>
        <textarea
          id="template-description"
          rows={2}
          disabled={loading}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <div className="template-days">
        {days.map((day) => (
          <div key={day.weekday} className="template-day-row">
            <span className="template-day-label">{WEEKDAY_LABELS[day.weekday]}</span>
            <label className="template-day-toggle">
              <input
                type="checkbox"
                disabled={loading}
                checked={day.isWorkingDay}
                onChange={(event) => toggleWorkingDay(day.weekday, event.target.checked)}
              />
              Working day
            </label>
            {day.isWorkingDay ? (
              <>
                <input
                  type="time"
                  aria-label={`${WEEKDAY_LABELS[day.weekday]} start time`}
                  required
                  disabled={loading}
                  value={day.plannedStartTime}
                  onChange={(event) => updateDay(day.weekday, { plannedStartTime: event.target.value })}
                />
                <span>–</span>
                <input
                  type="time"
                  aria-label={`${WEEKDAY_LABELS[day.weekday]} end time`}
                  required
                  disabled={loading}
                  value={day.plannedEndTime}
                  onChange={(event) => updateDay(day.weekday, { plannedEndTime: event.target.value })}
                />
                <input
                  type="number"
                  min={0}
                  aria-label={`${WEEKDAY_LABELS[day.weekday]} break minutes`}
                  disabled={loading}
                  value={day.plannedBreakMinutes}
                  onChange={(event) => updateDay(day.weekday, { plannedBreakMinutes: Number(event.target.value) })}
                />
                <span className="template-day-unit">min break</span>
              </>
            ) : (
              <span className="template-day-off">Day off</span>
            )}
          </div>
        ))}
      </div>

      {errorMessage ? (
        <p className="login-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <button className="login-submit" type="submit" disabled={loading}>
        {loading ? 'Creating…' : 'Create template'}
      </button>
    </form>
  );
}
