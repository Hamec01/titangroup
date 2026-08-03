'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { SiteDetail } from '@/lib/sites';

const CSRF_HEADER_VALUE = 'titanor-time';

interface CityOption {
  id: string;
  name: string;
}

export function SiteEditForm({ site }: { site: SiteDetail }) {
  const router = useRouter();
  const [cities, setCities] = useState<CityOption[]>([]);
  const [name, setName] = useState(site.name);
  const [cityId, setCityId] = useState(site.cityId ?? '');
  const [address, setAddress] = useState(site.address ?? '');
  const [description, setDescription] = useState(site.description ?? '');
  const [active, setActive] = useState(site.active);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/cities', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((body: { items?: CityOption[] }) => {
        if (!cancelled) {
          setCities(body.items ?? []);
        }
      })
      .catch(() => {
        // City list is a convenience — a failed fetch just leaves the dropdown empty.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading) {
      return;
    }
    setErrorMessage(null);
    setLoading(true);

    try {
      const response = await fetch(`/api/admin/sites/${site.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({
          version: site.version,
          name,
          cityId: cityId || null,
          address: address || null,
          description: description || null,
          active
        })
      });

      if (!response.ok) {
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
          case 'VERSION_CONFLICT':
            setErrorMessage('This site was changed elsewhere — reloading.');
            router.refresh();
            break;
          case 'FORBIDDEN':
            setErrorMessage('You no longer have permission to edit sites.');
            break;
          default:
            setErrorMessage('Something went wrong. Please try again.');
        }
        setLoading(false);
        return;
      }

      router.refresh();
      setLoading(false);
    } catch {
      setErrorMessage('Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <>
      <h2>Edit</h2>
      <form onSubmit={handleSubmit} aria-busy={loading}>
        <div className="login-field">
          <label htmlFor="site-edit-name">Name</label>
          <input
            id="site-edit-name"
            type="text"
            required
            disabled={loading}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="login-field">
          <label htmlFor="site-edit-city">City</label>
          <select id="site-edit-city" disabled={loading} value={cityId} onChange={(event) => setCityId(event.target.value)}>
            <option value="">No city</option>
            {cities.map((city) => (
              <option key={city.id} value={city.id}>
                {city.name}
              </option>
            ))}
          </select>
        </div>
        <div className="login-field">
          <label htmlFor="site-edit-address">Address</label>
          <input
            id="site-edit-address"
            type="text"
            disabled={loading}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </div>
        <div className="login-field">
          <label htmlFor="site-edit-description">Description</label>
          <textarea
            id="site-edit-description"
            rows={3}
            disabled={loading}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div className="login-field">
          <label htmlFor="site-edit-active">
            <input
              id="site-edit-active"
              type="checkbox"
              disabled={loading}
              checked={active}
              onChange={(event) => setActive(event.target.checked)}
            />{' '}
            Active (uncheck to close this site)
          </label>
        </div>
        {errorMessage ? (
          <p className="login-error" role="alert">
            {errorMessage}
          </p>
        ) : null}
        <button className="login-submit" type="submit" disabled={loading}>
          {loading ? 'Saving…' : 'Save changes'}
        </button>
      </form>
    </>
  );
}
