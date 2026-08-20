'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

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
    fetch('/api/admin/sites?pageSize=100', { credentials: 'same-origin' })
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
          setErrorMessage('This worker already has an overlapping assignment for this site and work area.');
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
            setErrorMessage('Please check the fields above.');
            break;
          case 'EMPLOYEE_NOT_FOUND':
            setErrorMessage('Selected worker no longer exists.');
            break;
          case 'SITE_NOT_FOUND':
            setErrorMessage('Selected site no longer exists.');
            break;
          case 'WORK_AREA_NOT_FOUND':
            setErrorMessage('Selected work area no longer exists on this site.');
            break;
          case 'TEMPLATE_NOT_FOUND':
            setErrorMessage('Selected work schedule template no longer exists.');
            break;
          case 'EMPLOYEE_NOT_ACTIVE':
            setErrorMessage('This worker is not active — reactivate them first.');
            break;
          case 'ASSIGNMENT_OVERLAP':
            setErrorMessage('This worker already has an overlapping assignment for this site and work area.');
            break;
          case 'NOT_AUTHENTICATED':
            setErrorMessage('Your session expired — please sign in again.');
            break;
          case 'FORBIDDEN':
            setErrorMessage('You no longer have permission to create assignments.');
            break;
          default:
            setErrorMessage('Something went wrong. Please try again.');
        }
        setLoading(false);
        return;
      }

      // This guided flow starts on the worker detail page, so that RSC may already be present in
      // the App Router cache. A document navigation deliberately forces readiness to be recomputed
      // from the newly-created assignment/period participant before the profile is shown again.
      window.location.assign(returnEmployeeId ? `/admin/workers/${returnEmployeeId}` : '/admin/setup');
    } catch {
      setErrorMessage('Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} aria-busy={loading}>
      <div className="login-field">
        <label htmlFor="assignment-employee">Worker</label>
        <select
          id="assignment-employee"
          required
          disabled={loading || lockEmployee}
          value={employeeId}
          onChange={(event) => setEmployeeId(event.target.value)}
        >
          <option value="">Select a worker</option>
          {workers.map((worker) => (
            <option key={worker.id} value={worker.id}>
              #{worker.employeeNumber} {worker.firstName} {worker.lastName}
            </option>
          ))}
        </select>
        {lockEmployee ? <p className="setup-subtitle">This work setup belongs to the worker shown above.</p> : null}
      </div>

      <div className="login-field">
        <label htmlFor="assignment-site">Site</label>
        <select
          id="assignment-site"
          required
          disabled={loading}
          value={siteId}
          onChange={(event) => setSiteId(event.target.value)}
        >
          <option value="">Select a site</option>
          {sites.map((site) => (
            <option key={site.id} value={site.id}>
              {site.name}
            </option>
          ))}
        </select>
        {sites.length === 1 ? <p className="setup-subtitle">The only active site was selected automatically.</p> : null}
      </div>

      <div className="login-field">
        <label htmlFor="assignment-work-area">Work area (optional)</label>
        <select
          id="assignment-work-area"
          disabled={loading || !siteId}
          value={workAreaId}
          onChange={(event) => setWorkAreaId(event.target.value)}
        >
          <option value="">No specific work area</option>
          {workAreas.map((area) => (
            <option key={area.id} value={area.id}>
              {area.name}
            </option>
          ))}
        </select>
      </div>

      <div className="login-field">
        <label htmlFor="assignment-template">Work schedule template</label>
        <select
          id="assignment-template"
          disabled={loading}
          value={templateId}
          onChange={(event) => setTemplateId(event.target.value)}
        >
          <option value="">No schedule template</option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name} (v{template.currentVersionNumber ?? '—'})
            </option>
          ))}
        </select>
        <p className="setup-subtitle">Without a template, this assignment&apos;s worked hours will be treated as a schedule exception during foreman review.</p>
      </div>

      <div className="login-field">
        <label htmlFor="assignment-valid-from">Start date</label>
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
        <label htmlFor="assignment-valid-to">End date (optional — leave blank for indefinite)</label>
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
          Primary assignment
        </label>
      </div>

      {errorMessage ? (
        <p className="login-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <button className="login-submit" type="submit" disabled={loading}>
        {loading ? 'Creating…' : 'Create assignment'}
      </button>
    </form>
  );
}
