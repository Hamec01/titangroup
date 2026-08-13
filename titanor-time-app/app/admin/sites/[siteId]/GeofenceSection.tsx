'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { GeofenceHistoryResult } from '@/lib/geofences';

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
 * docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §16 "Geofence admin" — no map SDK, no
 * Haversine/GPS evaluation here (server-only concern for a later slice): this section only
 * manages the site's own configured center/radius via GET/POST
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
