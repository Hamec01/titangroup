'use client';

import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';
import {
  currentHelsinkiWeekRange,
  rangeForWeeksEndingAt,
  shiftRangeByOwnLength,
  weeksCountFromRange,
  type TimeLedgerUiState,
  type WeeksOption
} from '@/lib/reporting/time-ledger-ui-query';

const WEEKS_OPTIONS: WeeksOption[] = [1, 2, 3, 4];

function formatRangeDisplay(startDate: string, endDate: string, locale: AppLocale): string {
  const fmt = (iso: string) => {
    const [y, m, d] = iso.split('-');
    return locale === 'RU' ? `${d}.${m}.${y}` : `${d}/${m}/${y}`;
  };
  return `${fmt(startDate)} – ${fmt(endDate)}`;
}

// UT4-B — TZ §5.1's top bar, plus the fixup's "За всё время" addition. Arrows/weeks-buttons/
// "Текущая неделя" are disabled in allTime mode (nothing to page through).
export function LedgerTopBar({ locale, state, onNavigate }: { locale: AppLocale; state: TimeLedgerUiState; onNavigate: (changes: Partial<TimeLedgerUiState>) => void }) {
  const activeWeeks = !state.allTime && state.startDate && state.endDate ? weeksCountFromRange(state.startDate, state.endDate) : null;

  const goPrev = () => {
    if (state.allTime || !state.startDate || !state.endDate) return;
    const r = shiftRangeByOwnLength(state.startDate, state.endDate, -1);
    onNavigate({ allTime: false, startDate: r.startDate, endDate: r.endDate });
  };
  const goNext = () => {
    if (state.allTime || !state.startDate || !state.endDate) return;
    const r = shiftRangeByOwnLength(state.startDate, state.endDate, 1);
    onNavigate({ allTime: false, startDate: r.startDate, endDate: r.endDate });
  };
  const goCurrentWeek = () => {
    const r = currentHelsinkiWeekRange(new Date());
    onNavigate({ allTime: false, startDate: r.startDate, endDate: r.endDate });
  };
  const goWeeks = (weeks: WeeksOption) => {
    const anchorEnd = !state.allTime && state.endDate ? state.endDate : currentHelsinkiWeekRange(new Date()).endDate;
    const r = rangeForWeeksEndingAt(anchorEnd, weeks);
    onNavigate({ allTime: false, startDate: r.startDate, endDate: r.endDate });
  };
  const goAllTime = () => onNavigate({ allTime: true, startDate: null, endDate: null });

  return (
    <div className="ledger-topbar">
      <div className="ledger-topbar-range">
        <button type="button" className="ledger-arrow-button" onClick={goPrev} disabled={state.allTime} aria-label={localeText(locale, 'Previous range', 'Предыдущий диапазон')}>
          ←
        </button>
        <span className="ledger-range-display">
          {state.allTime ? localeText(locale, 'All time', 'За всё время') : state.startDate && state.endDate ? formatRangeDisplay(state.startDate, state.endDate, locale) : ''}
        </span>
        <button type="button" className="ledger-arrow-button" onClick={goNext} disabled={state.allTime} aria-label={localeText(locale, 'Next range', 'Следующий диапазон')}>
          →
        </button>
        <button type="button" className="ledger-pill-button" onClick={goCurrentWeek} disabled={state.allTime}>
          {localeText(locale, 'Current week', 'Текущая неделя')}
        </button>
      </div>
      <div className="ledger-topbar-weeks" role="group" aria-label={localeText(locale, 'Range length', 'Длина диапазона')}>
        {WEEKS_OPTIONS.map((w) => (
          <button
            key={w}
            type="button"
            className="ledger-pill-button"
            aria-pressed={!state.allTime && activeWeeks === w}
            data-active={!state.allTime && activeWeeks === w ? 'true' : undefined}
            onClick={() => goWeeks(w)}
          >
            {localeText(locale, `${w} wk`, `${w} нед`)}
          </button>
        ))}
        <button type="button" className="ledger-pill-button" aria-pressed={state.allTime} data-active={state.allTime ? 'true' : undefined} onClick={goAllTime}>
          {localeText(locale, 'All time', 'За всё время')}
        </button>
      </div>
    </div>
  );
}
