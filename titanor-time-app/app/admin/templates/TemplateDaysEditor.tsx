'use client';

import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { localeText } from '@/lib/i18n/locale';

// docs/titanor-time/03_DATA_MODEL_ERD.md §4.5 — weekday 0=Mon..6=Sun. Shared by NewTemplateForm
// (create, version 1) and EditTemplateForm (PATCH, version N+1) — the two forms must never drift
// onto different day-editing UX, same reasoning as the server-side validateTemplateDays/
// parseTemplateTimeToDate sharing in lib/templates.ts.
export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export interface TemplateDayState {
  weekday: number;
  isWorkingDay: boolean;
  plannedStartTime: string;
  plannedEndTime: string;
  plannedBreakMinutes: number;
}

export function defaultTemplateDays(): TemplateDayState[] {
  return WEEKDAY_LABELS.map((_, weekday) => ({
    weekday,
    isWorkingDay: weekday < 5,
    plannedStartTime: '09:00',
    plannedEndTime: '17:00',
    plannedBreakMinutes: weekday < 5 ? 30 : 0
  }));
}

export function templateDaysFromDetail(
  days: { weekday: number; isWorkingDay: boolean; plannedStartTime: string | null; plannedEndTime: string | null; plannedBreakMinutes: number }[]
): TemplateDayState[] {
  const byWeekday = new Map(days.map((d) => [d.weekday, d]));
  return WEEKDAY_LABELS.map((_, weekday) => {
    const day = byWeekday.get(weekday);
    return {
      weekday,
      isWorkingDay: day?.isWorkingDay ?? false,
      plannedStartTime: day?.plannedStartTime ?? '',
      plannedEndTime: day?.plannedEndTime ?? '',
      plannedBreakMinutes: day?.plannedBreakMinutes ?? 0
    };
  });
}

export function toggleTemplateWorkingDay(days: TemplateDayState[], weekday: number, isWorkingDay: boolean): TemplateDayState[] {
  return days.map((day) =>
    day.weekday === weekday
      ? isWorkingDay
        ? { ...day, isWorkingDay: true, plannedStartTime: '09:00', plannedEndTime: '17:00', plannedBreakMinutes: 30 }
        : { ...day, isWorkingDay: false, plannedStartTime: '', plannedEndTime: '', plannedBreakMinutes: 0 }
      : day
  );
}

export function updateTemplateDay(days: TemplateDayState[], weekday: number, patch: Partial<TemplateDayState>): TemplateDayState[] {
  return days.map((day) => (day.weekday === weekday ? { ...day, ...patch } : day));
}

/** Wire format the API expects for a working day's times: undefined (not empty string) when the day is off. */
export function templateDaysToRequestPayload(days: TemplateDayState[]): {
  weekday: number;
  isWorkingDay: boolean;
  plannedStartTime: string | undefined;
  plannedEndTime: string | undefined;
  plannedBreakMinutes: number;
}[] {
  return days.map((day) => ({
    weekday: day.weekday,
    isWorkingDay: day.isWorkingDay,
    plannedStartTime: day.isWorkingDay ? day.plannedStartTime : undefined,
    plannedEndTime: day.isWorkingDay ? day.plannedEndTime : undefined,
    plannedBreakMinutes: day.plannedBreakMinutes
  }));
}

export function TemplateDaysEditor({
  days,
  loading,
  onToggleWorkingDay,
  onUpdateDay
}: {
  days: TemplateDayState[];
  loading: boolean;
  onToggleWorkingDay: (weekday: number, isWorkingDay: boolean) => void;
  onUpdateDay: (weekday: number, patch: Partial<TemplateDayState>) => void;
}) {
  const locale = useAppLocale();
  const weekdayLabels = locale === 'RU'
    ? ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
    : WEEKDAY_LABELS;
  return (
    <div className="template-days">
      {days.map((day) => (
        <div key={day.weekday} className="template-day-row">
          <span className="template-day-label">{weekdayLabels[day.weekday]}</span>
          <label className="template-day-toggle">
            <input
              type="checkbox"
              disabled={loading}
              checked={day.isWorkingDay}
              onChange={(event) => onToggleWorkingDay(day.weekday, event.target.checked)}
            />
            {localeText(locale, 'Working day', 'Рабочий день')}
          </label>
          {day.isWorkingDay ? (
            <>
              <input
                type="time"
                aria-label={`${weekdayLabels[day.weekday]} ${localeText(locale, 'start time', 'начало')}`}
                required
                disabled={loading}
                value={day.plannedStartTime}
                onChange={(event) => onUpdateDay(day.weekday, { plannedStartTime: event.target.value })}
              />
              <span>–</span>
              <input
                type="time"
                aria-label={`${weekdayLabels[day.weekday]} ${localeText(locale, 'end time', 'окончание')}`}
                required
                disabled={loading}
                value={day.plannedEndTime}
                onChange={(event) => onUpdateDay(day.weekday, { plannedEndTime: event.target.value })}
              />
              <input
                type="number"
                min={0}
                aria-label={`${weekdayLabels[day.weekday]} ${localeText(locale, 'break minutes', 'минуты перерыва')}`}
                disabled={loading}
                value={day.plannedBreakMinutes}
                onChange={(event) => onUpdateDay(day.weekday, { plannedBreakMinutes: Number(event.target.value) })}
              />
              <span className="template-day-unit">{localeText(locale, 'min break', 'мин перерыв')}</span>
            </>
          ) : (
            <span className="template-day-off">{localeText(locale, 'Day off', 'Выходной')}</span>
          )}
        </div>
      ))}
    </div>
  );
}
