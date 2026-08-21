'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §0 — required on every mutating request.
const CSRF_HEADER_VALUE = 'titanor-time';

export function NewPeriodForm() {
  const router = useRouter();
  const locale = useAppLocale();
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Same reasoning as NewSiteForm.tsx: reused across a retry of an identical submission so a lost
  // response doesn't open a second period; cleared once a real response comes back.
  const idempotencyKeyRef = useRef<string | null>(null);

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
      const response = await fetch('/api/admin/periods', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE, 'Idempotency-Key': idempotencyKeyRef.current },
        body: JSON.stringify({ startDate, endDate })
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
            setErrorMessage(fieldErrors ? `${localeText(locale, 'Please check', 'Проверьте поля')}: ${Object.keys(fieldErrors).join(', ')}.` : localeText(locale, 'Invalid form data.', 'Форма заполнена неверно.'));
            break;
          case 'PERIOD_OVERLAP':
            setErrorMessage(localeText(locale, 'This date range overlaps an existing period.', 'Этот диапазон дат пересекается с существующим периодом.'));
            break;
          case 'FORBIDDEN':
            setErrorMessage(localeText(locale, 'You no longer have permission to open periods.', 'У вас больше нет права открывать периоды.'));
            break;
          default:
            setErrorMessage(localeText(locale, 'Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.'));
        }
        setLoading(false);
        return;
      }

      const created = (await response.json()) as { id: string };
      router.push(`/admin/periods/${created.id}`);
    } catch {
      setErrorMessage(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} aria-busy={loading}>
      <div className="login-field">
        <label htmlFor="period-start">{localeText(locale, 'Start date', 'Дата начала')}</label>
        <input id="period-start" name="startDate" type="date" required disabled={loading} value={startDate} onChange={(event) => setStartDate(event.target.value)} />
      </div>

      <div className="login-field">
        <label htmlFor="period-end">{localeText(locale, 'End date', 'Дата окончания')}</label>
        <input id="period-end" name="endDate" type="date" required disabled={loading} value={endDate} onChange={(event) => setEndDate(event.target.value)} />
      </div>

      {errorMessage ? (
        <p className="login-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <button className="login-submit" type="submit" disabled={loading}>
        {loading ? localeText(locale, 'Opening…', 'Открытие…') : localeText(locale, 'Open period', 'Открыть период')}
      </button>
    </form>
  );
}
