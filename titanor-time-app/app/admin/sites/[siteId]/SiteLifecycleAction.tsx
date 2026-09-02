'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';

const CSRF_HEADER_VALUE = 'titanor-time';

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §3 — a prominent "this site is finished" /
// "reopen" action, mirroring the worker deactivate/reactivate pattern. It is just
// PATCH /api/admin/sites/:id { version, active } under the hood (a partial update — WorkSite has
// no delete path: geofences, assignments and worked hours reference it). A finished site is
// hidden from the site list and from the assignment pickers by default.
export function SiteLifecycleAction({ site }: { site: { id: string; name: string; active: boolean; version: number } }) {
  const router = useRouter();
  const locale = useAppLocale();
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function toggle(): Promise<void> {
    if (loading) {
      return;
    }
    if (
      site.active &&
      !window.confirm(
        localeText(
          locale,
          `Mark the site “${site.name}” as finished? Its history and assignments are kept, and it is hidden from the site list and from the picker when assigning workers. You can reopen it.`,
          `Отметить объект «${site.name}» как завершённый? История и назначения сохранятся, объект скроется из списка и из выбора при назначении работников. Можно восстановить.`
        )
      )
    ) {
      return;
    }
    setErrorMessage(null);
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/sites/${site.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ version: site.version, active: !site.active })
      });
      if (response.ok) {
        router.refresh();
        setLoading(false);
        return;
      }
      let code: string | undefined;
      try {
        const body = (await response.json()) as { error?: { code?: string } };
        code = body.error?.code;
      } catch {
        // fall through to the generic message
      }
      if (code === 'VERSION_CONFLICT') {
        setErrorMessage(localeText(locale, 'This site was changed elsewhere — reloading.', 'Объект изменён в другом окне — обновляем страницу.'));
        router.refresh();
      } else if (code === 'FORBIDDEN') {
        setErrorMessage(localeText(locale, 'You no longer have permission to change sites.', 'У вас больше нет права изменять объекты.'));
      } else {
        setErrorMessage(localeText(locale, 'Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.'));
      }
      setLoading(false);
    } catch {
      setErrorMessage(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
      setLoading(false);
    }
  }

  return (
    <section className="worker-work-setup" aria-label={localeText(locale, 'Site status', 'Статус объекта')}>
      <h2>{localeText(locale, 'Site status', 'Статус объекта')}</h2>
      {site.active ? (
        <p className="setup-subtitle">
          {localeText(
            locale,
            'When the project is over, mark the site as finished — nothing is deleted, it just stops cluttering the lists and the assignment picker.',
            'Когда проект закончен, отметьте объект как завершённый — ничего не удаляется, объект просто перестаёт мешать в списках и в выборе при назначении.'
          )}
        </p>
      ) : (
        <p className="setup-subtitle">
          {localeText(locale, 'This site is finished — hidden from the lists and the picker. Reopen it to use it again.', 'Объект завершён — скрыт из списков и из выбора. Восстановите, чтобы снова им пользоваться.')}
        </p>
      )}
      {errorMessage ? (
        <p className="login-error" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <button type="button" className="setup-action" disabled={loading} onClick={toggle}>
        {loading
          ? localeText(locale, 'Saving…', 'Сохраняем…')
          : site.active
            ? localeText(locale, 'Mark site as finished', 'Объект завершён')
            : localeText(locale, 'Reopen site', 'Восстановить объект')}
      </button>
    </section>
  );
}
