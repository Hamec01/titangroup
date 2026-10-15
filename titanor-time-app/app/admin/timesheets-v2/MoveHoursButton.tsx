'use client';

import { useEffect, useState } from 'react';
import type { AppLocale } from '@/lib/i18n/locale';
import { formatMatrixHours } from '@/lib/timesheet-v2-cell-input';

// Табель v2 → "Перенести часы другому заказчику": one worker's recorded days of this customer and
// month, moved to another customer of the same site after one confirmation. Times stay the same.

const CSRF_HEADERS = { 'X-Requested-With': 'titanor-time', 'Content-Type': 'application/json' };

export interface MoveTarget { workArea: string; name: string }

interface Preview { segmentCount: number; grossMinutes: number; dates: string[]; submittedDates: string[] }

function shortDate(date: string): string {
  return `${date.slice(8, 10)}.${date.slice(5, 7)}`;
}

export function MoveHoursButton({ locale, employeeId, workerName, siteId, fromWorkArea, fromName, days, targets }: { locale: AppLocale; employeeId: string; workerName: string; siteId: string; fromWorkArea: string; fromName: string; days: Array<{ date: string; minutes: number }>; targets: MoveTarget[] }) {
  const ru = locale === 'RU';
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set(days.map((d) => d.date)));
  const [target, setTarget] = useState(targets[0]?.workArea ?? '');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dates = days.map((d) => d.date).filter((d) => selected.has(d));
  const key = `${dates.join(',')}|${target}`;

  useEffect(() => {
    if (!open || !dates.length || !target) { setPreview(null); return; }
    const controller = new AbortController();
    void fetch('/api/admin/timesheets-v2/move-hours', { method: 'POST', headers: CSRF_HEADERS, signal: controller.signal, body: JSON.stringify({ employeeId, siteId, fromWorkArea, toWorkArea: target, dates, preview: true }) })
      .then((r) => (r.ok ? r.json() : null))
      .then((p: Preview | null) => setPreview(p))
      .catch(() => undefined);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key]);

  if (!days.length || !targets.length) return null;

  async function move() {
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/admin/timesheets-v2/move-hours', { method: 'POST', headers: CSRF_HEADERS, body: JSON.stringify({ employeeId, siteId, fromWorkArea, toWorkArea: target, dates }) });
      if (r.ok) { window.location.reload(); return; }
      const body = await r.json().catch(() => null);
      const code = body?.error?.code;
      setError(code === 'TIMESHEET_SUBMITTED'
        ? (ru ? `Табель за эти дни уже отправлен (${(body?.error?.dates ?? []).map(shortDate).join(', ')}). Исправьте их через корректировку в разделе «Табели».` : 'The timesheet for these days is already submitted — use a correction in “Timesheets”.')
        : code === 'CUSTOMER_DISABLED' ? (ru ? 'Этот заказчик отключён.' : 'That customer is turned off.')
        : code === 'NOTHING_TO_MOVE' ? (ru ? 'За выбранные дни нет записанных часов.' : 'No recorded hours on the chosen days.')
        : (ru ? 'Не удалось перенести часы. Обновите страницу и попробуйте ещё раз.' : 'Could not move the hours. Reload and try again.'));
      setBusy(false);
    } catch {
      setError(ru ? 'Ошибка сети.' : 'Network error.');
      setBusy(false);
    }
  }

  const targetName = targets.find((t) => t.workArea === target)?.name ?? '';
  // Same hours as the grid shows (after breaks), so the summary matches the table.
  const selectedMinutes = days.filter((d) => selected.has(d.date)).reduce((sum, d) => sum + d.minutes, 0);
  return (
    <>
      <button type="button" className="mm-move-button" title={ru ? 'Перенести часы другому заказчику' : 'Move hours to another customer'} aria-label={ru ? `Перенести часы: ${workerName}` : `Move hours: ${workerName}`} onClick={() => { setOpen(true); setError(null); }}>⇄</button>
      {open && (
        <div className="documents-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.currentTarget === e.target && !busy) setOpen(false); }}>
          <div className="documents-modal mm-move-modal" role="dialog" aria-modal="true" aria-labelledby={`move-${employeeId}`}>
            <h2 id={`move-${employeeId}`}>{ru ? 'Перенести часы другому заказчику' : 'Move hours to another customer'}</h2>
            <p><strong>{workerName}</strong> · {ru ? 'сейчас:' : 'now:'} {fromName}</p>
            <fieldset className="mm-move-days">
              <legend>{ru ? 'Дни' : 'Days'}</legend>
              {days.map((d) => (
                <label key={d.date}>
                  <input type="checkbox" checked={selected.has(d.date)} disabled={busy} onChange={() => setSelected((cur) => { const next = new Set(cur); if (next.has(d.date)) next.delete(d.date); else next.add(d.date); return next; })} />
                  {shortDate(d.date)} · {formatMatrixHours(d.minutes)} {ru ? 'ч' : 'h'}
                </label>
              ))}
            </fieldset>
            <label>{ru ? 'Перенести к заказчику' : 'Move to customer'}
              <select value={target} disabled={busy} onChange={(e) => setTarget(e.target.value)}>
                {targets.map((t) => <option key={t.workArea} value={t.workArea}>{t.name}</option>)}
              </select>
            </label>
            {preview && (
              preview.submittedDates.length
                ? <p className="login-error" role="alert">{ru ? `Табель за ${preview.submittedDates.map(shortDate).join(', ')} уже отправлен — эти дни исправляются через корректировку в разделе «Табели».` : 'Some of these days are already submitted — use a correction in “Timesheets”.'}</p>
                : <p className="mm-move-summary">{ru ? `Будет перенесено ${formatMatrixHours(selectedMinutes) || '0'} ч (${preview.dates.map(shortDate).join(', ')}): ${fromName} → ${targetName}. Время прихода, ухода и перерывы не меняются.` : `${formatMatrixHours(selectedMinutes) || '0'} h will move (${preview.dates.map(shortDate).join(', ')}): ${fromName} → ${targetName}. Times and breaks stay the same.`}</p>
            )}
            {error && <p className="login-error" role="alert">{error}</p>}
            <div>
              <button type="button" disabled={busy} onClick={() => setOpen(false)}>{ru ? 'Отмена' : 'Cancel'}</button>
              <button type="button" className="documents-primary" disabled={busy || !dates.length || !preview || preview.submittedDates.length > 0 || preview.segmentCount === 0} onClick={() => void move()}>
                {busy ? (ru ? 'Переносим…' : 'Moving…') : (ru ? 'Перенести' : 'Move')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
