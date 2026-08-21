'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { SiteForemanAssignment } from '@/lib/sites';
import type { AssignableForeman } from '@/lib/foreman-assignments';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText, type AppLocale } from '@/lib/i18n/locale';

const CSRF_HEADER_VALUE = 'titanor-time';

function errorMessageFor(locale: AppLocale, code: string | undefined): string {
  switch (code) {
    case 'VALIDATION_ERROR':
      return localeText(locale, 'Please check the fields above.', 'Проверьте заполненные поля.');
    case 'FOREMAN_NOT_FOUND':
      return localeText(locale, 'That authorized manager account no longer exists.', 'Этой учётной записи уполномоченного больше нет.');
    case 'USER_NOT_FOREMAN':
      return localeText(locale, 'That user does not currently hold an active authorized site manager role.', 'У пользователя сейчас нет активной роли уполномоченного по объектам.');
    case 'FOREMAN_NOT_ELIGIBLE':
      return localeText(locale, "That user's account status does not allow this assignment (offboarded or deactivated).", 'Состояние учётной записи не позволяет назначить пользователя (уволен или деактивирован).');
    case 'FORBIDDEN':
      return localeText(locale, 'You no longer have permission to assign authorized site managers.', 'У вас больше нет права назначать уполномоченных по объектам.');
    default:
      return localeText(locale, 'Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.');
  }
}

// Visible label only — the underlying option value is the User UUID, never shown to the admin.
function labelFor(foreman: AssignableForeman): string {
  if (foreman.employee) {
    return `${foreman.employee.firstName} ${foreman.employee.lastName} (#${foreman.employee.employeeNumber}) — ${foreman.username} — ${foreman.status}`;
  }
  return `${foreman.username} — ${foreman.status}`;
}

// docs/titanor-time/T9_INTERNAL_TEST_PLAN.md §4 (defect D4) — POST
// /api/admin/foreman-assignments/:id/end was already fully implemented but had no UI anywhere
// calling it. Minimal UI for the existing contract, same shape as EndAssignmentAction.tsx.
function EndForemanAssignmentAction({ assignmentId }: { assignmentId: string }) {
  const router = useRouter();
  const locale = useAppLocale();
  const [open, setOpen] = useState(false);
  const [validTo, setValidTo] = useState('');
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
      const response = await fetch(`/api/admin/foreman-assignments/${assignmentId}/end`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ validTo })
      });

      if (!response.ok) {
        let code: string | undefined;
        try {
          const body = (await response.json()) as { error?: { code?: string } };
          code = body.error?.code;
        } catch {
          // Non-JSON error body — fall through to the generic message.
        }
        setErrorMessage(code === 'FORBIDDEN'
          ? localeText(locale, 'You no longer have permission to end these assignments.', 'У вас больше нет права завершать такие назначения.')
          : localeText(locale, 'Please check the end date.', 'Проверьте дату окончания.'));
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
      <label htmlFor={`foreman-end-valid-to-${assignmentId}`}>{localeText(locale, 'End date', 'Дата окончания')}</label>
      <input
        id={`foreman-end-valid-to-${assignmentId}`}
        type="date"
        required
        disabled={loading}
        value={validTo}
        onChange={(event) => setValidTo(event.target.value)}
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

export function ForemanAssignmentSection({
  siteId,
  foremanAssignments,
  assignableForemen
}: {
  siteId: string;
  foremanAssignments: SiteForemanAssignment[];
  assignableForemen: AssignableForeman[];
}) {
  const router = useRouter();
  const locale = useAppLocale();
  const [foremanUserId, setForemanUserId] = useState('');
  const [isSubstitute, setIsSubstitute] = useState(false);
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectedForeman = assignableForemen.find((foreman) => foreman.id === foremanUserId) ?? null;
  const hasCandidates = assignableForemen.length > 0;

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading) {
      return;
    }
    setErrorMessage(null);
    setLoading(true);

    try {
      const response = await fetch('/api/admin/foreman-assignments', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ foremanUserId, siteId, isSubstitute, validFrom, validTo: validTo || undefined })
      });

      if (!response.ok) {
        let code: string | undefined;
        try {
          const body = (await response.json()) as { error?: { code?: string } };
          code = body.error?.code;
        } catch {
          // Non-JSON error body — fall through to the generic message.
        }
        setErrorMessage(errorMessageFor(locale, code));
        setLoading(false);
        return;
      }

      setForemanUserId('');
      setIsSubstitute(false);
      setValidFrom('');
      setValidTo('');
      router.refresh();
      setLoading(false);
    } catch {
      setErrorMessage(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
      setLoading(false);
    }
  }

  return (
    <>
      <h2>{localeText(locale, 'Authorized site managers', 'Уполномоченные по объекту')}</h2>
      {foremanAssignments.length === 0 ? (
        <p>{localeText(locale, 'None currently assigned.', 'Сейчас никто не назначен.')}</p>
      ) : (
        <ul className="setup-list">
          {foremanAssignments.map((assignment) => (
            <li key={assignment.id} className="setup-item">
              <span className="setup-label">
                {assignment.foremanUsername}
                {assignment.isSubstitute ? localeText(locale, ' (substitute)', ' (замещающий)') : ''}
              </span>
              <EndForemanAssignmentAction assignmentId={assignment.id} />
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleCreate} aria-busy={loading}>
        <div className="login-field">
          <label htmlFor="foreman-select">{localeText(locale, 'Authorized site manager', 'Уполномоченный по объекту')}</label>
          {hasCandidates ? (
            <select
              id="foreman-select"
              required
              disabled={loading}
              value={foremanUserId}
              onChange={(event) => setForemanUserId(event.target.value)}
            >
              <option value="" disabled>
                {localeText(locale, 'Select a person…', 'Выберите человека…')}
              </option>
              {assignableForemen.map((foreman) => (
                <option key={foreman.id} value={foreman.id}>
                  {labelFor(foreman)}
                </option>
              ))}
            </select>
          ) : (
            <p>
              {localeText(locale, 'No eligible accounts yet.', 'Подходящих учётных записей пока нет.')} {' '}
              <Link href="/admin/users/new">{localeText(locale, 'Create or activate an authorized manager account first.', 'Сначала создайте или активируйте учётную запись уполномоченного.')}</Link>
            </p>
          )}
        </div>
        {selectedForeman?.status === 'PENDING_ACTIVATION' ? (
          <p className="setup-subtitle">
            {localeText(locale, 'The assignment will be saved now, but this person can sign in only after account activation.', 'Назначение сохранится сейчас, но человек сможет войти только после активации учётной записи.')}
          </p>
        ) : null}
        <div className="login-field">
          <label htmlFor="foreman-valid-from">{localeText(locale, 'Start date', 'Дата начала')}</label>
          <input
            id="foreman-valid-from"
            type="date"
            required
            disabled={loading}
            value={validFrom}
            onChange={(event) => setValidFrom(event.target.value)}
          />
        </div>
        <div className="login-field">
          <label htmlFor="foreman-valid-to">{localeText(locale, 'End date (optional — leave blank for indefinite)', 'Дата окончания (необязательно — оставьте пустой для бессрочного назначения)')}</label>
          <input
            id="foreman-valid-to"
            type="date"
            disabled={loading}
            value={validTo}
            onChange={(event) => setValidTo(event.target.value)}
          />
        </div>
        <div className="login-field">
          <label htmlFor="foreman-is-substitute">
            <input
              id="foreman-is-substitute"
              type="checkbox"
              disabled={loading}
              checked={isSubstitute}
              onChange={(event) => setIsSubstitute(event.target.checked)}
            />{' '}
            {localeText(locale, 'Substitute (not the primary authorized manager)', 'Замещающий (не основной уполномоченный)')}
          </label>
        </div>
        {errorMessage ? (
          <p className="login-error" role="alert">
            {errorMessage}
          </p>
        ) : null}
        <button className="login-submit" type="submit" disabled={loading || !hasCandidates}>
          {loading ? localeText(locale, 'Assigning…', 'Назначение…') : localeText(locale, 'Assign authorized manager', 'Назначить уполномоченного')}
        </button>
      </form>
    </>
  );
}
