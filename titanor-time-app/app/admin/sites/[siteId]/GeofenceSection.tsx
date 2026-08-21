'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { GeofenceHistoryResult } from '@/lib/geofences';
import { GeofenceMapPicker } from './GeofenceMapPicker';
import type { AddressSearchResult } from '@/lib/site-geocoding';

const CSRF_HEADER_VALUE = 'titanor-time';
// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §5.1 — pilot default radius for a site's
// first geofence version.
const DEFAULT_RADIUS_METERS = 150;

async function parseErrorBody(response: Response): Promise<{ code?: string; fieldErrors?: Record<string, string[]> }> {
  try {
    const body = (await response.json()) as { error?: { code?: string; fieldErrors?: Record<string, string[]> } };
    return { code: body.error?.code, fieldErrors: body.error?.fieldErrors };
  } catch {
    return {};
  }
}

function genericErrorMessageFor(code: string | undefined): string {
  switch (code) {
    case 'VALIDATION_ERROR':
      return 'Please check the fields below.';
    case 'FORBIDDEN':
      return 'You no longer have permission to manage this site’s geofence.';
    case 'IDEMPOTENCY_KEY_IN_PROGRESS':
      return 'A previous save for this site is still being processed — please wait a moment and try again.';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'That save could not be completed as a new request — please try again.';
    case 'SITE_NOT_FOUND':
      return 'This site no longer exists.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

/**
 * docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §16 "Geofence admin" — this section manages
 * the site's configured center/radius via an optional MapLibre picker and GET/POST
 * /api/admin/sites/:siteId/geofence-versions. `history` is fetched server-side (SiteDetailPage)
 * and refreshed via `router.refresh()` after a successful save — no client-side GET.
 */
export function GeofenceSection({ siteId, history }: { siteId: string; history: GeofenceHistoryResult }) {
  const router = useRouter();
  const { current, items } = history;

  const [latitude, setLatitude] = useState(current?.latitude ?? '');
  const [longitude, setLongitude] = useState(current?.longitude ?? '');
  const [radiusMeters, setRadiusMeters] = useState(current ? String(current.radiusMeters) : String(DEFAULT_RADIUS_METERS));
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [address, setAddress] = useState('');
  const [addressLoading, setAddressLoading] = useState(false);
  const [addressMessage, setAddressMessage] = useState<string | null>(null);
  const [addressResults, setAddressResults] = useState<AddressSearchResult[]>([]);

  // Prefill with the (possibly newly refreshed) current version's values — runs again after a
  // successful create switches `current` to the just-created version.
  useEffect(() => {
    setLatitude(current?.latitude ?? '');
    setLongitude(current?.longitude ?? '');
    setRadiusMeters(current ? String(current.radiusMeters) : String(DEFAULT_RADIUS_METERS));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading) {
      return;
    }
    setErrorMessage(null);
    setFieldErrors({});
    setLoading(true);

    try {
      const response = await fetch(`/api/admin/sites/${siteId}/geofence-versions`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': CSRF_HEADER_VALUE,
          'Idempotency-Key': crypto.randomUUID()
        },
        body: JSON.stringify({ latitude: Number(latitude), longitude: Number(longitude), radiusMeters: Number(radiusMeters) })
      });

      if (!response.ok) {
        const { code, fieldErrors: apiFieldErrors } = await parseErrorBody(response);
        setFieldErrors(apiFieldErrors ?? {});
        setErrorMessage(genericErrorMessageFor(code));
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

  async function searchAddress(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (addressLoading || address.trim().length < 3) return;
    setAddressLoading(true);
    setAddressMessage(null);
    setAddressResults([]);
    try {
      const response = await fetch(`/api/admin/geocoding/search?q=${encodeURIComponent(address.trim())}`, { credentials: 'same-origin', cache: 'no-store' });
      const body = await response.json().catch(() => null) as { items?: AddressSearchResult[]; error?: { code?: string } } | null;
      if (!response.ok) {
        setAddressMessage(body?.error?.code === 'RATE_LIMITED' ? 'Search is busy. Wait a second and try again.' : 'Address search is temporarily unavailable. You can still click the map.');
      } else {
        const items = body?.items ?? [];
        setAddressResults(items);
        if (!items.length) setAddressMessage('No matching address found. Refine the search or click the map.');
      }
    } catch {
      setAddressMessage('Network error while searching. You can still click the map.');
    } finally {
      setAddressLoading(false);
    }
  }

  return (
    <>
      <h2>Geofence</h2>

      {current ? (
        <div className="setup-item setup-item-column">
          <span className="setup-label">
            Version {current.versionNumber} — {current.latitude}, {current.longitude} — radius {current.radiusMeters} m
          </span>
          <span className="setup-subtitle">
            Created {new Date(current.createdAt).toLocaleString()} by {current.createdByUsername}
          </span>
        </div>
      ) : (
        <p>Geofence not configured.</p>
      )}

      {items.length > 0 ? (
        <>
          <h3>Version history</h3>
          <ul className="setup-list">
            {items.map((version) => (
              <li key={version.id} className="setup-item">
                <span className="setup-label">
                  v{version.versionNumber} — {version.latitude}, {version.longitude} — {version.radiusMeters} m —{' '}
                  {new Date(version.createdAt).toLocaleString()} by {version.createdByUsername}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <form onSubmit={searchAddress} className="geofence-address-search">
        <div className="login-field">
          <label htmlFor="geofence-address">Find address</label>
          <input id="geofence-address" type="search" minLength={3} maxLength={200} value={address} disabled={loading || addressLoading} onChange={(event) => setAddress(event.target.value)} placeholder="Street, city, Finland" />
        </div>
        <button type="submit" className="secondary-button" disabled={loading || addressLoading || address.trim().length < 3}>{addressLoading ? 'Searching…' : 'Search address'}</button>
        <p className="setup-subtitle">Search runs only when you press the button. Results © OpenStreetMap contributors.</p>
        {addressMessage ? <p role="status" className="form-status">{addressMessage}</p> : null}
        {addressResults.length ? (
          <ul className="setup-list geofence-search-results">
            {addressResults.map((result) => (
              <li key={`${result.latitude}:${result.longitude}`} className="setup-item">
                <button type="button" className="geofence-result-button" onClick={() => { setLatitude(result.latitude); setLongitude(result.longitude); setAddressResults([]); setAddressMessage('Location selected. Check the marker and radius, then save.'); }}>{result.displayName}</button>
              </li>
            ))}
          </ul>
        ) : null}
      </form>

      <GeofenceMapPicker latitude={latitude} longitude={longitude} radiusMeters={radiusMeters} disabled={loading} onCoordinates={(nextLatitude, nextLongitude) => { setLatitude(nextLatitude); setLongitude(nextLongitude); }} />

      <form onSubmit={handleSubmit} aria-busy={loading}>
        <div className="login-field">
          <label htmlFor="geofence-latitude">Latitude</label>
          <input
            id="geofence-latitude"
            type="number"
            // step="any" (not a fixed step) deliberately leaves native browser stepMismatch/
            // range validation out of the loop — every value the admin types must reach our own
            // submit handler and the server's validateGeofenceInput so out-of-range/excess-precision
            // input gets our fieldErrors message, not a generic native browser tooltip that blocks
            // submission silently.
            step="any"
            required
            disabled={loading}
            value={latitude}
            onChange={(event) => setLatitude(event.target.value)}
          />
          {fieldErrors.latitude ? <p className="field-error">{fieldErrors.latitude.join(', ')}</p> : null}
        </div>
        <div className="login-field">
          <label htmlFor="geofence-longitude">Longitude</label>
          <input
            id="geofence-longitude"
            type="number"
            step="any"
            required
            disabled={loading}
            value={longitude}
            onChange={(event) => setLongitude(event.target.value)}
          />
          {fieldErrors.longitude ? <p className="field-error">{fieldErrors.longitude.join(', ')}</p> : null}
        </div>
        <div className="login-field">
          <label htmlFor="geofence-radius">Radius (meters)</label>
          <input
            id="geofence-radius"
            type="number"
            step="any"
            required
            disabled={loading}
            value={radiusMeters}
            onChange={(event) => setRadiusMeters(event.target.value)}
          />
          {fieldErrors.radiusMeters ? <p className="field-error">{fieldErrors.radiusMeters.join(', ')}</p> : null}
        </div>
        <p className="setup-subtitle">Saving creates a new, immutable geofence version — existing versions are never changed.</p>
        {errorMessage ? (
          <p className="login-error" role="alert">
            {errorMessage}
          </p>
        ) : null}
        <button className="login-submit" type="submit" disabled={loading}>
          {loading ? 'Saving…' : current ? 'Create new geofence version' : 'Set geofence'}
        </button>
      </form>
    </>
  );
}
