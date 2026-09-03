'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';

const CSRF = 'titanor-time';

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §3.8 — "Correctly finish a site". Replaces
// the old plain active toggle: a read-only preflight (who is assigned / working now / future /
// customers) → the ONE option "Finish after current shifts". Shows "Finishing — N still working"
// (with the stuck open shifts + a link to fix them) until the last worker checks out, then
// "Finished". Reopen never revives assignments.

interface AffectedWorker {
  employeeId: string;
  assignmentId: string;
  name: string;
  employeeNumber: string;
  workAreaName: string | null;
  isPrimary: boolean;
  workingNow: boolean;
  future: boolean;
}
interface Preview {
  siteName: string;
  assignedCount: number;
  workingNowCount: number;
  futureAssignmentsCount: number;
  customerCount: number;
  workers: AffectedWorker[];
  futureWorkers: AffectedWorker[];
  openShifts: { employeeId: string; name: string; openedAt: string }[];
}

interface SiteProp {
  id: string;
  name: string;
  finishingState: 'active' | 'finishing' | 'finished';
  finishedAt: string | null;
  stuckOpenShifts: { employeeId: string; employeeName: string; openedAt: string }[];
}

export function SiteFinishFlow({ site }: { site: SiteProp }) {
  const router = useRouter();
  const locale = useAppLocale();
  const ru = locale === 'RU';
  const t = (en: string, r: string) => localeText(locale, en, r);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  async function loadPreview(): Promise<void> {
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/sites/${site.id}/finish`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error();
      setPreview((await res.json()) as Preview);
    } catch {
      setError(t('Could not load the site details. Try again.', 'Не удалось загрузить данные объекта. Попробуйте ещё раз.'));
    } finally {
      setLoading(false);
    }
  }

  async function act(path: string): Promise<void> {
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/sites/${site.id}/${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF },
        body: '{}'
      });
      if (res.ok) {
        setPreview(null);
        router.refresh();
        return;
      }
      const code = (((await res.json().catch(() => ({}))) as { error?: { code?: string } }).error ?? {}).code;
      setError(
        code === 'ALREADY_FINISHED'
          ? t('This site is already finished — reloading.', 'Объект уже завершён — обновляем страницу.')
          : code === 'FORBIDDEN'
            ? t('You no longer have permission to change sites.', 'У вас больше нет права изменять объекты.')
            : t('Something went wrong. Please try again.', 'Произошла ошибка. Попробуйте ещё раз.')
      );
      if (code === 'ALREADY_FINISHED') router.refresh();
    } catch {
      setError(t('Network error. Please try again.', 'Ошибка сети. Попробуйте ещё раз.'));
    } finally {
      setLoading(false);
    }
  }

  const fmt = (iso: string) => new Date(iso).toLocaleString(ru ? 'ru-RU' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <section className="worker-work-setup" aria-label={t('Site status', 'Статус объекта')}>
      <h2>{t('Site status', 'Статус объекта')}</h2>

      {site.finishingState === 'finishing' ? (
        <>
          <p className="login-error" role="status">
            {t(
              `Finishing — ${site.stuckOpenShifts.length} worker(s) still on an open shift.`,
              `Завершается — ${site.stuckOpenShifts.length} работник(ов) ещё на открытой смене.`
            )}
          </p>
          <p className="setup-subtitle">
            {t(
              'The site becomes "Finished" once they check out. If someone forgot to check out, open their card to fix or force-close the shift.',
              'Объект станет «Завершён», когда они сделают Check Out. Если работник забыл выйти — откройте его карточку, чтобы исправить или принудительно закрыть смену.'
            )}
          </p>
          <ul className="setup-subtitle">
            {site.stuckOpenShifts.map((s) => (
              <li key={s.employeeId}>
                <Link href={`/admin/workers/${s.employeeId}`}>{s.employeeName}</Link> — {t('shift open since', 'смена открыта с')} {fmt(s.openedAt)}
              </li>
            ))}
          </ul>
        </>
      ) : site.finishingState === 'finished' ? (
        <p className="setup-subtitle">
          {t('This site is finished', 'Объект завершён')}
          {site.finishedAt ? ` — ${fmt(site.finishedAt)}` : ''}. {t('Hidden from the lists and the assignment picker. History and the geofence are kept.', 'Скрыт из списков и из выбора при назначении. История и геозона сохранены.')}
        </p>
      ) : (
        <p className="setup-subtitle">
          {t(
            'When the project is over, finish the site. New check-ins and assignments stop at once; open shifts finish normally; nothing is deleted.',
            'Когда проект закончен, завершите объект. Новые Check In и назначения сразу прекращаются; открытые смены дорабатываются; ничего не удаляется.'
          )}
        </p>
      )}

      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}

      {site.finishingState === 'active' ? (
        preview ? (
          <div className="activation-print-card">
            <p>
              <strong>{t('On this site:', 'На объекте:')}</strong>{' '}
              {t(
                `${preview.assignedCount} assigned · ${preview.workingNowCount} working now · ${preview.futureAssignmentsCount} future · ${preview.customerCount} customer(s)`,
                `${preview.assignedCount} назначено · ${preview.workingNowCount} работают сейчас · ${preview.futureAssignmentsCount} будущих · ${preview.customerCount} заказчик(ов)`
              )}
            </p>
            {preview.workers.length > 0 ? (
              <ul className="setup-subtitle">
                {preview.workers.map((w) => (
                  <li key={w.assignmentId}>
                    <Link href={`/admin/workers/${w.employeeId}`}>
                      {w.name} #{w.employeeNumber}
                    </Link>
                    {w.workAreaName ? ` — ${w.workAreaName}` : ''}
                    {w.isPrimary ? ` · ${t('main workplace', 'основное место')}` : ''}
                    {w.workingNow ? ` · ${t('working now', 'сейчас на смене')}` : ''}
                  </li>
                ))}
              </ul>
            ) : null}
            {preview.futureWorkers.length > 0 ? (
              <p className="setup-subtitle">
                {t('Future assignments will be cancelled:', 'Будущие назначения будут отменены:')}{' '}
                {preview.futureWorkers.map((w) => `${w.name}${w.workAreaName ? ` (${w.workAreaName})` : ''}`).join(', ')}
              </p>
            ) : null}
            {preview.openShifts.length > 0 ? (
              <p className="setup-subtitle">
                {t(
                  `${preview.openShifts.length} open shift(s) will keep running — the site sits in "Finishing" until they check out.`,
                  `${preview.openShifts.length} открытая(ых) смена(ы) продолжится — объект будет в статусе «Завершается», пока не сделают Check Out.`
                )}
              </p>
            ) : null}
            <div className="activation-actions">
              <button type="button" className="setup-action" disabled={loading} onClick={() => act('finish')}>
                {loading ? t('Finishing…', 'Завершаем…') : t('Finish after current shifts', 'Завершить после текущих смен')}
              </button>
              <button type="button" className="login-submit" disabled={loading} onClick={() => setPreview(null)}>
                {t('Cancel', 'Отмена')}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="setup-action" disabled={loading} onClick={loadPreview}>
            {loading ? t('Loading…', 'Загрузка…') : t('Finish site…', 'Завершить объект…')}
          </button>
        )
      ) : (
        <button type="button" className="setup-action" disabled={loading} onClick={() => act('reopen')}>
          {loading ? t('Saving…', 'Сохраняем…') : t('Reopen site', 'Восстановить объект')}
        </button>
      )}
    </section>
  );
}
