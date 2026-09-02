'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { SiteWorkArea } from '@/lib/sites';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText, type AppLocale } from '@/lib/i18n/locale';

const CSRF_HEADER_VALUE = 'titanor-time';

async function parseErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    return body.error?.code;
  } catch {
    return undefined;
  }
}

function errorMessageFor(locale: AppLocale, code: string | undefined): string {
  switch (code) {
    case 'VALIDATION_ERROR':
      return localeText(locale, 'Please check the name.', 'Проверьте название.');
    case 'DUPLICATE_WORK_AREA_NAME':
      return localeText(locale, 'A customer with this name already exists on this site.', 'Заказчик с таким названием уже есть на объекте.');
    case 'VERSION_CONFLICT':
      return localeText(locale, 'This customer was changed elsewhere — reloading.', 'Заказчик изменён в другом окне — обновляем страницу.');
    case 'FORBIDDEN':
      return localeText(locale, 'You no longer have permission to manage customers.', 'У вас больше нет права управлять заказчиками.');
    default:
      return localeText(locale, 'Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.');
  }
}

function ToggleActiveButton({ siteId, area, disabled }: { siteId: string; area: SiteWorkArea; disabled: boolean }) {
  const router = useRouter();
  const locale = useAppLocale();
  const [loading, setLoading] = useState(false);

  async function handleClick(): Promise<void> {
    if (loading || disabled) {
      return;
    }
    if (area.active && !window.confirm(localeText(locale, `Deactivate customer “${area.name}”? Existing assignments and time history will be kept.`, `Отключить заказчика «${area.name}»? Существующие назначения и история времени сохранятся.`))) {
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/sites/${siteId}/work-areas/${area.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ version: area.version, active: !area.active })
      });
      if (!response.ok) {
        const code = await parseErrorCode(response);
        window.alert(errorMessageFor(locale, code));
        if (code === 'VERSION_CONFLICT') {
          router.refresh();
        }
        setLoading(false);
        return;
      }
      router.refresh();
    } catch {
      window.alert(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
      setLoading(false);
    }
  }

  return (
    <button type="button" className="setup-action" onClick={handleClick} disabled={loading || disabled}>
      {area.active ? localeText(locale, 'Deactivate', 'Отключить') : localeText(locale, 'Activate', 'Активировать')}
    </button>
  );
}

export function WorkAreaSection({ siteId, workAreas }: { siteId: string; workAreas: SiteWorkArea[] }) {
  const router = useRouter();
  const locale = useAppLocale();
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading) {
      return;
    }
    setErrorMessage(null);
    setLoading(true);

    try {
      const response = await fetch(`/api/admin/sites/${siteId}/work-areas`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify({ name })
      });

      if (!response.ok) {
        const code = await parseErrorCode(response);
        setErrorMessage(errorMessageFor(locale, code));
        setLoading(false);
        return;
      }

      setName('');
      router.refresh();
      setLoading(false);
    } catch {
      setErrorMessage(localeText(locale, 'Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
      setLoading(false);
    }
  }

  return (
    <>
      <h2>{localeText(locale, 'Customers', 'Заказчики')}</h2>
      <p className="setup-subtitle">
        {localeText(
          locale,
          'Different customers on the same site (e.g. two shipyard contracts). Optional when assigning a worker.',
          'Разные заказчики на одном объекте (например, два контракта на верфи). При назначении работника — необязательно.'
        )}
      </p>
      {workAreas.length === 0 ? (
        <p>{localeText(locale, 'None yet.', 'Пока нет.')}</p>
      ) : (
        <ul className="setup-list">
          {workAreas.map((area) => (
            <li key={area.id} className="setup-item">
              <span className="setup-label">
                <Link href={`/admin/work-areas/${area.id}`}>{area.name}</Link>
                {!area.active ? localeText(locale, ' (inactive)', ' (неактивен)') : ''}
              </span>
              <ToggleActiveButton siteId={siteId} area={area} disabled={loading} />
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleCreate} aria-busy={loading}>
        <div className="login-field">
          <label htmlFor="work-area-name">{localeText(locale, 'New customer name', 'Название нового заказчика')}</label>
          <input
            id="work-area-name"
            type="text"
            required
            disabled={loading}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        {errorMessage ? (
          <p className="login-error" role="alert">
            {errorMessage}
          </p>
        ) : null}
        <button className="login-submit" type="submit" disabled={loading}>
          {loading ? localeText(locale, 'Adding…', 'Добавление…') : localeText(locale, 'Add customer', 'Добавить заказчика')}
        </button>
      </form>
    </>
  );
}
