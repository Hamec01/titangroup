'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { SiteWorkArea } from '@/lib/sites';

const CSRF_HEADER_VALUE = 'titanor-time';

async function parseErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    return body.error?.code;
  } catch {
    return undefined;
  }
}

function errorMessageFor(code: string | undefined): string {
  switch (code) {
    case 'VALIDATION_ERROR':
      return 'Please check the name.';
    case 'DUPLICATE_WORK_AREA_NAME':
      return 'A work area with this name already exists on this site.';
    case 'VERSION_CONFLICT':
      return 'This work area was changed elsewhere — reloading.';
    case 'FORBIDDEN':
      return 'You no longer have permission to manage work areas.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

function ToggleActiveButton({ siteId, area, disabled }: { siteId: string; area: SiteWorkArea; disabled: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleClick(): Promise<void> {
    if (loading || disabled) {
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/sites/${siteId}/work-areas/${area.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ version: area.version, active: !area.active })
      });
      if (!response.ok) {
        const code = await parseErrorCode(response);
        window.alert(errorMessageFor(code));
        if (code === 'VERSION_CONFLICT') {
          router.refresh();
        }
        setLoading(false);
        return;
      }
      router.refresh();
    } catch {
      window.alert('Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <button type="button" className="setup-action" onClick={handleClick} disabled={loading || disabled}>
      {area.active ? 'Deactivate' : 'Activate'}
    </button>
  );
}

export function WorkAreaSection({ siteId, workAreas }: { siteId: string; workAreas: SiteWorkArea[] }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading) {
      return;
    }
    setErrorMessage(null);
    setLoading(true);

    try {
      const response = await fetch(`/api/admin/sites/${siteId}/work-areas`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ name })
      });

      if (!response.ok) {
        const code = await parseErrorCode(response);
        setErrorMessage(errorMessageFor(code));
        setLoading(false);
        return;
      }

      setName('');
      router.refresh();
      setLoading(false);
    } catch {
      setErrorMessage('Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <>
      <h2>Work areas</h2>
      {workAreas.length === 0 ? (
        <p>None yet.</p>
      ) : (
        <ul className="setup-list">
          {workAreas.map((area) => (
            <li key={area.id} className="setup-item">
              <span className="setup-label">
                {area.name}
                {!area.active ? ' (inactive)' : ''}
              </span>
              <ToggleActiveButton siteId={siteId} area={area} disabled={loading} />
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleCreate} aria-busy={loading}>
        <div className="login-field">
          <label htmlFor="work-area-name">New work area name</label>
          <input
            id="work-area-name"
            type="text"
            required
            disabled={loading}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        {errorMessage ? (
          <p className="login-error" role="alert">
            {errorMessage}
          </p>
        ) : null}
        <button className="login-submit" type="submit" disabled={loading}>
          {loading ? 'Adding…' : 'Add work area'}
        </button>
      </form>
    </>
  );
}
