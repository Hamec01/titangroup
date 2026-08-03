'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

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

export function NewAssignmentForm() {
  const router = useRouter();
  const [workers, setWorkers] = useState<WorkerOption[]>([]);
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [workAreas, setWorkAreas] = useState<WorkAreaOption[]>([]);

  const [employeeId, setEmployeeId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [workAreaId, setWorkAreaId] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
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
          setSites(body.items ?? []);
        }
      })
      .catch(() => {
        // Same as above — the site dropdown just stays empty.
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

      router.push('/admin/setup');
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
          disabled={loading}
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
