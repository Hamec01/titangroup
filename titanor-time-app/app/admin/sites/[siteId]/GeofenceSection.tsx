'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { GeofenceHistoryResult } from '@/lib/geofences';
import { GeofenceMapPicker } from './GeofenceMapPicker';
import type { AddressSearchResult } from '@/lib/site-geocoding';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText, type AppLocale } from '@/lib/i18n/locale';

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

function genericErrorMessageFor(locale: AppLocale, code: string | undefined): string {
  switch (code) {
    case 'VALIDATION_ERROR':
      return localeText(locale, 'Please check the fields below.', 'Проверьте поля ниже.');
    case 'FORBIDDEN':
      return localeText(locale, 'You no longer have permission to manage this site’s geofence.', 'У вас больше нет права управлять геозоной этого объекта.');
    case 'IDEMPOTENCY_KEY_IN_PROGRESS':
      return localeText(locale, 'A previous save for this site is still being processed — please wait a moment and try again.', 'Предыдущее сохранение ещё обрабатывается — немного подождите и повторите.');
    case 'IDEMPOTENCY_KEY_REUSED':
      return localeText(locale, 'That save could not be completed as a new request — please try again.', 'Не удалось выполнить сохранение как новый запрос — повторите.');
    case 'SITE_NOT_FOUND':
      return localeText(locale, 'This site no longer exists.', 'Этого объекта больше нет.');
    default:
      return localeText(locale, 'Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.');
  }
}

/**
 * docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §16 "Geofence admin" — this section manages
 * the site's configured center/radius via an optional MapLibre picker and GET/POST
 * /api/admin/sites/:siteId/geofence-versions. `history` is fetched server-side (SiteDetailPage)
 * and refreshed via `router.refresh()` after a successful save — no client-side GET.
 */
export function GeofenceSection({ siteId, history, siteAddress }: { siteId: string; history: GeofenceHistoryResult; siteAddress: string | null }) {
  const router = useRouter();
  const locale = useAppLocale();
  const { current, items } = history;

  const [latitude, setLatitude] = useState(current?.latitude ?? '');
  const [longitude, setLongitude] = useState(current?.longitude ?? '');
  const [radiusMeters, setRadiusMeters] = useState(current ? String(current.radiusMeters) : String(DEFAULT_RADIUS_METERS));
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [address, setAddress] = useState(siteAddress ?? '');
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

  // One-shot, mount-only auto-suggestion: a site that has never had a geofence version yet (no
  // "current") gets its pin pre-filled by geocoding its stored address, so the admin isn't forced
  // to retype the same address into "Find address" below. This never runs again once the site
  // already has a geofence version — an admin editing the address on an already-located site must
  // never have its live geofence silently moved out from under active workers.
  const autoGeocodeRanRef = useRef(false);
  useEffect(() => {
    if (autoGeocodeRanRef.current || current) {
      return;
    }
    const trimmed = (siteAddress ?? '').trim();
    if (trimmed.length < 3) {
      return;
    }
    autoGeocodeRanRef.current = true;

    void (async () => {
      try {
        const response = await fetch(`/api/admin/geocoding/search?q=${encodeURIComponent(trimmed)}`, { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) {
          return;
        }
        const body = (await response.json().catch(() => null)) as { items?: AddressSearchResult[] } | null;
        const top = body?.items?.[0];
        if (!top) {
          return;
        }
        // Only apply if the admin hasn't already placed a pin themselves while this was in flight.
        setLatitude((prev) => (prev === '' ? top.latitude : prev));
        setLongitude((prev) => (prev === '' ? top.longitude : prev));
        setAddressMessage((prev) => (prev !== null ? prev : localeText(locale, 'Location suggested from the site address. Check the marker and radius, then save.', 'Точка подобрана по адресу объекта. Проверьте маркер и радиус, затем сохраните.')));
      } catch {
        // Silent — the admin can still search or click the map manually.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        setErrorMessage(genericErrorMessageFor(locale, code));
        setLoading(false);
        return;
      }

      router.refresh();
      setLoading(false);
    } catch {
      setErrorMessage(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
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
        setAddressMessage(body?.error?.code === 'RATE_LIMITED'
          ? localeText(locale, 'Search is busy. Wait a second and try again.', 'Поиск занят. Подождите секунду и повторите.')
          : localeText(locale, 'Address search is temporarily unavailable. You can still click the map.', 'Поиск адреса временно недоступен. Можно выбрать точку на карте.'));
      } else {
        const items = body?.items ?? [];
        setAddressResults(items);
        if (!items.length) setAddressMessage(localeText(locale, 'No matching address found. Refine the search or click the map.', 'Подходящий адрес не найден. Уточните запрос или выберите точку на карте.'));
      }
    } catch {
      setAddressMessage(localeText(locale, 'Network error while searching. You can still click the map.', 'Ошибка сети при поиске. Можно выбрать точку на карте.'));
    } finally {
      setAddressLoading(false);
    }
  }

  return (
    <>
      <h2>{localeText(locale, 'Geofence', 'Геозона')}</h2>

      {current ? (
        <div className="setup-item setup-item-column">
          <span className="setup-label">
            {localeText(locale, 'Version', 'Версия')} {current.versionNumber} — {current.latitude}, {current.longitude} — {localeText(locale, 'radius', 'радиус')} {current.radiusMeters} {localeText(locale, 'm', 'м')}
          </span>
          <span className="setup-subtitle">
            {localeText(locale, 'Created', 'Создано')} {new Date(current.createdAt).toLocaleString(locale === 'RU' ? 'ru-RU' : 'en-GB')} · {current.createdByUsername}
          </span>
        </div>
      ) : (
        <p>{localeText(locale, 'Geofence not configured.', 'Геозона не настроена.')}</p>
      )}

      {items.length > 0 ? (
        <>
          <h3>{localeText(locale, 'Version history', 'История версий')}</h3>
          <ul className="setup-list">
            {items.map((version) => (
              <li key={version.id} className="setup-item">
                <span className="setup-label">
                  v{version.versionNumber} — {version.latitude}, {version.longitude} — {version.radiusMeters} {localeText(locale, 'm', 'м')} —{' '}
                  {new Date(version.createdAt).toLocaleString(locale === 'RU' ? 'ru-RU' : 'en-GB')} · {version.createdByUsername}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <form onSubmit={searchAddress} className="geofence-address-search">
        <div className="login-field">
          <label htmlFor="geofence-address">{localeText(locale, 'Find address', 'Найти адрес')}</label>
          <input id="geofence-address" type="search" minLength={3} maxLength={200} value={address} disabled={loading || addressLoading} onChange={(event) => setAddress(event.target.value)} placeholder={localeText(locale, 'Street, city, Finland', 'Улица, город, Финляндия')} />
        </div>
        <button type="submit" className="secondary-button" disabled={loading || addressLoading || address.trim().length < 3}>{addressLoading ? localeText(locale, 'Searching…', 'Поиск…') : localeText(locale, 'Search address', 'Найти адрес')}</button>
        <p className="setup-subtitle">{localeText(locale, 'Search runs only when you press the button. Results © OpenStreetMap contributors.', 'Поиск выполняется только после нажатия кнопки. Результаты © участники OpenStreetMap.')}</p>
        {addressMessage ? <p role="status" className="form-status">{addressMessage}</p> : null}
        {addressResults.length ? (
          <ul className="setup-list geofence-search-results">
            {addressResults.map((result) => (
              <li key={`${result.latitude}:${result.longitude}`} className="setup-item">
                <button type="button" className="geofence-result-button" onClick={() => { setLatitude(result.latitude); setLongitude(result.longitude); setAddressResults([]); setAddressMessage(localeText(locale, 'Location selected. Check the marker and radius, then save.', 'Место выбрано. Проверьте маркер и радиус, затем сохраните.')); }}>{result.displayName}</button>
              </li>
            ))}
          </ul>
        ) : null}
      </form>

      <GeofenceMapPicker latitude={latitude} longitude={longitude} radiusMeters={radiusMeters} disabled={loading} onCoordinates={(nextLatitude, nextLongitude) => { setLatitude(nextLatitude); setLongitude(nextLongitude); }} />

      <form onSubmit={handleSubmit} aria-busy={loading}>
        <div className="login-field">
          <label htmlFor="geofence-latitude">{localeText(locale, 'Latitude', 'Широта')}</label>
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
          <label htmlFor="geofence-longitude">{localeText(locale, 'Longitude', 'Долгота')}</label>
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
          <label htmlFor="geofence-radius">{localeText(locale, 'Radius (meters)', 'Радиус (метры)')}</label>
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
        <p className="setup-subtitle">{localeText(locale, 'Saving creates a new, immutable geofence version — existing versions are never changed.', 'Сохранение создаёт новую неизменяемую версию геозоны — старые версии не изменяются.')}</p>
        {errorMessage ? (
          <p className="login-error" role="alert">
            {errorMessage}
          </p>
        ) : null}
        <button className="login-submit" type="submit" disabled={loading}>
          {loading ? localeText(locale, 'Saving…', 'Сохранение…') : current ? localeText(locale, 'Create new geofence version', 'Создать новую версию геозоны') : localeText(locale, 'Set geofence', 'Настроить геозону')}
        </button>
      </form>
    </>
  );
}
