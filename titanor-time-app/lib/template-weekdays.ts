import type { AppLocale } from '@/lib/i18n/locale';

// Work-schedule template weekdays are 0 = Monday … 6 = Sunday (docs/titanor-time/03_DATA_MODEL_ERD.md
// §4.5). One label table for the template editor and the template detail page, so the two can never
// disagree about which day a row is (the detail page once indexed the Russian names from 1).
const LONG: Record<'EN' | 'RU', string[]> = {
  EN: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  RU: ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье']
};
const SHORT: Record<'EN' | 'RU', string[]> = {
  EN: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  RU: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
};

export function templateWeekdayLabel(locale: AppLocale, weekday: number, form: 'long' | 'short' = 'long'): string {
  const table = (form === 'long' ? LONG : SHORT)[locale === 'RU' ? 'RU' : 'EN'];
  return table[weekday] ?? String(weekday);
}
