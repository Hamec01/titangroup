'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';

const CSRF_HEADER_VALUE = 'titanor-time';

interface SiteOption {
  id: string;
  name: string;
}
interface WorkAreaOption {
  id: string;
  name: string;
}
interface TemplateOption {
  id: string;
  name: string;
  active: boolean;
  currentVersionNumber: number | null;
}

type Phase = 'collapsed' | 'pick' | 'zone' | 'full';
type Handling = 'KEEP_ON_OLD' | 'MOVE_TO_NEW';

interface ChangeAssignmentActionProps {
  assignment: {
    id: string;
    siteId: string;
    siteName: string;
    workAreaId: string | null;
    templateId: string | null;
  };
  /** helsinkiToday() as YYYY-MM-DD — the earliest allowed effective date (no backdating). */
  today: string;
}

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §6 — the worker card's "Изменить объект / зону"
// action. Calls POST /api/admin/assignments/:id/change, which closes this assignment the day
// before the effective date and opens a fully-materialised replacement. Two modes: a one-click
// "just the work area, from today" and a full "move to another site/zone from a chosen date".
export function ChangeAssignmentAction({ assignment, today }: ChangeAssignmentActionProps) {
  const router = useRouter();
  const locale = useAppLocale();

  const [phase, setPhase] = useState<Phase>('collapsed');
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [workAreas, setWorkAreas] = useState<WorkAreaOption[]>([]);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);

  const [siteId, setSiteId] = useState(assignment.siteId);
  const [workAreaId, setWorkAreaId] = useState(assignment.workAreaId ?? '');
  const [templateId, setTemplateId] = useState(assignment.templateId ?? '');
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [isPrimary, setIsPrimary] = useState(false);

  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [openShiftPrompt, setOpenShiftPrompt] = useState(false);

  const expanded = phase !== 'collapsed';

  useEffect(() => {
    if (!expanded) {
      return;
    }
    let cancelled = false;
    fetch('/api/admin/sites?pageSize=100', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((b: { items?: SiteOption[] }) => {
        if (!cancelled) setSites(b.items ?? []);
      })
      .catch(() => {});
    fetch('/api/admin/templates?pageSize=100', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((b: { items?: TemplateOption[] }) => {
        if (!cancelled) setTemplates((b.items ?? []).filter((t) => t.active || t.id === assignment.templateId));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [expanded, assignment.templateId]);

  useEffect(() => {
    if (!expanded || !siteId) {
      setWorkAreas([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/admin/sites/${siteId}/work-areas?active=true&pageSize=100`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((b: { items?: WorkAreaOption[] }) => {
        if (!cancelled) setWorkAreas(b.items ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [expanded, siteId]);

  function reset() {
    setPhase('collapsed');
    setSiteId(assignment.siteId);
    setWorkAreaId(assignment.workAreaId ?? '');
    setTemplateId(assignment.templateId ?? '');
    setEffectiveFrom(today);
    setIsPrimary(false);
    setErrorMessage(null);
    setOpenShiftPrompt(false);
    setLoading(false);
  }

  async function submit(handling?: Handling): Promise<void> {
    if (loading) {
      return;
    }
    setErrorMessage(null);
    setLoading(true);

    const body: Record<string, unknown> = {
      effectiveFrom: phase === 'zone' ? today : effectiveFrom,
      siteId: phase === 'zone' ? assignment.siteId : siteId,
      workAreaId: workAreaId || null,
      templateId: templateId || null,
      isPrimary,
      ...(handling ? { todayShiftHandling: handling } : {})
    };

    try {
      const response = await fetch(`/api/admin/assignments/${assignment.id}/change`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify(body)
      });

      if (response.ok) {
        router.refresh();
        reset();
        return;
      }

      let code: string | undefined;
      try {
        const b = (await response.json()) as { error?: { code?: string } };
        code = b.error?.code;
      } catch {
        // fall through to the generic message
      }

      if (code === 'OPEN_SHIFT_CHOICE_REQUIRED') {
        setOpenShiftPrompt(true);
        setLoading(false);
        return;
      }
      setOpenShiftPrompt(false);
      setLoading(false);
      switch (code) {
        case 'NOTHING_TO_CHANGE':
          setErrorMessage(localeText(locale, 'Nothing changed — pick a different site, work area or schedule.', 'Ничего не изменилось — выберите другой объект, зону или график.'));
          break;
        case 'ASSIGNMENT_OVERLAP':
          setErrorMessage(localeText(locale, 'The worker already has an assignment on this site and work area for those dates.', 'У работника уже есть назначение на этот объект и зону в эти даты.'));
          break;
        case 'ASSIGNMENT_HAS_SUBMITTED_TIME':
          setErrorMessage(localeText(locale, 'There are hours in a submitted timesheet on or after that date. Choose a date after the current period.', 'На эти даты уже есть часы в сданном табеле. Выберите дату после текущего периода.'));
          break;
        case 'ASSIGNMENT_HAS_RECORDED_TIME':
          setErrorMessage(localeText(locale, 'The worker has already recorded hours here on or after that date. Change from tomorrow, or fix the site on the day in the timesheet.', 'Работник уже отметил часы на этом назначении. Выберите завтрашний день или поправьте объект в табеле.'));
          break;
        case 'ASSIGNMENT_ENDS_TOMORROW':
          setErrorMessage(localeText(locale, 'The current assignment already ends today.', 'Текущее назначение и так заканчивается сегодня.'));
          break;
        case 'EFFECTIVE_ON_OR_BEFORE_START':
          setErrorMessage(localeText(locale, 'This assignment started today — change it from tomorrow, or remove it and create a new one.', 'Назначение началось сегодня — меняйте со завтрашнего дня, или удалите и создайте заново.'));
          break;
        case 'VALIDATION_ERROR':
          setErrorMessage(localeText(locale, 'Check the date — backdating is not available.', 'Проверьте дату — задним числом нельзя.'));
          break;
        case 'SITE_NOT_FOUND':
        case 'WORK_AREA_NOT_FOUND':
        case 'TEMPLATE_NOT_FOUND':
          setErrorMessage(localeText(locale, 'The selected site, work area or schedule no longer exists.', 'Выбранного объекта, зоны или графика больше нет.'));
          break;
        case 'FORBIDDEN':
          setErrorMessage(localeText(locale, 'You no longer have permission to change assignments.', 'У вас больше нет права менять назначения.'));
          break;
        default:
          setErrorMessage(localeText(locale, 'Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.'));
      }
    } catch {
      setOpenShiftPrompt(false);
      setLoading(false);
      setErrorMessage(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
    }
  }

  function handleFormSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void submit();
  }

  if (phase === 'collapsed') {
    return (
      <button type="button" className="setup-action" onClick={() => setPhase('pick')}>
        {localeText(locale, 'Change site / work area', 'Изменить объект / зону')}
      </button>
    );
  }

  if (phase === 'pick') {
    return (
      <div className="assignment-end-form">
        <p className="setup-subtitle">{localeText(locale, 'How do you want to change this assignment?', 'Как изменить это назначение?')}</p>
        <button type="button" className="setup-action" onClick={() => setPhase('zone')}>
          {localeText(locale, 'Change the work area only (same site, from today)', 'Сменить только рабочую зону (объект тот же, с сегодня)')}
        </button>
        <button type="button" className="setup-action" onClick={() => setPhase('full')}>
          {localeText(locale, 'Move to another site / work area (choose the date)', 'Перевести на другой объект / зону (с выбором даты)')}
        </button>
        <button type="button" className="setup-action" onClick={reset}>
          {localeText(locale, 'Cancel', 'Отмена')}
        </button>
      </div>
    );
  }

  const openShiftBlock = openShiftPrompt ? (
    <div className="worker-setup-callout" role="group">
      <p>{localeText(locale, 'The worker is on an open shift right now. How should today count?', 'У работника сейчас идёт смена. Как засчитать сегодняшний день?')}</p>
      <button type="button" className="setup-action" disabled={loading} onClick={() => void submit('KEEP_ON_OLD')}>
        {localeText(locale, 'Finish today on the current site — change starts tomorrow', 'Сегодня доработает на текущем объекте — перевод с завтра')}
      </button>
      <button type="button" className="setup-action" disabled={loading} onClick={() => void submit('MOVE_TO_NEW')}>
        {localeText(locale, "Move today too — the whole of today's shift goes to the new site", 'Перенести и сегодня — вся сегодняшняя смена на новый объект')}
      </button>
      <button type="button" className="setup-action" disabled={loading} onClick={reset}>
        {localeText(locale, 'Cancel', 'Отмена')}
      </button>
    </div>
  ) : null;

  return (
    <form onSubmit={handleFormSubmit} aria-busy={loading} className="assignment-end-form">
      {phase === 'full' ? (
        <>
          <label htmlFor={`change-site-${assignment.id}`}>{localeText(locale, 'Site', 'Объект')}</label>
          <select
            id={`change-site-${assignment.id}`}
            disabled={loading}
            value={siteId}
            onChange={(e) => {
              setSiteId(e.target.value);
              setWorkAreaId('');
            }}
          >
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
        </>
      ) : (
        <p className="setup-subtitle">
          {localeText(locale, 'Site', 'Объект')}: {assignment.siteName}
        </p>
      )}

      <label htmlFor={`change-area-${assignment.id}`}>{localeText(locale, 'Work area', 'Рабочая зона')}</label>
      <select id={`change-area-${assignment.id}`} disabled={loading} value={workAreaId} onChange={(e) => setWorkAreaId(e.target.value)}>
        <option value="">{localeText(locale, '— no work area —', '— без рабочей зоны —')}</option>
        {workAreas.map((area) => (
          <option key={area.id} value={area.id}>
            {area.name}
          </option>
        ))}
      </select>

      {phase === 'full' ? (
        <>
          <label htmlFor={`change-template-${assignment.id}`}>{localeText(locale, 'Work schedule template', 'Шаблон рабочего графика')}</label>
          <select id={`change-template-${assignment.id}`} disabled={loading} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">{localeText(locale, 'No schedule template', 'Без шаблона графика')}</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.currentVersionNumber ? ` (v${t.currentVersionNumber})` : ''}
              </option>
            ))}
          </select>

          <label htmlFor={`change-from-${assignment.id}`}>{localeText(locale, 'Effective from', 'Действует с')}</label>
          <input
            id={`change-from-${assignment.id}`}
            type="date"
            required
            min={today}
            disabled={loading}
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
          />

          <label htmlFor={`change-primary-${assignment.id}`}>
            <input
              id={`change-primary-${assignment.id}`}
              type="checkbox"
              disabled={loading}
              checked={isPrimary}
              onChange={(e) => setIsPrimary(e.target.checked)}
            />{' '}
            {localeText(locale, 'Primary assignment', 'Основное назначение')}
          </label>
        </>
      ) : (
        <p className="setup-subtitle">{localeText(locale, 'Effective from today.', 'Действует с сегодняшнего дня.')}</p>
      )}

      {errorMessage ? (
        <p className="login-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      {openShiftBlock ?? (
        <>
          <button type="submit" className="setup-action" disabled={loading}>
            {loading ? localeText(locale, 'Applying…', 'Применяем…') : localeText(locale, 'Apply change', 'Применить изменение')}
          </button>
          <button type="button" className="setup-action" disabled={loading} onClick={reset}>
            {localeText(locale, 'Cancel', 'Отмена')}
          </button>
        </>
      )}
    </form>
  );
}
