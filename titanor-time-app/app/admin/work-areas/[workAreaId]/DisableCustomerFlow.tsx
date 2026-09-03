'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';

const CSRF = 'titanor-time';

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §3.9 — disabling a customer that still has
// assigned / scheduled workers is never silent. Read-only preflight → the admin makes ONE explicit
// decision for all of them: leave each worker on the SITE with no customer, or remove each from the
// site. Moving them to another customer of the same site is the Deploy E group transfer.

interface AffectedWorker {
  employeeId: string;
  assignmentId: string;
  name: string;
  employeeNumber: string;
  isPrimary: boolean;
  workingNow: boolean;
  future: boolean;
}
interface Preview {
  customerName: string;
  siteId: string;
  assignedCount: number;
  workingNowCount: number;
  futureAssignmentsCount: number;
  workers: AffectedWorker[];
  futureWorkers: AffectedWorker[];
  otherActiveCustomers: { id: string; name: string }[];
}

type Decision = 'LEAVE_ON_SITE_NO_CUSTOMER' | 'REMOVE_WORKERS';

export function DisableCustomerFlow({
  workArea
}: {
  workArea: { id: string; siteId: string; name: string; active: boolean };
}) {
  const router = useRouter();
  const locale = useAppLocale();
  const ru = locale === 'RU';
  const t = (en: string, r: string) => localeText(locale, en, r);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [decision, setDecision] = useState<Decision>('LEAVE_ON_SITE_NO_CUSTOMER');

  const base = `/api/admin/sites/${workArea.siteId}/work-areas/${workArea.id}`;

  async function loadPreview(): Promise<void> {
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${base}/disable`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error();
      setPreview((await res.json()) as Preview);
    } catch {
      setError(t('Could not load the customer details. Try again.', 'Не удалось загрузить данные заказчика. Попробуйте ещё раз.'));
    } finally {
      setLoading(false);
    }
  }

  async function disable(withDecision: boolean): Promise<void> {
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${base}/disable`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF },
        body: JSON.stringify(withDecision ? { decision } : {})
      });
      if (res.ok) {
        setPreview(null);
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; preview?: Preview } };
      const code = body.error?.code;
      if (code === 'DECISION_REQUIRED' && body.error?.preview) {
        setPreview(body.error.preview);
        setError(t('This customer has assigned workers — choose what happens to them.', 'У заказчика есть назначенные работники — выберите, что с ними будет.'));
      } else {
        setError(
          code === 'ALREADY_DISABLED'
            ? t('This customer is already disabled — reloading.', 'Заказчик уже отключён — обновляем страницу.')
            : t('Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.')
        );
        if (code === 'ALREADY_DISABLED') router.refresh();
      }
    } catch {
      setError(t('Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
    } finally {
      setLoading(false);
    }
  }

  async function enable(): Promise<void> {
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${base}/enable`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF },
        body: '{}'
      });
      if (res.ok) {
        router.refresh();
        return;
      }
      const code = (((await res.json().catch(() => ({}))) as { error?: { code?: string } }).error ?? {}).code;
      setError(
        code === 'SITE_FINISHED'
          ? t('The site is finished — reopen it first.', 'Объект завершён — сначала восстановите его.')
          : t('Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.')
      );
    } catch {
      setError(t('Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
    } finally {
      setLoading(false);
    }
  }

  if (!workArea.active) {
    return (
      <>
        {error ? <p className="login-error" role="alert">{error}</p> : null}
        <button type="button" className="setup-action" disabled={loading} onClick={enable}>
          {loading ? t('Saving…', 'Сохраняем…') : t('Reactivate customer', 'Включить заказчика')}
        </button>
      </>
    );
  }

  const affected = preview ? [...preview.workers, ...preview.futureWorkers] : [];

  return (
    <>
      {error ? <p className="login-error" role="alert">{error}</p> : null}

      {!preview ? (
        <button type="button" className="setup-action" disabled={loading} onClick={loadPreview}>
          {loading ? t('Loading…', 'Загрузка…') : t('Disable customer…', 'Отключить заказчика…')}
        </button>
      ) : affected.length === 0 ? (
        <div className="activation-print-card">
          <p>{t('No worker is assigned to this customer. It will just disappear from the assignment picker.', 'На заказчика никто не назначен. Он просто пропадёт из выбора при назначении.')}</p>
          <div className="activation-actions">
            <button type="button" className="setup-action" disabled={loading} onClick={() => disable(false)}>
              {loading ? t('Disabling…', 'Отключаем…') : t('Disable customer', 'Отключить заказчика')}
            </button>
            <button type="button" className="login-submit" disabled={loading} onClick={() => setPreview(null)}>
              {t('Cancel', 'Отмена')}
            </button>
          </div>
        </div>
      ) : (
        <div className="activation-print-card">
          <p>
            <strong>{t('Assigned to this customer:', 'Назначено на заказчика:')}</strong>{' '}
            {t(
              `${preview.assignedCount} now · ${preview.workingNowCount} working · ${preview.futureAssignmentsCount} future`,
              `${preview.assignedCount} сейчас · ${preview.workingNowCount} на смене · ${preview.futureAssignmentsCount} будущих`
            )}
          </p>
          <ul className="setup-subtitle">
            {affected.map((w) => (
              <li key={w.assignmentId}>
                <Link href={`/admin/workers/${w.employeeId}`}>
                  {w.name} #{w.employeeNumber}
                </Link>
                {w.isPrimary ? ` · ${t('main workplace', 'основное место')}` : ''}
                {w.workingNow ? ` · ${t('working now', 'сейчас на смене')}` : ''}
                {w.future ? ` · ${t('starts later', 'начнётся позже')}` : ''}
              </li>
            ))}
          </ul>

          <fieldset className="worker-work-setup">
            <legend>{t('What happens to these workers?', 'Что будет с этими работниками?')}</legend>
            <label>
              <input
                type="radio"
                name="disable-decision"
                checked={decision === 'LEAVE_ON_SITE_NO_CUSTOMER'}
                onChange={() => setDecision('LEAVE_ON_SITE_NO_CUSTOMER')}
              />{' '}
              {t('Leave each worker on the site, with no customer', 'Оставить каждого на объекте, без заказчика')}
            </label>
            <br />
            <label>
              <input
                type="radio"
                name="disable-decision"
                checked={decision === 'REMOVE_WORKERS'}
                onChange={() => setDecision('REMOVE_WORKERS')}
              />{' '}
              {t('Remove each worker from the site', 'Снять каждого с объекта')}
            </label>
            {preview.otherActiveCustomers.length > 0 ? (
              <p className="setup-subtitle">
                {t('To move them to another customer of this site, use ', 'Чтобы перевести их на другого заказчика этого объекта — используйте ')}
                <Link href={`/admin/sites/${preview.siteId}`}>{t('Group transfer on the site page', '«Групповой перевод» на странице объекта')}</Link>
                {t(' first, then disable this customer.', ', затем отключите этого заказчика.')}
              </p>
            ) : null}
          </fieldset>

          <div className="activation-actions">
            <button type="button" className="setup-action" disabled={loading} onClick={() => disable(true)}>
              {loading ? t('Disabling…', 'Отключаем…') : t('Disable customer', 'Отключить заказчика')}
            </button>
            <button type="button" className="login-submit" disabled={loading} onClick={() => setPreview(null)}>
              {t('Cancel', 'Отмена')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
