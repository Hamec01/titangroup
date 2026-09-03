'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';

const CSRF = 'titanor-time';

// docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §M / §8-E — "Групповой перевод". Move a
// crew from THIS site (optionally one customer) to another site/customer/schedule on a FUTURE
// date, in one transaction. The preflight marks each worker READY / has-hours-after /
// already-scheduled; only READY ones are transferred; a conflict on execute rolls back the whole
// batch (nothing partial).

interface Opt { id: string; name: string }
interface TemplateOpt { id: string; name: string; active?: boolean }
interface PreviewWorker {
  employeeId: string;
  employeeNumber: string;
  name: string;
  assignmentId: string;
  workAreaName: string | null;
  isPrimary: boolean;
  workingNow: boolean;
  status: 'READY' | 'HAS_HOURS_AFTER' | 'ALREADY_SCHEDULED';
}
interface Preview {
  sourceSiteName: string;
  effectiveFrom: string;
  workers: PreviewWorker[];
  readyCount: number;
}

export function GroupTransferFlow({
  siteId,
  workAreas
}: {
  siteId: string;
  workAreas: { id: string; name: string; active: boolean }[];
}) {
  const router = useRouter();
  const locale = useAppLocale();
  const ru = locale === 'RU';
  const t = (en: string, r: string) => localeText(locale, en, r);

  const [open, setOpen] = useState(false);
  const [sites, setSites] = useState<Opt[]>([]);
  const [templates, setTemplates] = useState<TemplateOpt[]>([]);
  const [targetWorkAreas, setTargetWorkAreas] = useState<Opt[]>([]);

  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const [sourceWorkAreaId, setSourceWorkAreaId] = useState('');
  const [targetSiteId, setTargetSiteId] = useState('');
  const [targetWorkAreaId, setTargetWorkAreaId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [isPrimary, setIsPrimary] = useState(true);
  const [effectiveFrom, setEffectiveFrom] = useState(tomorrow);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    let off = false;
    fetch('/api/admin/sites?pageSize=200&active=true', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((b: { items?: Opt[] }) => !off && setSites((b.items ?? []).filter((s) => s.id !== siteId)))
      .catch(() => {});
    fetch('/api/admin/templates?pageSize=200', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((b: { items?: TemplateOpt[] }) => !off && setTemplates((b.items ?? []).filter((x) => x.active !== false)))
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [open, siteId]);

  useEffect(() => {
    if (!targetSiteId) {
      setTargetWorkAreas([]);
      return;
    }
    let off = false;
    fetch(`/api/admin/sites/${targetSiteId}/work-areas?active=true&pageSize=200`, { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((b: { items?: Opt[] } | Opt[]) => !off && setTargetWorkAreas(Array.isArray(b) ? b : (b.items ?? [])))
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [targetSiteId]);

  async function loadPreview(): Promise<void> {
    if (loading) return;
    setError(null);
    setLoading(true);
    setPreview(null);
    try {
      const qs = new URLSearchParams({ sourceSiteId: siteId, effectiveFrom, isPrimary: String(isPrimary) });
      if (sourceWorkAreaId) qs.set('sourceWorkAreaId', sourceWorkAreaId);
      const r = await fetch(`/api/admin/assignments/group-change?${qs}`, { credentials: 'same-origin' });
      if (!r.ok) {
        const code = (((await r.json().catch(() => ({}))) as { error?: { code?: string } }).error ?? {}).code;
        throw new Error(code);
      }
      const p = (await r.json()) as Preview;
      setPreview(p);
      setSelected(new Set(p.workers.filter((w) => w.status === 'READY').map((w) => w.assignmentId)));
    } catch (e) {
      setError(
        (e as Error).message === 'EFFECTIVE_FROM_NOT_FUTURE'
          ? t('Pick a future date — a group transfer is always scheduled.', 'Выберите будущую дату — групповой перевод всегда планируется заранее.')
          : t('Could not load the worker list. Try again.', 'Не удалось загрузить список работников. Попробуйте ещё раз.')
      );
    } finally {
      setLoading(false);
    }
  }

  async function submit(): Promise<void> {
    if (loading || !targetSiteId || selected.size === 0) return;
    setError(null);
    setLoading(true);
    try {
      const r = await fetch('/api/admin/assignments/group-change', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF },
        body: JSON.stringify({
          assignmentIds: [...selected],
          siteId: targetSiteId,
          workAreaId: targetWorkAreaId || null,
          templateId: templateId || null,
          isPrimary,
          effectiveFrom
        })
      });
      if (r.ok) {
        setOpen(false);
        setPreview(null);
        router.refresh();
        return;
      }
      const body = (await r.json().catch(() => ({}))) as { error?: { code?: string; conflict?: string } };
      const code = body.error?.code;
      setError(
        code === 'BATCH_CONFLICT'
          ? t(
              `One worker could not be transferred (${body.error?.conflict}). Nothing was changed — reload the list and exclude that worker.`,
              `Один работник не переведён (${body.error?.conflict}). Ничего не изменено — обновите список и исключите его.`
            )
          : code === 'SITE_FINISHED'
            ? t('The target site is finished.', 'Целевой объект завершён.')
            : code === 'CUSTOMER_DISABLED'
              ? t('The target customer is disabled.', 'Целевой заказчик отключён.')
              : t('Something went wrong. Nothing was changed.', 'Произошла ошибка. Ничего не изменено.')
      );
    } catch {
      setError(t('Network error. Nothing was changed.', 'Ошибка сети. Ничего не изменено.'));
    } finally {
      setLoading(false);
    }
  }

  const activeWorkAreas = workAreas.filter((w) => w.active);
  const statusLabel = (s: PreviewWorker['status']) =>
    s === 'READY'
      ? t('ready', 'готов')
      : s === 'HAS_HOURS_AFTER'
        ? t('has hours on/after that date — excluded', 'есть часы с этой даты — исключён')
        : t('already has a scheduled transfer — excluded', 'уже есть запланированный перевод — исключён');

  if (!open) {
    return (
      <section className="worker-work-setup" aria-label={t('Group transfer', 'Групповой перевод')}>
        <h2>{t('Group transfer', 'Групповой перевод')}</h2>
        <p className="setup-subtitle">
          {t(
            'Move a whole crew from this site to another site or customer, effective on a future date.',
            'Перевести бригаду с этого объекта на другой объект или к другому заказчику с будущей даты.'
          )}
        </p>
        <button type="button" className="setup-action" onClick={() => setOpen(true)}>
          {t('Start a group transfer…', 'Начать групповой перевод…')}
        </button>
      </section>
    );
  }

  return (
    <section className="worker-work-setup" aria-label={t('Group transfer', 'Групповой перевод')}>
      <h2>{t('Group transfer', 'Групповой перевод')}</h2>

      <label>
        {t('Move workers of', 'Перевести работников')}:{' '}
        <select value={sourceWorkAreaId} onChange={(e) => { setSourceWorkAreaId(e.target.value); setPreview(null); }}>
          <option value="">{t('the whole site', 'всего объекта')}</option>
          {activeWorkAreas.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
      </label>
      <br />
      <label>
        {t('To site', 'На объект')}:{' '}
        <select value={targetSiteId} onChange={(e) => { setTargetSiteId(e.target.value); setTargetWorkAreaId(''); setPreview(null); }}>
          <option value="">—</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </label>
      <br />
      <label>
        {t('Customer', 'Заказчик')}:{' '}
        <select value={targetWorkAreaId} onChange={(e) => setTargetWorkAreaId(e.target.value)} disabled={!targetSiteId}>
          <option value="">{t('none', 'без заказчика')}</option>
          {targetWorkAreas.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
      </label>
      <br />
      <label>
        {t('Schedule', 'График')}:{' '}
        <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          <option value="">{t('keep / none', 'оставить / без графика')}</option>
          {templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
          ))}
        </select>
      </label>
      <br />
      <label>
        <input type="checkbox" checked={isPrimary} onChange={(e) => { setIsPrimary(e.target.checked); setPreview(null); }} />{' '}
        {t('This becomes each worker’s main workplace', 'Это станет основным местом работы каждого')}
      </label>
      <br />
      <label>
        {t('From', 'С какого дня')}:{' '}
        <input type="date" value={effectiveFrom} min={tomorrow} onChange={(e) => { setEffectiveFrom(e.target.value); setPreview(null); }} />
      </label>
      <br />

      {error ? <p className="login-error" role="alert">{error}</p> : null}

      <div className="activation-actions">
        <button type="button" className="login-submit" disabled={loading} onClick={loadPreview}>
          {loading ? t('Loading…', 'Загрузка…') : t('Show the worker list', 'Показать список работников')}
        </button>
        <button type="button" className="login-submit" disabled={loading} onClick={() => { setOpen(false); setPreview(null); setError(null); }}>
          {t('Cancel', 'Отмена')}
        </button>
      </div>

      {preview ? (
        <div className="activation-print-card">
          <p>
            <strong>
              {t(
                `${preview.readyCount} of ${preview.workers.length} worker(s) can be transferred on ${preview.effectiveFrom}`,
                `${preview.readyCount} из ${preview.workers.length} работник(ов) можно перевести с ${preview.effectiveFrom}`
              )}
            </strong>
          </p>
          <ul className="setup-list">
            {preview.workers.map((w) => (
              <li key={w.assignmentId} className="setup-item">
                <label style={{ opacity: w.status === 'READY' ? 1 : 0.55 }}>
                  <input
                    type="checkbox"
                    disabled={w.status !== 'READY'}
                    checked={selected.has(w.assignmentId)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(w.assignmentId);
                      else next.delete(w.assignmentId);
                      setSelected(next);
                    }}
                  />{' '}
                  <Link href={`/admin/workers/${w.employeeId}`}>{w.name} #{w.employeeNumber}</Link>
                  {w.workAreaName ? ` — ${w.workAreaName}` : ''}
                  {w.isPrimary ? ` · ${t('main', 'основное')}` : ''}
                  {w.workingNow ? ` · ${t('working now', 'сейчас на смене')}` : ''}
                  {' · '}
                  <span className="setup-subtitle">{statusLabel(w.status)}</span>
                </label>
              </li>
            ))}
          </ul>
          <button type="button" className="setup-action" disabled={loading || !targetSiteId || selected.size === 0} onClick={submit}>
            {loading
              ? t('Transferring…', 'Переводим…')
              : t(`Transfer ${selected.size} worker(s)`, `Перевести ${selected.size} работник(ов)`)}
          </button>
        </div>
      ) : null}
    </section>
  );
}
