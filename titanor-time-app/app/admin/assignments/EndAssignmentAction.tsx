'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';

const CSRF_HEADER_VALUE = 'titanor-time';

// docs/titanor-time/T9_INTERNAL_TEST_PLAN.md §4 (defect D3) — POST
// /api/admin/assignments/:assignmentId/end was already fully implemented (validation, audit,
// reason-required-if-early) but had no UI anywhere calling it. This is the minimal UI for the
// existing contract — no new backend behavior. Used from /admin/assignments and from the worker
// card's "Текущие назначения" list (only `id` is needed — hence the minimal prop shape).
export function EndAssignmentAction({
  assignment,
  defaultValidTo = ''
}: {
  assignment: { id: string };
  defaultValidTo?: string;
}) {
  const router = useRouter();
  const locale = useAppLocale();
  const [open, setOpen] = useState(false);
  const [validTo, setValidTo] = useState(defaultValidTo);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading) {
      return;
    }
    setErrorMessage(null);
    setLoading(true);

    try {
      const response = await fetch(`/api/admin/assignments/${assignment.id}/end`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ validTo, reason: reason || undefined })
      });

      if (!response.ok) {
        let code: string | undefined;
        let fieldErrors: Record<string, string[]> | undefined;
        let earliestValidTo: string | undefined;
        try {
          const body = (await response.json()) as {
            error?: { code?: string; fieldErrors?: Record<string, string[]>; earliestValidTo?: string };
          };
          code = body.error?.code;
          fieldErrors = body.error?.fieldErrors;
          earliestValidTo = body.error?.earliestValidTo;
        } catch {
          // Non-JSON error body — fall through to the generic message.
        }
        if (code === 'ASSIGNMENT_HAS_RECORDED_TIME' || code === 'ASSIGNMENT_HAS_DEPENDENTS') {
          // The worker has real recorded/submitted hours after the chosen date. Move the form to
          // the earliest date that will work so a second click just succeeds.
          if (earliestValidTo) {
            setValidTo(earliestValidTo);
            setErrorMessage(
              localeText(
                locale,
                `The worker has recorded hours here through ${earliestValidTo}. The end date has been moved there — confirm again, or fix the timesheet first.`,
                `Работник отметил часы по ${earliestValidTo}. Дата окончания перенесена на неё — подтвердите ещё раз, или сначала поправьте табель.`
              )
            );
          } else {
            setErrorMessage(
              localeText(
                locale,
                'The worker has recorded hours here after that date. Choose a later end date, or fix the timesheet first.',
                'Работник отметил часы после этой даты. Выберите более позднюю дату окончания или сначала поправьте табель.'
              )
            );
          }
        } else if (code === 'VALIDATION_ERROR' && fieldErrors?.reason) {
          setErrorMessage(localeText(locale, 'A reason is required when ending earlier than planned.', 'При досрочном завершении необходимо указать причину.'));
        } else if (code === 'VALIDATION_ERROR') {
          setErrorMessage(localeText(locale, 'Please check the end date.', 'Проверьте дату окончания.'));
        } else if (code === 'FORBIDDEN') {
          setErrorMessage(localeText(locale, 'You no longer have permission to end assignments.', 'У вас больше нет права завершать назначения.'));
        } else {
          setErrorMessage(localeText(locale, 'Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.'));
        }
        setLoading(false);
        return;
      }

      router.refresh();
      setLoading(false);
      setOpen(false);
    } catch {
      setErrorMessage(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="setup-action" onClick={() => setOpen(true)}>
        {localeText(locale, 'End', 'Завершить')}
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} aria-busy={loading} className="assignment-end-form">
      <label htmlFor={`end-valid-to-${assignment.id}`}>{localeText(locale, 'End date', 'Дата окончания')}</label>
      <input
        id={`end-valid-to-${assignment.id}`}
        type="date"
        required
        disabled={loading}
        value={validTo}
        onChange={(event) => setValidTo(event.target.value)}
      />
      <label htmlFor={`end-reason-${assignment.id}`}>{localeText(locale, 'Reason (required if ending earlier than planned)', 'Причина (обязательна при досрочном завершении)')}</label>
      <input
        id={`end-reason-${assignment.id}`}
        type="text"
        disabled={loading}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      {errorMessage ? (
        <p className="login-error" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <button type="submit" className="setup-action" disabled={loading}>
        {loading ? localeText(locale, 'Ending…', 'Завершение…') : localeText(locale, 'Confirm end', 'Подтвердить завершение')}
      </button>
      <button type="button" className="setup-action" disabled={loading} onClick={() => setOpen(false)}>
        {localeText(locale, 'Cancel', 'Отмена')}
      </button>
    </form>
  );
}
