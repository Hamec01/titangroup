'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import type { WeeklyCustomerSliceRow } from '@/lib/reporting/time-ledger';
import type { CorrectionDetail } from '@/lib/corrections';
import { helsinkiDateAndTimeToUtcIso, utcIsoToHelsinkiTime } from '@/lib/helsinki-datetime';

const CSRF_HEADER_VALUE = 'titanor-time';

interface EditBreak {
  startAt: string;
  endAt: string;
  paid: boolean;
}
interface EditSegment {
  key: number;
  startAt: string;
  endAt: string;
  breaks: EditBreak[];
}
interface EditDay {
  date: string;
  dayType: string;
  segments: EditSegment[];
}

let nextKey = 0;

const DAY_TYPE_OPTIONS: { value: string; ru: string; en: string }[] = [
  { value: 'WORK', ru: 'Работал', en: 'Worked' },
  { value: 'SICK_LEAVE', ru: 'Больничный', en: 'Sick leave' },
  { value: 'VACATION', ru: 'Отпуск', en: 'Vacation' },
  { value: 'UNPAID_LEAVE', ru: 'Неоплач. отпуск', en: 'Unpaid leave' },
  { value: 'OTHER', ru: 'Другое', en: 'Other' }
];

function daySignature(day: EditDay): string {
  if (day.dayType !== 'WORK') return day.dayType;
  return JSON.stringify(day.segments.map((s) => [s.startAt, s.endAt, s.breaks.map((b) => [b.startAt, b.endAt, b.paid])]));
}

function nextDateIso(date: string): string {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + 86400000).toISOString().slice(0, 10);
}

// HH:mm strings compare correctly as strings. A time earlier than the interval's own start belongs
// to the next calendar day (an overnight shift such as 22:00–06:00).
function toIso(date: string, time: string, anchorTime: string): string {
  return helsinkiDateAndTimeToUtcIso(time < anchorTime ? nextDateIso(date) : date, time);
}

function formatDayHeader(dateIso: string, locale: AppLocale): string {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  const weekday = new Intl.DateTimeFormat(locale === 'RU' ? 'ru-RU' : 'en-GB', { weekday: 'short', timeZone: 'UTC' }).format(d);
  const [, m, day] = dateIso.split('-');
  return `${weekday} ${day}.${m}`;
}

function describeError(code: string | undefined, locale: AppLocale): string {
  switch (code) {
    case 'WORK_SEGMENT_OVERLAP':
      return localeText(locale, 'Some time ranges overlap — please adjust them.', 'Интервалы времени пересекаются — скорректируйте их.');
    case 'SITE_NOT_ASSIGNED':
      return localeText(locale, 'The worker has no assignment to this customer on one of the edited days.', 'На один из изменённых дней у работника нет назначения к этому заказчику.');
    case 'DAY_TYPE_CONFLICT':
    case 'DAY_STATE_CONFLICT':
      return localeText(locale, 'A day cannot have hours and be marked as absence at the same time.', 'Нельзя одновременно указать часы и отметить день как отсутствие.');
    case 'DAY_TYPE_REQUIRES_ABSENCE':
      return localeText(locale, 'This day type requires an approved absence request.', 'Для этого типа дня нужен одобренный запрос на отсутствие.');
    case 'VALIDATION_ERROR':
      return localeText(locale, 'Check the times: every end must be after its start.', 'Проверьте время: конец должен быть позже начала.');
    case 'NO_CORRECTION_CHANGES':
      return localeText(locale, 'Nothing changed.', 'Изменений нет.');
    case 'NETWORK_ERROR':
      return localeText(locale, 'Network error — nothing was saved. Please try again.', 'Ошибка сети — ничего не сохранено. Попробуйте снова.');
    default:
      return localeText(locale, 'Could not save — nothing was changed. Please try again.', 'Не удалось сохранить — ничего не изменено. Попробуйте снова.');
  }
}

class SaveError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

async function call<T>(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new SaveError('NETWORK_ERROR');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new SaveError((data as { error?: { code?: string } } | null)?.error?.code ?? 'UNKNOWN');
  return data as T;
}

// Edits one worker's one week for one customer right inside the expanded ledger row — no page
// change. "Save" runs the same server flow as the timesheet card's «Изменить часы» (T12 §1b direct
// edit: no reason, the worker is not notified, fully audited) in one go: open a direct-edit draft,
// PATCH only the days that actually changed, apply. Any failure before apply discards that draft, so
// a failed save never leaves the timesheet with an open edit blocking approval.
//
// The row only carries THIS customer's segments. On a day split between customers, the other
// customers' segments are read from the freshly opened draft and sent back untouched, because a day
// PATCH replaces the whole day.
export function InlineWeekEditor({
  locale,
  row,
  onSaved,
  onCancel
}: {
  locale: AppLocale;
  row: WeeklyCustomerSliceRow;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const initialDays = useMemo<EditDay[]>(
    () =>
      row.displayDays.map((d) => ({
        date: d.date,
        dayType: d.dayType,
        segments: d.segments.map((s) => ({
          key: nextKey++,
          startAt: utcIsoToHelsinkiTime(s.startAt),
          endAt: utcIsoToHelsinkiTime(s.endAt),
          breaks: s.breaks.map((b) => ({ startAt: utcIsoToHelsinkiTime(b.startAt), endAt: utcIsoToHelsinkiTime(b.endAt), paid: b.paid }))
        }))
      })),
    [row.displayDays]
  );
  const initialSignatures = useMemo(() => new Map(initialDays.map((d) => [d.date, daySignature(d)])), [initialDays]);
  const [days, setDays] = useState<EditDay[]>(initialDays);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ code: string } | null>(null);

  const changedDays = days.filter((d) => daySignature(d) !== initialSignatures.get(d.date));

  function updateDay(date: string, update: (day: EditDay) => EditDay) {
    setDays((prev) => prev.map((d) => (d.date === date ? update(d) : d)));
  }
  function updateSegment(date: string, key: number, patch: Partial<EditSegment>) {
    updateDay(date, (d) => ({ ...d, segments: d.segments.map((s) => (s.key === key ? { ...s, ...patch } : s)) }));
  }
  function updateBreak(date: string, key: number, index: number, patch: Partial<EditBreak>) {
    updateDay(date, (d) => ({ ...d, segments: d.segments.map((s) => (s.key === key ? { ...s, breaks: s.breaks.map((b, i) => (i === index ? { ...b, ...patch } : b)) } : s)) }));
  }

  async function handleSave() {
    if (saving) return;
    if (changedDays.length === 0) {
      onCancel();
      return;
    }
    setSaving(true);
    setError(null);
    const { timesheetId, siteId, workAreaId } = row.logicalKey;
    let correctionRequestId: string | null = null;
    try {
      ({ correctionRequestId } = await call<{ correctionRequestId: string }>('POST', `/api/admin/timesheets/${timesheetId}/direct-edit`));
      const draft = await call<CorrectionDetail>('GET', `/api/admin/corrections/${correctionRequestId}`);
      for (const day of changedDays) {
        const draftDay = draft.days.find((d) => d.date === day.date);
        const otherSegments = (draftDay?.segments ?? [])
          .filter((s) => !(s.siteId === siteId && s.workAreaId === workAreaId))
          .map((s) => ({
            startAt: s.startAt,
            endAt: s.endAt,
            siteId: s.siteId,
            workAreaId: s.workAreaId,
            originClockShiftFragmentId: s.originClockShiftFragmentId,
            breaks: s.breaks.map((b) => ({ startAt: b.startAt, endAt: b.endAt, paid: b.paid }))
          }));
        const ownSegments = day.segments.map((s) => ({
          startAt: helsinkiDateAndTimeToUtcIso(day.date, s.startAt),
          endAt: toIso(day.date, s.endAt, s.startAt),
          siteId,
          workAreaId,
          breaks: s.breaks.map((b) => ({ startAt: toIso(day.date, b.startAt, s.startAt), endAt: toIso(day.date, b.endAt, s.startAt), paid: b.paid }))
        }));
        const segments = [...otherSegments, ...ownSegments];
        const body =
          day.dayType === 'WORK'
            ? // Removing every interval of a worked day means "no hours that day", not "not filled in".
              { dayType: 'WORK', confirmedZero: segments.length === 0, segments }
            : { dayType: day.dayType, note: null, confirmedZero: false, segments: [] };
        await call('PATCH', `/api/admin/corrections/${correctionRequestId}/days/${day.date}`, body);
      }
      await call('POST', `/api/admin/corrections/${correctionRequestId}/apply-in-review`);
      onSaved();
    } catch (err) {
      const code = err instanceof SaveError ? err.code : 'UNKNOWN';
      if (correctionRequestId) {
        await call('POST', `/api/admin/corrections/${correctionRequestId}/discard`).catch(() => undefined);
      }
      setError({ code });
      setSaving(false);
    }
  }

  // Already FINAL_APPROVED (needs a correction with a reason) or someone else's edit is open — the
  // timesheet card is the only place that handles those, so point there instead of failing silently.
  const cardHref = `/admin/timesheets/${row.logicalKey.timesheetId}`;
  const needsCard = error?.code === 'INVALID_STATE_TRANSITION' || error?.code === 'CORRECTION_ALREADY_OPEN';

  return (
    <div className="ledger-edit">
      <div className="ledger-edit-scroll">
        <table className="ledger-days-table ledger-edit-table">
          <thead>
            <tr>
              <th>{localeText(locale, 'Day', 'День')}</th>
              <th>{localeText(locale, 'Day type', 'Тип дня')}</th>
              <th>{localeText(locale, 'Intervals and breaks', 'Интервалы и перерывы')}</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => {
              const changed = daySignature(day) !== initialSignatures.get(day.date);
              return (
                <tr key={day.date} className={changed ? 'ledger-edit-row-changed' : undefined}>
                  <td>{formatDayHeader(day.date, locale)}</td>
                  <td>
                    <select
                      className="ledger-edit-input"
                      aria-label={localeText(locale, `Day type ${day.date}`, `Тип дня ${day.date}`)}
                      value={DAY_TYPE_OPTIONS.some((o) => o.value === day.dayType) ? day.dayType : 'OTHER'}
                      disabled={saving}
                      onChange={(e) => updateDay(day.date, (d) => ({ ...d, dayType: e.target.value }))}
                    >
                      {DAY_TYPE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {locale === 'RU' ? o.ru : o.en}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {day.dayType !== 'WORK' ? (
                      <span className="ledger-edit-note">{localeText(locale, "All of this day's hours will be cleared.", 'Все часы за этот день будут очищены.')}</span>
                    ) : (
                      <div className="ledger-edit-segments">
                        {day.segments.map((s) => (
                          <div key={s.key} className="ledger-edit-segment">
                            <div className="ledger-edit-line">
                              <input className="ledger-edit-input" type="time" aria-label={localeText(locale, 'Start', 'Начало')} value={s.startAt} disabled={saving} onChange={(e) => updateSegment(day.date, s.key, { startAt: e.target.value })} />
                              <span>–</span>
                              <input className="ledger-edit-input" type="time" aria-label={localeText(locale, 'End', 'Конец')} value={s.endAt} disabled={saving} onChange={(e) => updateSegment(day.date, s.key, { endAt: e.target.value })} />
                              <button type="button" className="ledger-link-button" disabled={saving} onClick={() => updateSegment(day.date, s.key, { breaks: [...s.breaks, { startAt: '12:00', endAt: '12:30', paid: false }] })}>
                                {localeText(locale, '+ break', '+ перерыв')}
                              </button>
                              <button type="button" className="ledger-link-button ledger-edit-remove" disabled={saving} onClick={() => updateDay(day.date, (d) => ({ ...d, segments: d.segments.filter((x) => x.key !== s.key) }))}>
                                {localeText(locale, 'Remove', 'Удалить')}
                              </button>
                            </div>
                            {s.breaks.map((b, i) => (
                              <div key={i} className="ledger-edit-line ledger-edit-break">
                                <span className="ledger-edit-note">{localeText(locale, 'Break', 'Перерыв')}</span>
                                <input className="ledger-edit-input" type="time" aria-label={localeText(locale, 'Break start', 'Начало перерыва')} value={b.startAt} disabled={saving} onChange={(e) => updateBreak(day.date, s.key, i, { startAt: e.target.value })} />
                                <span>–</span>
                                <input className="ledger-edit-input" type="time" aria-label={localeText(locale, 'Break end', 'Конец перерыва')} value={b.endAt} disabled={saving} onChange={(e) => updateBreak(day.date, s.key, i, { endAt: e.target.value })} />
                                <label className="ledger-edit-check">
                                  <input type="checkbox" checked={b.paid} disabled={saving} onChange={(e) => updateBreak(day.date, s.key, i, { paid: e.target.checked })} />
                                  {localeText(locale, 'paid', 'оплач.')}
                                </label>
                                <button type="button" className="ledger-link-button ledger-edit-remove" disabled={saving} onClick={() => updateSegment(day.date, s.key, { breaks: s.breaks.filter((_, j) => j !== i) })}>
                                  ✕
                                </button>
                              </div>
                            ))}
                          </div>
                        ))}
                        <button type="button" className="ledger-link-button" disabled={saving} onClick={() => updateDay(day.date, (d) => ({ ...d, segments: [...d.segments, { key: nextKey++, startAt: '07:00', endAt: '15:30', breaks: [] }] }))}>
                          {localeText(locale, '+ interval', '+ интервал')}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="ledger-edit-note ledger-edit-hint">
        {localeText(
          locale,
          'The automatic lunch break is still deducted as usual. The worker is not notified; the change is recorded in the audit log. After saving, the week needs to be confirmed again.',
          'Автоматический обеденный перерыв вычитается как обычно. Работник уведомление не получает, изменение фиксируется в журнале аудита. После сохранения неделю нужно подтвердить заново.'
        )}
      </p>

      {error && (
        <div className="ledger-approve-error" role="alert">
          <p>
            {error.code === 'INVALID_STATE_TRANSITION'
              ? localeText(locale, 'This timesheet can no longer be edited directly (it may already be final-approved).', 'Этот табель уже нельзя править напрямую (возможно, он уже окончательно утверждён).')
              : error.code === 'CORRECTION_ALREADY_OPEN'
                ? localeText(locale, 'Another edit is already open on this timesheet.', 'По этому табелю уже открыта другая правка.')
                : describeError(error.code, locale)}
          </p>
          {needsCard && (
            <Link className="ledger-link-button" href={cardHref}>
              {localeText(locale, 'Open the timesheet card', 'Открыть карточку табеля')}
            </Link>
          )}
        </div>
      )}

      <div className="ledger-approve-actions">
        <button type="button" className="ledger-approve-button" disabled={saving || changedDays.length === 0} onClick={handleSave}>
          {saving
            ? localeText(locale, 'Saving…', 'Сохраняем…')
            : changedDays.length > 0
              ? localeText(locale, `Save changes (${changedDays.length} d.)`, `Сохранить изменения (дней: ${changedDays.length})`)
              : localeText(locale, 'No changes yet', 'Изменений пока нет')}
        </button>
        <button type="button" className="ledger-link-button" disabled={saving} onClick={onCancel}>
          {localeText(locale, 'Cancel', 'Отмена')}
        </button>
      </div>
    </div>
  );
}
