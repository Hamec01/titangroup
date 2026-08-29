'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { SiteDetail } from '@/lib/sites';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { adminDailyStrings } from '@/lib/i18n/admin-daily';
import { localeText } from '@/lib/i18n/locale';

const CSRF_HEADER_VALUE = 'titanor-time';

interface CityOption {
  id: string;
  name: string;
}

export function SiteEditForm({ site }: { site: SiteDetail }) {
  const router = useRouter();
  const locale = useAppLocale();
  const s = adminDailyStrings(locale);
  const [cities, setCities] = useState<CityOption[]>([]);
  const [name, setName] = useState(site.name);
  const [cityId, setCityId] = useState(site.cityId ?? '');
  const [address, setAddress] = useState(site.address ?? '');
  const [description, setDescription] = useState(site.description ?? '');
  const [active, setActive] = useState(site.active);
  const [gpsOftenUnavailable, setGpsOftenUnavailable] = useState(site.gpsOftenUnavailable);
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
    if (site.active && !active && !window.confirm(localeText(locale, `Close site “${site.name}”? Existing assignments and time history will be kept.`, `Закрыть объект «${site.name}»? Существующие назначения и история времени сохранятся.`))) {
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
          active,
          gpsOftenUnavailable
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
            setErrorMessage(localeText(locale, 'Please check the fields above.', 'Проверьте заполненные поля.'));
            break;
          case 'VERSION_CONFLICT':
            setErrorMessage(localeText(locale, 'This site was changed elsewhere — reloading.', 'Объект изменён в другом окне — обновляем страницу.'));
            router.refresh();
            break;
          case 'FORBIDDEN':
            setErrorMessage(localeText(locale, 'You no longer have permission to edit sites.', 'У вас больше нет права изменять объекты.'));
            break;
          default:
            setErrorMessage(localeText(locale, 'Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.'));
        }
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

  return (
    <>
      <h2>{localeText(locale, 'Edit', 'Редактирование')}</h2>
      <form onSubmit={handleSubmit} aria-busy={loading}>
        <div className="login-field">
          <label htmlFor="site-edit-name">{s.common.name}</label>
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
          <label htmlFor="site-edit-city">{localeText(locale, 'City', 'Город')}</label>
          <select id="site-edit-city" disabled={loading} value={cityId} onChange={(event) => setCityId(event.target.value)}>
            <option value="">{s.sites.noCity}</option>
            {cities.map((city) => (
              <option key={city.id} value={city.id}>
                {city.name}
              </option>
            ))}
          </select>
        </div>
        <div className="login-field">
          <label htmlFor="site-edit-address">{localeText(locale, 'Address', 'Адрес')}</label>
          <input
            id="site-edit-address"
            type="text"
            disabled={loading}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </div>
        <div className="login-field">
          <label htmlFor="site-edit-description">{localeText(locale, 'Description', 'Описание')}</label>
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
            {localeText(locale, 'Active (uncheck to close this site)', 'Активен (снимите флажок, чтобы закрыть объект)')}
          </label>
        </div>
        <div className="login-field">
          <label htmlFor="site-edit-gps-often-unavailable">
            <input
              id="site-edit-gps-often-unavailable"
              type="checkbox"
              disabled={loading}
              checked={gpsOftenUnavailable}
              onChange={(event) => setGpsOftenUnavailable(event.target.checked)}
            />{' '}
            {localeText(
              locale,
              'GPS is often unavailable here (auto-accept offline check-ins with no location — for ship hulls, covered halls)',
              'Здесь часто нет сигнала GPS (офлайн-отметки без координат принимаются автоматически — для корпусов судов, крытых цехов)'
            )}
          </label>
        </div>
        {errorMessage ? (
          <p className="login-error" role="alert">
            {errorMessage}
          </p>
        ) : null}
        <button className="login-submit" type="submit" disabled={loading}>
          {loading ? s.common.saving : localeText(locale, 'Save changes', 'Сохранить изменения')}
        </button>
      </form>
    </>
  );
}
