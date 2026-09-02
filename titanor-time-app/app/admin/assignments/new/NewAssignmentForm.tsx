'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';
import { localeText } from '@/lib/i18n/locale';

const CSRF_HEADER_VALUE = 'titanor-time';

interface WorkerOption {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
}

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
  active: boolean;
  name: string;
  currentVersionNumber: number | null;
}

interface NewAssignmentFormProps {
  initialEmployeeId?: string;
  initialValidFrom?: string;
  initialIsPrimary?: boolean;
  returnEmployeeId?: string | null;
  lockEmployee?: boolean;
}

export function NewAssignmentForm({
  initialEmployeeId = '',
  initialValidFrom = '',
  initialIsPrimary = false,
  returnEmployeeId = null,
  lockEmployee = false
}: NewAssignmentFormProps) {
  const locale = useAppLocale();
  const s = adminDailyStrings(locale);
  const [workers, setWorkers] = useState<WorkerOption[]>([]);
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [workAreas, setWorkAreas] = useState<WorkAreaOption[]>([]);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);

  const [employeeId, setEmployeeId] = useState(initialEmployeeId);
  const [siteId, setSiteId] = useState('');
  const [workAreaId, setWorkAreaId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [validFrom, setValidFrom] = useState(initialValidFrom);
  const [validTo, setValidTo] = useState('');
  const [isPrimary, setIsPrimary] = useState(initialIsPrimary);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const idempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/workers?pageSize=100', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((body: { items?: WorkerOption[] }) => {
        if (!cancelled) {
          setWorkers(body.items ?? []);
        }
      })
      .catch(() => {
        // Handled by the submit-time "employeeId required" validation if this silently fails.
      });
    fetch('/api/admin/sites?pageSize=100&active=true', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((body: { items?: SiteOption[] }) => {
        if (!cancelled) {
          const nextSites = body.items ?? [];
          setSites(nextSites);
          if (nextSites.length === 1) {
            setSiteId(nextSites[0].id);
          }
        }
      })
      .catch(() => {
        // Same as above — the site dropdown just stays empty.
      });
    // Independent of siteId — a template is a global entity, not scoped to a site, so this fetch
    // fires once alongside workers/sites and is never re-triggered by the site/work-area effect
    // below, which is what keeps a template selection from being reset by changing Site/Work area.
    fetch('/api/admin/templates?pageSize=100', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((body: { items?: TemplateOption[] }) => {
        if (cancelled) {
          return;
        }
        const activeTemplates = (body.items ?? []).filter((t) => t.active);
        setTemplates(activeTemplates);
        if (activeTemplates.length === 1) {
          setTemplateId(activeTemplates[0].id);
        }
      })
      .catch(() => {
        // Template is optional — a failed fetch just leaves the dropdown at "No schedule template".
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!siteId) {
      setWorkAreas([]);
      setWorkAreaId('');
      return;
    }
    let cancelled = false;
    fetch(`/api/admin/sites/${siteId}/work-areas?active=true&pageSize=100`, { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((body: { items?: WorkAreaOption[] }) => {
        if (!cancelled) {
          setWorkAreas(body.items ?? []);
        }
      })
      .catch(() => {
        // Work area is optional — a failed fetch just leaves the dropdown empty.
      });
    return () => {
      cancelled = true;
    };
  }, [siteId]);

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

    const payload = {
      employeeId,
      siteId,
      workAreaId: workAreaId || undefined,
      templateId: templateId || undefined,
      validFrom,
      validTo: validTo || undefined,
      isPrimary
    };

    try {
      // Pre-flight check — catches the common case with immediate, specific
      // feedback before spending an Idempotency-Key on a request that would
      // just come back 409 ASSIGNMENT_OVERLAP anyway. The create endpoint
      // still re-validates this itself (race-safe via the DB exclusion
      // constraint), so this is a UX nicety, not the real guarantee.
      const overlapResponse = await fetch('/api/admin/assignments/validate-overlap', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ employeeId, siteId, workAreaId: workAreaId || undefined, validFrom, validTo: validTo || undefined })
      });
      if (overlapResponse.ok) {
        const overlapBody = (await overlapResponse.json()) as { hasOverlap: boolean };
        if (overlapBody.hasOverlap) {
          setErrorMessage(localeText(locale, 'This worker already has an overlapping assignment for this site and work area.', 'У работника уже есть пересекающееся назначение на этот объект и рабочую зону.'));
          setLoading(false);
          return;
        }
      }

      const response = await fetch('/api/admin/assignments', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': CSRF_HEADER_VALUE,
          'Idempotency-Key': idempotencyKeyRef.current
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        idempotencyKeyRef.current = null;

        let code: string | undefined;
        try {
          const body = (await response.json()) as { error?: { code?: string } };
          code = body.error?.code;
        } catch {
          // Non-JSON error body — fall through to the generic message.
        }

        switch (code) {
          case 'VALIDATION_ERROR':
            setErrorMessage(localeText(locale, 'Please check the fields above.', 'Проверьте заполненные поля.'));
            break;
          case 'EMPLOYEE_NOT_FOUND':
            setErrorMessage(localeText(locale, 'Selected worker no longer exists.', 'Выбранного работника больше нет.'));
            break;
          case 'SITE_NOT_FOUND':
            setErrorMessage(localeText(locale, 'Selected site no longer exists.', 'Выбранного объекта больше нет.'));
            break;
          case 'WORK_AREA_NOT_FOUND':
            setErrorMessage(localeText(locale, 'Selected work area no longer exists on this site.', 'Выбранной рабочей зоны больше нет на этом объекте.'));
            break;
          case 'TEMPLATE_NOT_FOUND':
            setErrorMessage(localeText(locale, 'Selected work schedule template no longer exists.', 'Выбранного шаблона графика больше нет.'));
            break;
          case 'EMPLOYEE_NOT_ACTIVE':
            setErrorMessage(localeText(locale, 'This worker is not active — reactivate them first.', 'Работник неактивен — сначала восстановите его.'));
            break;
          case 'ASSIGNMENT_OVERLAP':
            setErrorMessage(localeText(locale, 'This worker already has an overlapping assignment for this site and work area.', 'У работника уже есть пересекающееся назначение на этот объект и рабочую зону.'));
            break;
          case 'NOT_AUTHENTICATED':
            setErrorMessage(localeText(locale, 'Your session expired — please sign in again.', 'Сессия завершилась — войдите снова.'));
            break;
          case 'FORBIDDEN':
            setErrorMessage(localeText(locale, 'You no longer have permission to create assignments.', 'У вас больше нет права создавать назначения.'));
            break;
          default:
            setErrorMessage(localeText(locale, 'Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.'));
        }
        setLoading(false);
        return;
      }

      // This guided flow starts on the worker detail page, so that RSC may already be present in
      // the App Router cache. A document navigation deliberately forces readiness to be recomputed
      // from the newly-created assignment/period participant before the profile is shown again.
      window.location.assign(returnEmployeeId ? `/admin/workers/${returnEmployeeId}` : '/admin/setup');
    } catch {
      setErrorMessage(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} aria-busy={loading}>
      <div className="login-field">
        <label htmlFor="assignment-employee">{s.assignments.worker}</label>
        <select
          id="assignment-employee"
          required
          disabled={loading || lockEmployee}
          value={employeeId}
          onChange={(event) => setEmployeeId(event.target.value)}
        >
          <option value="">{localeText(locale, 'Select a worker', 'Выберите работника')}</option>
          {workers.map((worker) => (
            <option key={worker.id} value={worker.id}>
              #{worker.employeeNumber} {worker.firstName} {worker.lastName}
            </option>
          ))}
        </select>
        {lockEmployee ? <p className="setup-subtitle">{localeText(locale, 'This work setup belongs to the worker shown above.', 'Эта настройка относится к работнику, указанному выше.')}</p> : null}
      </div>

      <div className="login-field">
        <label htmlFor="assignment-site">{s.assignments.site}</label>
        <select
          id="assignment-site"
          required
          disabled={loading}
          value={siteId}
          onChange={(event) => setSiteId(event.target.value)}
        >
          <option value="">{localeText(locale, 'Select a site', 'Выберите объект')}</option>
          {sites.map((site) => (
            <option key={site.id} value={site.id}>
              {site.name}
            </option>
          ))}
        </select>
        {sites.length === 1 ? <p className="setup-subtitle">{localeText(locale, 'The only active site was selected automatically.', 'Единственный активный объект выбран автоматически.')}</p> : null}
      </div>

      <div className="login-field">
        <label htmlFor="assignment-work-area">{localeText(locale, 'Work area (optional)', 'Рабочая зона (необязательно)')}</label>
        <select
          id="assignment-work-area"
          disabled={loading || !siteId}
          value={workAreaId}
          onChange={(event) => setWorkAreaId(event.target.value)}
        >
          <option value="">{localeText(locale, 'No specific work area', 'Без конкретной рабочей зоны')}</option>
          {workAreas.map((area) => (
            <option key={area.id} value={area.id}>
              {area.name}
            </option>
          ))}
        </select>
      </div>

      <div className="login-field">
        <label htmlFor="assignment-template">{localeText(locale, 'Work schedule template', 'Шаблон рабочего графика')}</label>
        <select
          id="assignment-template"
          disabled={loading}
          value={templateId}
          onChange={(event) => setTemplateId(event.target.value)}
        >
          <option value="">{localeText(locale, 'No schedule template', 'Без шаблона графика')}</option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name} (v{template.currentVersionNumber ?? '—'})
            </option>
          ))}
        </select>
        <p className="setup-subtitle">{localeText(locale, "Without a template, this assignment's worked hours will be treated as a schedule exception during review.", 'Без шаблона отработанные часы будут отмечены как отклонение от графика при проверке.')}</p>
      </div>

      <div className="login-field">
        <label htmlFor="assignment-valid-from">{localeText(locale, 'Start date', 'Дата начала')}</label>
        <input
          id="assignment-valid-from"
          type="date"
          required
          disabled={loading}
          value={validFrom}
          onChange={(event) => setValidFrom(event.target.value)}
        />
      </div>

      <div className="login-field">
        <label htmlFor="assignment-valid-to">{localeText(locale, 'End date (optional — leave blank for indefinite)', 'Дата окончания (необязательно — оставьте пустой для бессрочного назначения)')}</label>
        <input
          id="assignment-valid-to"
          type="date"
          disabled={loading}
          value={validTo}
          onChange={(event) => setValidTo(event.target.value)}
        />
      </div>

      <div className="login-field">
        <label htmlFor="assignment-is-primary">
          <input
            id="assignment-is-primary"
            type="checkbox"
            disabled={loading}
            checked={isPrimary}
            onChange={(event) => setIsPrimary(event.target.checked)}
          />{' '}
          {localeText(locale, 'Primary assignment', 'Основное назначение')}
        </label>
      </div>

      {errorMessage ? (
        <p className="login-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <button className="login-submit" type="submit" disabled={loading}>
        {loading ? s.common.creating : localeText(locale, 'Create assignment', 'Создать назначение')}
      </button>
    </form>
  );
}
