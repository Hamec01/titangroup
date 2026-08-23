'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { TemplateDetail } from '@/lib/templates';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';

export function TemplateActivationAction({ template }: { template: TemplateDetail }) {
  const router = useRouter();
  const locale = useAppLocale();
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function updateActive(): Promise<void> {
    if (loading) return;
    if (template.active && !window.confirm(localeText(locale, `Deactivate template “${template.name}”? Existing assignments keep their recorded template version.`, `Отключить шаблон «${template.name}»? Существующие назначения сохранят свою записанную версию шаблона.`))) {
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await fetch(`/api/admin/templates/${template.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'titanor-time' },
        body: JSON.stringify({ expectedVersionNumber: template.currentVersionNumber, active: !template.active })
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
        setErrorMessage(body?.error?.code === 'VERSION_CONFLICT'
          ? localeText(locale, 'This template changed elsewhere — reloading.', 'Шаблон изменён в другом окне — обновляем страницу.')
          : localeText(locale, 'The template could not be updated. Please try again.', 'Не удалось изменить шаблон. Повторите попытку.'));
        if (body?.error?.code === 'VERSION_CONFLICT') router.refresh();
        return;
      }
      router.refresh();
    } catch {
      setErrorMessage(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Повторите попытку.'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="worker-work-setup">
      <h2>{localeText(locale, 'Availability', 'Доступность')}</h2>
      <p className="setup-subtitle">{template.active ? localeText(locale, 'This template is available for new assignments.', 'Этот шаблон доступен для новых назначений.') : localeText(locale, 'This template is unavailable for new assignments. Existing assignments remain unchanged.', 'Этот шаблон недоступен для новых назначений. Существующие назначения не меняются.')}</p>
      {errorMessage ? <p className="login-error" role="alert">{errorMessage}</p> : null}
      <button type="button" className="setup-action" disabled={loading} onClick={() => void updateActive()}>
        {loading ? localeText(locale, 'Saving…', 'Сохранение…') : template.active ? localeText(locale, 'Deactivate template', 'Отключить шаблон') : localeText(locale, 'Activate template', 'Активировать шаблон')}
      </button>
    </section>
  );
}