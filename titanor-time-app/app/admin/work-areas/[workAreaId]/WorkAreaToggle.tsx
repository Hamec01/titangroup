'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';

const CSRF_HEADER_VALUE = 'titanor-time';

// Deactivate / reactivate a customer from its own detail page — the same
// PATCH /api/admin/sites/:siteId/work-areas/:id { version, active } the customers list uses.
export function WorkAreaToggle({ workArea }: { workArea: { id: string; siteId: string; name: string; active: boolean; version: number } }) {
  const router = useRouter();
  const locale = useAppLocale();
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function toggle(): Promise<void> {
    if (loading) {
      return;
    }
    if (
      workArea.active &&
      !window.confirm(
        localeText(
          locale,
          `Deactivate customer “${workArea.name}”? Existing assignments and time history will be kept; it just can't be chosen for new assignments.`,
          `Отключить заказчика «${workArea.name}»? Существующие назначения и история времени сохранятся; его просто нельзя будет выбрать для новых назначений.`
        )
      )
    ) {
      return;
    }
    setErrorMessage(null);
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/sites/${workArea.siteId}/work-areas/${workArea.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ version: workArea.version, active: !workArea.active })
      });
      if (response.ok) {
        router.refresh();
        setLoading(false);
        return;
      }
      let code: string | undefined;
      try {
        code = ((await response.json()) as { error?: { code?: string } }).error?.code;
      } catch {
        // fall through
      }
      if (code === 'VERSION_CONFLICT') {
        setErrorMessage(localeText(locale, 'This customer changed elsewhere — reloading.', 'Заказчик изменён в другом окне — обновляем страницу.'));
        router.refresh();
      } else if (code === 'FORBIDDEN') {
        setErrorMessage(localeText(locale, 'You no longer have permission to manage customers.', 'У вас больше нет права управлять заказчиками.'));
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
    <>
      {errorMessage ? (
        <p className="login-error" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <button type="button" className="setup-action" disabled={loading} onClick={toggle}>
        {loading
          ? localeText(locale, 'Saving…', 'Сохранение…')
          : workArea.active
            ? localeText(locale, 'Deactivate customer', 'Отключить заказчика')
            : localeText(locale, 'Reactivate customer', 'Включить заказчика')}
      </button>
    </>
  );
}
