'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';
import type { CardAssignment } from '@/lib/assignment-card';

const CSRF = 'titanor-time';

interface Opt {
  id: string;
  name: string;
}
interface TemplateOpt extends Opt {
  active: boolean;
  currentVersionNumber: number | null;
}

interface Preview {
  from: PlacePreview;
  to: PlacePreview;
  effectiveFrom: string;
  isImmediate: boolean;
  isBackdated: boolean;
  startsToday: boolean;
  nothingToChange: boolean;
  scheduleChanges: boolean;
  siteChanges: boolean;
  customerChanges: boolean;
  primaryChanges: boolean;
  openShiftChoiceRequired: boolean;
  scheduledPrimaryConflict: { scheduledAssignmentId: string; scheduledValidFrom: string; label: string } | null;
  siteFinished: boolean;
  customerDisabled: boolean;
  hasSubmittedTimeAfter: boolean;
  hasRecordedTimeAfter: boolean;
}
interface PlacePreview {
  siteName: string;
  workAreaName: string | null;
  templateName: string | null;
  isPrimary: boolean;
}

type WhenChoice = 'today' | 'tomorrow' | 'date';
type ShiftHandling = 'KEEP_ON_OLD' | 'MOVE_TO_NEW';
type PrimaryResolution = 'KEEP_SCHEDULED' | 'REPLACE_SCHEDULED';

function placeLabel(p: PlacePreview): string {
  return p.workAreaName ? `${p.siteName} — ${p.workAreaName}` : p.siteName;
}

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §3.5 — ONE "Изменить место работы" form.
// Site · Customer · Schedule · Primary · When (today / tomorrow / pick a date). Every field
// defaults to the assignment's current value so changing one thing never silently changes another
// (fixes C4). Shows a plain-language "what will change" summary before the admin confirms, and —
// per §P4 — warns clearly when the change would replace an already-scheduled primary transfer.
export function ChangeWorkplaceForm({
  assignment,
  today,
  tomorrow
}: {
  assignment: CardAssignment;
  today: string;
  tomorrow: string;
}) {
  const router = useRouter();
  const locale = useAppLocale();
  const t = (en: string, ru: string) => localeText(locale, en, ru);

  const [open, setOpen] = useState(false);
  const [sites, setSites] = useState<Opt[]>([]);
  const [areas, setAreas] = useState<Opt[]>([]);
  const [templates, setTemplates] = useState<TemplateOpt[]>([]);

  const [siteId, setSiteId] = useState(assignment.siteId);
  const [workAreaId, setWorkAreaId] = useState(assignment.workAreaId ?? '');
  const [templateId, setTemplateId] = useState(assignment.templateId ?? '');
  const [isPrimary, setIsPrimary] = useState(assignment.isPrimary);
  const [when, setWhen] = useState<WhenChoice>('today');
  const [pickedDate, setPickedDate] = useState(tomorrow);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shiftChoiceNeeded, setShiftChoiceNeeded] = useState(false);
  const [scheduledConflict, setScheduledConflict] = useState<{ label: string; date: string } | null>(null);

  const effectiveFrom = when === 'today' ? today : when === 'tomorrow' ? tomorrow : pickedDate;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch('/api/admin/sites?pageSize=200&active=true', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((b: { items?: Opt[] }) => !cancelled && setSites(b.items ?? []))
      .catch(() => {});
    fetch('/api/admin/templates?pageSize=200', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((b: { items?: TemplateOpt[] }) => !cancelled && setTemplates((b.items ?? []).filter((x) => x.active || x.id === assignment.templateId)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, assignment.templateId]);

  useEffect(() => {
    if (!open || !siteId) {
      setAreas([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/admin/sites/${siteId}/work-areas?active=true&pageSize=200`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((b: { items?: Opt[] }) => !cancelled && setAreas(b.items ?? []))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, siteId]);

  const dirty = useMemo(
    () =>
      siteId !== assignment.siteId ||
      (workAreaId || null) !== assignment.workAreaId ||
      (templateId || null) !== (assignment.templateId ?? null) ||
      isPrimary !== assignment.isPrimary,
    [siteId, workAreaId, templateId, isPrimary, assignment]
  );

  function reset() {
    setOpen(false);
    setSiteId(assignment.siteId);
    setWorkAreaId(assignment.workAreaId ?? '');
    setTemplateId(assignment.templateId ?? '');
    setIsPrimary(assignment.isPrimary);
    setWhen('today');
    setPickedDate(tomorrow);
    setPreview(null);
    setError(null);
    setShiftChoiceNeeded(false);
    setScheduledConflict(null);
    setSubmitting(false);
    setPreviewing(false);
  }

  async function runPreview() {
    setError(null);
    setPreviewing(true);
    setPreview(null);
    try {
      const r = await fetch('/api/admin/assignments/change-preview', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF },
        body: JSON.stringify({ assignmentId: assignment.assignmentId, effectiveFrom, siteId, workAreaId: workAreaId || null, templateId: templateId || null, isPrimary })
      });
      const body = await r.json();
      if (!r.ok) {
        setError(previewError(body?.error?.code));
        setPreviewing(false);
        return;
      }
      setPreview(body as Preview);
    } catch {
      setError(t('Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
    }
    setPreviewing(false);
  }

  function previewError(code: string | undefined): string {
    switch (code) {
      case 'SITE_NOT_FOUND':
      case 'WORK_AREA_NOT_FOUND':
      case 'TEMPLATE_NOT_FOUND':
        return t('The selected site, customer or schedule no longer exists.', 'Выбранного объекта, заказчика или графика больше нет.');
      case 'FORBIDDEN':
        return t('You no longer have permission to change assignments.', 'У вас больше нет права менять назначения.');
      default:
        return t('Could not build the summary. Check the fields and try again.', 'Не удалось собрать сводку. Проверьте поля и попробуйте ещё раз.');
    }
  }

  async function submit(handling?: ShiftHandling, resolution?: PrimaryResolution) {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const r = await fetch(`/api/admin/assignments/${assignment.assignmentId}/change`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF },
        body: JSON.stringify({
          effectiveFrom,
          siteId,
          workAreaId: workAreaId || null,
          templateId: templateId || null,
          isPrimary,
          ...(handling ? { todayShiftHandling: handling } : {}),
          ...(resolution ? { primaryConflictResolution: resolution } : {})
        })
      });
      if (r.ok) {
        router.refresh();
        reset();
        return;
      }
      let code: string | undefined;
      let scheduledValidFrom: string | undefined;
      try {
        const b = await r.json();
        code = b?.error?.code;
        scheduledValidFrom = b?.error?.scheduledValidFrom;
      } catch {
        /* generic */
      }
      setSubmitting(false);
      if (code === 'OPEN_SHIFT_CHOICE_REQUIRED') {
        setShiftChoiceNeeded(true);
        return;
      }
      if (code === 'SCHEDULED_PRIMARY_CONFLICT') {
        setScheduledConflict({
          label: preview?.scheduledPrimaryConflict?.label ?? t('another site', 'другой объект'),
          date: scheduledValidFrom ?? preview?.scheduledPrimaryConflict?.scheduledValidFrom ?? ''
        });
        return;
      }
      setError(submitErrorText(code));
    } catch {
      setSubmitting(false);
      setError(t('Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
    }
  }

  function submitErrorText(code: string | undefined): string {
    switch (code) {
      case 'NOTHING_TO_CHANGE':
        return t('Nothing changed — pick a different site, customer or schedule.', 'Ничего не изменилось — выберите другой объект, заказчика или график.');
      case 'ASSIGNMENT_OVERLAP':
        return t('The worker already has an assignment on this site and customer for those dates.', 'У работника уже есть назначение на этот объект и заказчика в эти даты.');
      case 'ASSIGNMENT_HAS_SUBMITTED_TIME':
        return t('There are hours in a submitted timesheet on or after that date. Choose a date after the current period.', 'На эти даты уже есть часы в сданном табеле. Выберите дату после текущего периода.');
      case 'ASSIGNMENT_HAS_RECORDED_TIME':
        return t('The worker has already recorded hours here after that date. Change from tomorrow, or fix the day in the timesheet.', 'Работник уже отметил часы после этой даты. Переведите с завтра или поправьте день в табеле.');
      case 'ASSIGNMENT_ENDS_TOMORROW':
        return t('The current assignment already ends today.', 'Текущее назначение и так заканчивается сегодня.');
      case 'EFFECTIVE_ON_OR_BEFORE_START':
        return t('This assignment started today — change it from tomorrow.', 'Назначение началось сегодня — меняйте со завтрашнего дня.');
      case 'PRIMARY_PERIOD_CONFLICT':
        return t('The worker already has a primary assignment for that period — reload the card and try again.', 'У работника уже есть основное назначение на этот период — обновите карточку и попробуйте ещё раз.');
      case 'VERSION_CONFLICT':
        return t('The card changed in another window — reloading.', 'Карточка изменилась в другом окне — обновляем.');
      case 'SITE_FINISHED':
        return t('That site is finished — you cannot assign anyone to it.', 'Этот объект завершён — назначить на него нельзя.');
      case 'CUSTOMER_DISABLED':
        return t('That customer is turned off — pick another one or leave it without a customer.', 'Этот заказчик отключён — выберите другого или оставьте без заказчика.');
      case 'VALIDATION_ERROR':
        return t('Check the date — backdating is not available.', 'Проверьте дату — задним числом нельзя.');
      case 'FORBIDDEN':
        return t('You no longer have permission to change assignments.', 'У вас больше нет права менять назначения.');
      default:
        return t('Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.');
    }
  }

  if (!open) {
    return (
      <button type="button" className="setup-action" onClick={() => setOpen(true)}>
        {t('Change workplace', 'Изменить место работы')}
      </button>
    );
  }

  return (
    <div className="assignment-end-form" aria-busy={submitting || previewing}>
      <p className="setup-subtitle">
        {t('Now', 'Сейчас')}: <strong>{assignment.workAreaName ? `${assignment.siteName} — ${assignment.workAreaName}` : assignment.siteName}</strong>
        {assignment.isPrimary ? ` (${t('primary', 'основное')})` : ''}
      </p>

      <label htmlFor={`cw-site-${assignment.assignmentId}`}>{t('Site', 'Объект')}</label>
      <select
        id={`cw-site-${assignment.assignmentId}`}
        value={siteId}
        disabled={submitting}
        onChange={(e) => {
          setSiteId(e.target.value);
          setWorkAreaId('');
          setPreview(null);
        }}
      >
        {sites.length === 0 ? <option value={assignment.siteId}>{assignment.siteName}</option> : null}
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>

      <label htmlFor={`cw-area-${assignment.assignmentId}`}>{t('Customer', 'Заказчик')}</label>
      <select
        id={`cw-area-${assignment.assignmentId}`}
        value={workAreaId}
        disabled={submitting}
        onChange={(e) => {
          setWorkAreaId(e.target.value);
          setPreview(null);
        }}
      >
        <option value="">{t('— no customer —', '— без заказчика —')}</option>
        {areas.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>

      <label htmlFor={`cw-tpl-${assignment.assignmentId}`}>{t('Work schedule', 'Рабочий график')}</label>
      <select
        id={`cw-tpl-${assignment.assignmentId}`}
        value={templateId}
        disabled={submitting}
        onChange={(e) => {
          setTemplateId(e.target.value);
          setPreview(null);
        }}
      >
        <option value="">{t('No schedule template', 'Без шаблона графика')}</option>
        {templates.map((tpl) => (
          <option key={tpl.id} value={tpl.id}>
            {tpl.name}
            {tpl.currentVersionNumber ? ` (v${tpl.currentVersionNumber})` : ''}
          </option>
        ))}
      </select>

      <label htmlFor={`cw-primary-${assignment.assignmentId}`}>
        <input
          id={`cw-primary-${assignment.assignmentId}`}
          type="checkbox"
          checked={isPrimary}
          disabled={submitting}
          onChange={(e) => {
            setIsPrimary(e.target.checked);
            setPreview(null);
          }}
        />{' '}
        {t('This is the main workplace', 'Это основное место работы')}
      </label>

      <fieldset className="assignment-when">
        <legend>{t('When does this start?', 'С какого дня?')}</legend>
        <label>
          <input type="radio" name={`cw-when-${assignment.assignmentId}`} checked={when === 'today'} disabled={submitting} onChange={() => { setWhen('today'); setPreview(null); }} />{' '}
          {t('Today', 'Сегодня')}
        </label>
        <label>
          <input type="radio" name={`cw-when-${assignment.assignmentId}`} checked={when === 'tomorrow'} disabled={submitting} onChange={() => { setWhen('tomorrow'); setPreview(null); }} />{' '}
          {t('Tomorrow', 'Завтра')}
        </label>
        <label>
          <input type="radio" name={`cw-when-${assignment.assignmentId}`} checked={when === 'date'} disabled={submitting} onChange={() => { setWhen('date'); setPreview(null); }} />{' '}
          {t('Pick a date', 'Выбрать дату')}
        </label>
        {when === 'date' ? (
          <input
            type="date"
            aria-label={t('Start date', 'Дата начала')}
            min={tomorrow}
            value={pickedDate}
            disabled={submitting}
            onChange={(e) => {
              setPickedDate(e.target.value);
              setPreview(null);
            }}
          />
        ) : null}
      </fieldset>

      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}

      {scheduledConflict ? (
        <div className="worker-setup-callout" role="group">
          <p>
            {t(
              `This worker already has a transfer scheduled to ${scheduledConflict.label} from ${scheduledConflict.date}. Making this the main workplace now would replace that plan.`,
              `У работника уже запланирован перевод на «${scheduledConflict.label}» с ${scheduledConflict.date}. Сделать это основным сейчас — значит заменить тот план.`
            )}
          </p>
          <button type="button" className="setup-action" disabled={submitting} onClick={() => void submit(undefined, 'KEEP_SCHEDULED')}>
            {t('Keep the scheduled transfer (this change is not made primary)', 'Оставить запланированный перевод (это изменение не станет основным)')}
          </button>
          <button type="button" className="setup-action" disabled={submitting} onClick={() => void submit(undefined, 'REPLACE_SCHEDULED')}>
            {t('Replace the scheduled transfer', 'Заменить запланированный перевод')}
          </button>
          <button type="button" className="setup-action" disabled={submitting} onClick={() => setScheduledConflict(null)}>
            {t('Back', 'Назад')}
          </button>
        </div>
      ) : shiftChoiceNeeded ? (
        <div className="worker-setup-callout" role="group">
          <p>{t('The worker is on an open shift right now. How should today count?', 'У работника сейчас идёт смена. Как засчитать сегодняшний день?')}</p>
          <button type="button" className="setup-action" disabled={submitting} onClick={() => void submit('KEEP_ON_OLD')}>
            {t('Finish today on the current site — the change starts tomorrow', 'Доработать сегодня на текущем объекте — перевод с завтра')}
          </button>
          <button type="button" className="setup-action" disabled={submitting} onClick={() => void submit('MOVE_TO_NEW')}>
            {t("Move today's shift too — the whole shift goes to the new site", 'Перенести и сегодняшнюю смену — весь день на новый объект')}
          </button>
          <button type="button" className="setup-action" disabled={submitting} onClick={reset}>
            {t('Cancel', 'Отмена')}
          </button>
        </div>
      ) : preview ? (
        <div className="worker-setup-callout">
          <p>
            <strong>{placeLabel(preview.from)}</strong> → <strong>{placeLabel(preview.to)}</strong>
          </p>
          <p className="setup-subtitle">
            {preview.isImmediate
              ? t('Starts today.', 'Действует с сегодня.')
              : t(`Starts on ${preview.effectiveFrom}.`, `Действует с ${preview.effectiveFrom}.`)}{' '}
            {preview.scheduleChanges
              ? t('The work schedule changes.', 'Рабочий график изменится.')
              : t('The work schedule stays the same.', 'Рабочий график не изменится.')}{' '}
            {preview.primaryChanges
              ? preview.to.isPrimary
                ? t('This becomes the main workplace.', 'Это станет основным местом работы.')
                : t('This stops being the main workplace.', 'Это перестанет быть основным местом.')
              : ''}
          </p>
          {preview.scheduledPrimaryConflict ? (
            <p className="login-error" role="alert">
              {t(
                `Warning: this worker already has a transfer scheduled to ${preview.scheduledPrimaryConflict.label} from ${preview.scheduledPrimaryConflict.scheduledValidFrom}. If this change is the main workplace you will be asked to keep or replace that plan.`,
                `Внимание: у работника уже запланирован перевод на «${preview.scheduledPrimaryConflict.label}» с ${preview.scheduledPrimaryConflict.scheduledValidFrom}. Если это изменение — основное место, вас спросят: оставить или заменить тот план.`
              )}
            </p>
          ) : null}
          {preview.openShiftChoiceRequired ? (
            <p className="setup-subtitle">{t('The worker is on an open shift — you will choose how today counts.', 'У работника идёт смена — вы выберете, как засчитать сегодня.')}</p>
          ) : null}
          {preview.hasSubmittedTimeAfter ? (
            <p className="login-error">{t('There are hours in a submitted timesheet on or after that date.', 'На эти даты есть часы в сданном табеле.')}</p>
          ) : null}
          {preview.siteFinished ? <p className="login-error">{t('That site is finished.', 'Этот объект завершён.')}</p> : null}
          {preview.customerDisabled ? <p className="login-error">{t('That customer is turned off.', 'Этот заказчик отключён.')}</p> : null}
          {preview.nothingToChange ? <p className="login-error">{t('Nothing would change.', 'Ничего не изменится.')}</p> : null}
          <button
            type="button"
            className="setup-action"
            disabled={submitting || preview.nothingToChange || preview.hasSubmittedTimeAfter || preview.siteFinished}
            onClick={() => void submit()}
          >
            {submitting ? t('Applying…', 'Применяем…') : t('Confirm the change', 'Подтвердить изменение')}
          </button>
          <button type="button" className="setup-action" disabled={submitting} onClick={() => setPreview(null)}>
            {t('Edit', 'Изменить')}
          </button>
          <button type="button" className="setup-action" disabled={submitting} onClick={reset}>
            {t('Cancel', 'Отмена')}
          </button>
        </div>
      ) : (
        <>
          <button type="button" className="setup-action" disabled={previewing || !dirty} onClick={() => void runPreview()}>
            {previewing ? t('Checking…', 'Проверяем…') : t('Show what will change', 'Показать, что изменится')}
          </button>
          <button type="button" className="setup-action" onClick={reset}>
            {t('Cancel', 'Отмена')}
          </button>
          {!dirty ? <p className="setup-subtitle">{t('Change a field above to continue.', 'Измените поле выше, чтобы продолжить.')}</p> : null}
        </>
      )}
    </div>
  );
}
