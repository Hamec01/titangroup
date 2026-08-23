'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';

interface CityItem {
  id: string;
  name: string;
  siteCount: number;
}

export function CityList({ cities, canDelete }: { cities: CityItem[]; canDelete: boolean }) {
  const router = useRouter();
  const locale = useAppLocale();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function deleteCity(city: CityItem): Promise<void> {
    if (!window.confirm(localeText(locale, `Delete city “${city.name}”? This cannot be undone.`, `Удалить город «${city.name}»? Это действие нельзя отменить.`))) {
      return;
    }

    setDeletingId(city.id);
    setErrorMessage(null);
    try {
      const response = await fetch(`/api/admin/cities/${city.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'titanor-time' }
      });
      if (response.ok) {
        router.refresh();
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      if (body?.error?.code === 'CITY_IN_USE') {
        setErrorMessage(localeText(locale, 'This city is used by one or more sites and cannot be deleted.', 'Этот город используется одним или несколькими объектами и не может быть удалён.'));
      } else if (body?.error?.code === 'FORBIDDEN') {
        setErrorMessage(localeText(locale, 'You no longer have permission to delete cities.', 'У вас больше нет права удалять города.'));
      } else {
        setErrorMessage(localeText(locale, 'The city could not be deleted. Please try again.', 'Не удалось удалить город. Повторите попытку.'));
      }
    } catch {
      setErrorMessage(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Повторите попытку.'));
    } finally {
      setDeletingId(null);
    }
  }

  if (cities.length === 0) {
    return <p>{localeText(locale, 'No cities yet.', 'Городов пока нет.')}</p>;
  }

  return (
    <>
      {errorMessage ? <p className="login-error" role="alert">{errorMessage}</p> : null}
      <table className="worker-table">
        <thead>
          <tr>
            <th>{localeText(locale, 'City', 'Город')}</th>
            <th>{localeText(locale, 'Sites', 'Объекты')}</th>
            <th aria-label={localeText(locale, 'Actions', 'Действия')} />
          </tr>
        </thead>
        <tbody>
          {cities.map((city) => (
            <tr key={city.id}>
              <td>{city.name}</td>
              <td>{city.siteCount}</td>
              <td>
                {canDelete ? (
                  <button type="button" className="setup-action" disabled={deletingId !== null || city.siteCount > 0} onClick={() => void deleteCity(city)}>
                    {deletingId === city.id ? localeText(locale, 'Deleting…', 'Удаление…') : localeText(locale, 'Delete', 'Удалить')}
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}