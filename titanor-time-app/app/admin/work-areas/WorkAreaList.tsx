'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';

interface WorkAreaItem {
  id: string;
  name: string;
  active: boolean;
  version: number;
  site: { id: string; name: string };
}

export function WorkAreaList({ workAreas, canManage }: { workAreas: WorkAreaItem[]; canManage: boolean }) {
  const router = useRouter();
  const locale = useAppLocale();
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function toggleActive(area: WorkAreaItem): Promise<void> {
    if (updatingId) return;
    if (area.active && !window.confirm(localeText(locale, `Deactivate work area “${area.name}”? Existing assignments and time history will be kept.`, `Отключить рабочую зону «${area.name}»? Существующие назначения и история времени сохранятся.`))) {
      return;
    }

    setUpdatingId(area.id);
    setErrorMessage(null);
    try {
      const response = await fetch(`/api/admin/sites/${area.site.id}/work-areas/${area.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'titanor-time' },
        body: JSON.stringify({ version: area.version, active: !area.active })
      });
      if (response.ok) {
        router.refresh();
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      setErrorMessage(body?.error?.code === 'VERSION_CONFLICT'
        ? localeText(locale, 'This work area changed elsewhere — reload and try again.', 'Рабочая зона изменена в другом окне — обновите страницу и повторите.')
        : localeText(locale, 'The work area could not be updated. Please try again.', 'Не удалось изменить рабочую зону. Повторите попытку.'));
      if (body?.error?.code === 'VERSION_CONFLICT') router.refresh();
    } catch {
      setErrorMessage(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Повторите попытку.'));
    } finally {
      setUpdatingId(null);
    }
  }

  if (workAreas.length === 0) {
    return <p>{localeText(locale, 'No work areas yet. Add one from a site page.', 'Рабочих зон пока нет. Добавьте зону на странице объекта.')}</p>;
  }

  return (
    <>
      {errorMessage ? <p className="login-error" role="alert">{errorMessage}</p> : null}
      <div className="worker-table-scroll">
        <table className="worker-table">
          <thead>
            <tr>
              <th>{localeText(locale, 'Work area', 'Рабочая зона')}</th>
              <th>{localeText(locale, 'Site', 'Объект')}</th>
              <th>{localeText(locale, 'Status', 'Статус')}</th>
              <th aria-label={localeText(locale, 'Actions', 'Действия')} />
            </tr>
          </thead>
          <tbody>
            {workAreas.map((area) => (
              <tr key={area.id}>
                <td>{area.name}</td>
                <td><Link href={`/admin/sites/${area.site.id}`}>{area.site.name}</Link></td>
                <td>{area.active ? localeText(locale, 'Active', 'Активна') : localeText(locale, 'Inactive', 'Неактивна')}</td>
                <td>
                  {canManage ? <button type="button" className="setup-action" disabled={updatingId !== null} onClick={() => void toggleActive(area)}>{updatingId === area.id ? localeText(locale, 'Saving…', 'Сохранение…') : area.active ? localeText(locale, 'Deactivate', 'Отключить') : localeText(locale, 'Activate', 'Активировать')}</button> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}