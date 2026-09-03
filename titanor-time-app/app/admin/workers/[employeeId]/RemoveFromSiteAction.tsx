'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';
import type { CardAssignment } from '@/lib/assignment-card';

const CSRF = 'titanor-time';

type ReasonCode = 'PROJECT_DONE' | 'TRANSFER' | 'ASSIGNED_BY_MISTAKE' | 'OTHER';
type WhenChoice = 'today' | 'date';

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §3.1/§3.2 — "Снять с объекта". The worker
// stops being able to clock in on this site immediately (clockInDisabledAt = now). An open shift is
// never interrupted — Check Out stays available and this row shows "shift in progress" until then.
// Deploy B: structured reason presets instead of the old free-text box; a "today / pick a date"
// quick choice instead of a bare date field.
export function RemoveFromSiteAction({
  assignment,
  today,
  defaultValidTo
}: {
  assignment: CardAssignment;
  today: string;
  defaultValidTo: string;
}) {
  const router = useRouter();
  const locale = useAppLocale();
  const t = (en: string, ru: string) => localeText(locale, en, ru);

  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState<WhenChoice>('today');
  const [pickedDate, setPickedDate] = useState(defaultValidTo);
  const [reasonCode, setReasonCode] = useState<ReasonCode>('TRANSFER');
  const [otherText, setOtherText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validTo = when === 'today' ? today : pickedDate;

  function reset() {
    setOpen(false);
    setWhen('today');
    setPickedDate(defaultValidTo);
    setReasonCode('TRANSFER');
    setOtherText('');
    setError(null);
    setLoading(false);
  }

  async function submit() {
    if (loading) return;
    if (reasonCode === 'OTHER' && otherText.trim().length === 0) {
      setError(t('Please describe the reason.', 'Опишите причину.'));
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const r = await fetch(`/api/admin/assignments/${assignment.assignmentId}/remove`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF },
        body: JSON.stringify({
          validTo,
          reasonCode,
          ...(reasonCode === 'OTHER' ? { reasonText: otherText.trim() } : {})
        })
      });
      if (r.ok) {
        router.refresh();
        reset();
        return;
      }
      let code: string | undefined;
      let earliestValidTo: string | undefined;
      try {
        const b = await r.json();
        code = b?.error?.code;
        earliestValidTo = b?.error?.earliestValidTo;
      } catch {
        /* generic */
      }
      setLoading(false);
      if ((code === 'ASSIGNMENT_HAS_RECORDED_TIME' || code === 'ASSIGNMENT_HAS_DEPENDENTS') && earliestValidTo) {
        setWhen('date');
        setPickedDate(earliestValidTo);
        setError(
          t(
            `The worker has recorded hours here through ${earliestValidTo}. The end date has moved there — confirm again, or fix the timesheet first.`,
            `Работник отметил часы по ${earliestValidTo}. Дата окончания перенесена на неё — подтвердите ещё раз или сначала поправьте табель.`
          )
        );
        return;
      }
      setError(
        code === 'VALIDATION_ERROR'
          ? t('Please check the date.', 'Проверьте дату.')
          : code === 'FORBIDDEN'
            ? t('You no longer have permission to remove workers from a site.', 'У вас больше нет права снимать работников с объекта.')
            : t('Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.')
      );
    } catch {
      setLoading(false);
      setError(t('Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
    }
  }

  if (!open) {
    return (
      <button type="button" className="setup-action" onClick={() => setOpen(true)}>
        {t('Remove from site', 'Снять с объекта')}
      </button>
    );
  }

  const reasons: { code: ReasonCode; label: string }[] = [
    { code: 'PROJECT_DONE', label: t('Project finished', 'Проект завершён') },
    { code: 'TRANSFER', label: t('Moving to another site', 'Перевод на другой объект') },
    { code: 'ASSIGNED_BY_MISTAKE', label: t('Assigned here by mistake', 'Назначен сюда по ошибке') },
    { code: 'OTHER', label: t('Other reason', 'Другая причина') }
  ];

  return (
    <div className="assignment-end-form" aria-busy={loading}>
      <p className="setup-subtitle">
        {t('Remove from', 'Снять с')}: <strong>{assignment.workAreaName ? `${assignment.siteName} — ${assignment.workAreaName}` : assignment.siteName}</strong>
      </p>
      {assignment.hasOpenShift ? (
        <p className="setup-subtitle">
          {t(
            'The worker is on an open shift here. It will not be interrupted — they can still Check Out. New Check In on this site stops right away.',
            'У работника здесь идёт смена. Её не прервёт — Check Out останется доступен. Новый Check In на этом объекте прекратится сразу.'
          )}
        </p>
      ) : null}

      <fieldset className="assignment-when">
        <legend>{t('Last day on this site', 'Последний день на этом объекте')}</legend>
        <label>
          <input type="radio" name={`rm-when-${assignment.assignmentId}`} checked={when === 'today'} disabled={loading} onChange={() => setWhen('today')} />{' '}
          {t('Today', 'Сегодня')}
        </label>
        <label>
          <input type="radio" name={`rm-when-${assignment.assignmentId}`} checked={when === 'date'} disabled={loading} onChange={() => setWhen('date')} />{' '}
          {t('Pick a date', 'Выбрать дату')}
        </label>
        {when === 'date' ? (
          <input
            type="date"
            aria-label={t('Last day', 'Последний день')}
            value={pickedDate}
            disabled={loading}
            onChange={(e) => setPickedDate(e.target.value)}
          />
        ) : null}
      </fieldset>

      <label htmlFor={`rm-reason-${assignment.assignmentId}`}>{t('Reason', 'Причина')}</label>
      <select id={`rm-reason-${assignment.assignmentId}`} value={reasonCode} disabled={loading} onChange={(e) => setReasonCode(e.target.value as ReasonCode)}>
        {reasons.map((r) => (
          <option key={r.code} value={r.code}>
            {r.label}
          </option>
        ))}
      </select>
      {reasonCode === 'OTHER' ? (
        <input
          type="text"
          aria-label={t('Describe the reason', 'Опишите причину')}
          placeholder={t('Describe the reason', 'Опишите причину')}
          value={otherText}
          disabled={loading}
          onChange={(e) => setOtherText(e.target.value)}
        />
      ) : null}

      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}

      <button type="button" className="setup-action" disabled={loading} onClick={() => void submit()}>
        {loading ? t('Removing…', 'Снимаем…') : t('Confirm — remove from site', 'Подтвердить — снять с объекта')}
      </button>
      <button type="button" className="setup-action" disabled={loading} onClick={reset}>
        {t('Cancel', 'Отмена')}
      </button>
    </div>
  );
}
