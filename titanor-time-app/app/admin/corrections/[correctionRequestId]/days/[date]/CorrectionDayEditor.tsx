'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { helsinkiDateAndTimeToUtcIso as helsinkiTimeToIso, utcIsoToHelsinkiTime as isoToHelsinkiTime } from '@/lib/helsinki-datetime';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { dayTypeLabel } from '@/lib/i18n/worker';

const CSRF_HEADER_VALUE = 'titanor-time';

function assignmentKeyOf(siteId: string, workAreaId: string | null): string {
  return `${siteId}::${workAreaId ?? ''}`;
}

interface AssignmentOption {
  siteId: string;
  siteName: string;
  workAreaId: string | null;
  workAreaName: string | null;
}

interface InitialBreak {
  startAt: string;
  endAt: string;
  paid: boolean;
}

interface InitialSegment {
  startAt: string;
  endAt: string;
  siteId: string;
  workAreaId: string | null;
  breaks: InitialBreak[];
}

interface CorrectionDayEditorProps {
  correctionRequestId: string;
  date: string;
  initialDayType: string;
  initialConfirmedZero: boolean;
  initialSegments: InitialSegment[];
  assignmentOptions: AssignmentOption[];
}

interface EditableBreak {
  startAt: string;
  endAt: string;
  paid: boolean;
}

interface EditableSegment {
  key: number;
  assignmentKey: string;
  startAt: string;
  endAt: string;
  breaks: EditableBreak[];
}

let nextKey = 0;

function describeError(code: string | undefined, fieldErrors: Record<string, string[]> | undefined, ru: boolean): string {
  switch (code) {
    case 'WORK_SEGMENT_OVERLAP':
      return ru ? 'Эти интервалы времени пересекаются — скорректируйте их.' : 'These time ranges overlap — please adjust them.';
    case 'SITE_NOT_ASSIGNED':
      return ru ? 'У этого работника нет подходящего назначения на объект/зону на эту дату.' : 'This employee has no matching site/area assignment on this date.';
    case 'DAY_TYPE_CONFLICT':
      return ru ? 'Нельзя одновременно указать часы и отметить день как отсутствие.' : 'Cannot have hours logged and mark the day as absence at the same time.';
    case 'DAY_STATE_CONFLICT':
      return ru ? 'Нельзя подтвердить ноль часов, пока указаны часы.' : 'Cannot confirm zero hours while hours are logged.';
    case 'DAY_TYPE_REQUIRES_ABSENCE':
      return ru ? 'Для этого типа дня требуется одобренный запрос на отсутствие.' : 'This day type requires an approved absence request.';
    case 'INVALID_STATE_TRANSITION':
      return ru ? 'Этот черновик корректировки больше не открыт для редактирования.' : 'This correction draft is no longer open for editing.';
    case 'VALIDATION_ERROR':
      return fieldErrors
        ? Object.entries(fieldErrors)
            .map(([field, messages]) => `${field}: ${messages.join(', ')}`)
            .join('; ')
        : (ru ? 'Некорректные данные.' : 'Invalid input.');
    default:
      return ru ? 'Не удалось сохранить — попробуйте снова.' : 'Could not save — please try again.';
  }
}

export default function CorrectionDayEditor({ correctionRequestId, date, initialDayType, initialConfirmedZero, initialSegments, assignmentOptions }: CorrectionDayEditorProps) {
  const router = useRouter();
  const locale = useAppLocale();
  const ru = locale === 'RU';
  const [segments, setSegments] = useState<EditableSegment[]>(() =>
    initialSegments.map((s) => ({
      key: nextKey++,
      assignmentKey: assignmentKeyOf(s.siteId, s.workAreaId),
      startAt: isoToHelsinkiTime(s.startAt),
      endAt: isoToHelsinkiTime(s.endAt),
      breaks: s.breaks.map((b) => ({ startAt: isoToHelsinkiTime(b.startAt), endAt: isoToHelsinkiTime(b.endAt), paid: b.paid }))
    }))
  );
  const [confirmedZero, setConfirmedZero] = useState(initialConfirmedZero);
  const [dayType, setDayType] = useState(initialDayType);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Task C — the admin can mark this day «Работал / Больничный / Отпуск / Неоплачиваемый / Другое»
  // straight here. A non-WORK type auto-records a one-day APPROVED Absence server-side.
  const DAY_TYPE_OPTIONS: { value: string; ru: string; en: string }[] = [
    { value: 'WORK', ru: 'Работал', en: 'Worked' },
    { value: 'SICK_LEAVE', ru: 'Больничный', en: 'Sick leave' },
    { value: 'VACATION', ru: 'Отпуск', en: 'Vacation' },
    { value: 'UNPAID_LEAVE', ru: 'Неоплачиваемый отпуск', en: 'Unpaid leave' },
    { value: 'OTHER', ru: 'Другое', en: 'Other' }
  ];
  const isAbsenceDay = dayType !== 'WORK';

  function addSegment() {
    if (assignmentOptions.length === 0) {
      return;
    }
    setSegments((prev) => [
      ...prev,
      { key: nextKey++, assignmentKey: assignmentKeyOf(assignmentOptions[0].siteId, assignmentOptions[0].workAreaId), startAt: '08:00', endAt: '16:00', breaks: [] }
    ]);
    setConfirmedZero(false);
  }

  function removeSegment(key: number) {
    setSegments((prev) => prev.filter((s) => s.key !== key));
  }

  function updateSegment(key: number, patch: Partial<EditableSegment>) {
    setSegments((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }

  function addBreak(segKey: number) {
    setSegments((prev) => prev.map((s) => (s.key === segKey ? { ...s, breaks: [...s.breaks, { startAt: '12:00', endAt: '12:30', paid: false }] } : s)));
  }

  function updateBreak(segKey: number, breakIndex: number, patch: Partial<EditableBreak>) {
    setSegments((prev) => prev.map((s) => (s.key === segKey ? { ...s, breaks: s.breaks.map((b, i) => (i === breakIndex ? { ...b, ...patch } : b)) } : s)));
  }

  function removeBreak(segKey: number, breakIndex: number) {
    setSegments((prev) => prev.map((s) => (s.key === segKey ? { ...s, breaks: s.breaks.filter((_, i) => i !== breakIndex) } : s)));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> =
        dayType === 'WORK'
          ? {
              dayType: 'WORK',
              confirmedZero: segments.length === 0 ? confirmedZero : false,
              segments: segments.map((s) => {
                const [siteId, workAreaId] = s.assignmentKey.split('::');
                return {
                  startAt: helsinkiTimeToIso(date, s.startAt),
                  endAt: helsinkiTimeToIso(date, s.endAt),
                  siteId,
                  workAreaId: workAreaId || null,
                  breaks: s.breaks.map((b) => ({ startAt: helsinkiTimeToIso(date, b.startAt), endAt: helsinkiTimeToIso(date, b.endAt), paid: b.paid }))
                };
              })
            }
          : { dayType, note: note.trim() || null, confirmedZero: false, segments: [] };
      const res = await fetch(`/api/admin/corrections/${correctionRequestId}/days/${date}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(describeError(data?.error?.code, data?.error?.fieldErrors, ru));
        setSaving(false);
        return;
      }
      router.push(`/admin/corrections/${correctionRequestId}`);
    } catch {
      setError(ru ? 'Ошибка сети — попробуйте снова.' : 'Network error — please try again.');
      setSaving(false);
    }
  }

  return (
    <main className="wk-page">
      <div className="wk-card">
        <a href={`/admin/corrections/${correctionRequestId}`} className="wk-back-link">
          ← {ru ? 'Назад' : 'Back'}
        </a>
        <h1>{date}</h1>

        <div className="login-field">
          <label htmlFor="cde-daytype">{ru ? 'Тип дня' : 'Day type'}</label>
          <select id="cde-daytype" value={DAY_TYPE_OPTIONS.some((o) => o.value === dayType) ? dayType : 'OTHER'} onChange={(e) => setDayType(e.target.value)} disabled={saving}>
            {DAY_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {ru ? o.ru : o.en}
              </option>
            ))}
          </select>
        </div>

        {isAbsenceDay ? (
          <div className="login-field">
            <label htmlFor="cde-note">{ru ? 'Комментарий (необязательно)' : 'Comment (optional)'}</label>
            <textarea id="cde-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} disabled={saving} placeholder={ru ? 'например, со слов работника' : 'e.g. per the worker'} />
            <p className="wk-readonly-note">
              {ru
                ? `Часы за этот день будут очищены, день пойдёт как «${dayTypeLabel(dayType, locale)}».`
                : `This day's hours will be cleared and it will count as ${dayTypeLabel(dayType, locale)}.`}
            </p>
          </div>
        ) : (
          <>
            {segments.length === 0 && (
              <label className="wk-checkbox-row">
                <input type="checkbox" checked={confirmedZero} onChange={(e) => setConfirmedZero(e.target.checked)} disabled={saving} />
                {ru ? 'В этот день часов не было' : 'No hours worked this day'}
              </label>
            )}

            <ul className="wk-segment-list">
              {segments.map((segment) => (
                <li key={segment.key} className="wk-segment-card">
                  <select value={segment.assignmentKey} onChange={(e) => updateSegment(segment.key, { assignmentKey: e.target.value })} disabled={saving}>
                    {assignmentOptions.map((option) => {
                      const key = assignmentKeyOf(option.siteId, option.workAreaId);
                      return (
                        <option key={key} value={key}>
                          {option.siteName}
                          {option.workAreaName ? ` — ${option.workAreaName}` : ''}
                        </option>
                      );
                    })}
                  </select>
                  <div className="wk-time-row">
                    <input type="time" value={segment.startAt} onChange={(e) => updateSegment(segment.key, { startAt: e.target.value })} disabled={saving} />
                    <span>–</span>
                    <input type="time" value={segment.endAt} onChange={(e) => updateSegment(segment.key, { endAt: e.target.value })} disabled={saving} />
                  </div>

                  {segment.breaks.map((b, i) => (
                    <div key={i} className="wk-break-row">
                      <input type="time" value={b.startAt} onChange={(e) => updateBreak(segment.key, i, { startAt: e.target.value })} disabled={saving} />
                      <span>–</span>
                      <input type="time" value={b.endAt} onChange={(e) => updateBreak(segment.key, i, { endAt: e.target.value })} disabled={saving} />
                      <label className="wk-break-paid">
                        <input type="checkbox" checked={b.paid} onChange={(e) => updateBreak(segment.key, i, { paid: e.target.checked })} disabled={saving} />
                        {ru ? 'Оплачиваемый' : 'Paid'}
                      </label>
                      <button type="button" className="wk-remove-button" onClick={() => removeBreak(segment.key, i)} disabled={saving}>
                        {ru ? 'Удалить перерыв' : 'Remove break'}
                      </button>
                    </div>
                  ))}
                  <button type="button" className="wk-secondary-button" onClick={() => addBreak(segment.key)} disabled={saving}>
                    {ru ? '+ Добавить перерыв' : '+ Add break'}
                  </button>

                  <button type="button" className="wk-remove-button" onClick={() => removeSegment(segment.key)} disabled={saving}>
                    {ru ? 'Удалить интервал' : 'Remove interval'}
                  </button>
                </li>
              ))}
            </ul>

            <button type="button" className="wk-secondary-button" onClick={addSegment} disabled={saving || assignmentOptions.length === 0}>
              {ru ? '+ Добавить интервал' : '+ Add interval'}
            </button>
          </>
        )}

        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}

        <button type="button" className="wk-action-button" onClick={handleSave} disabled={saving}>
          {saving ? (ru ? 'Сохранение…' : 'Saving…') : (ru ? 'Сохранить' : 'Save')}
        </button>
      </div>
    </main>
  );
}
