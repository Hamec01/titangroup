'use client';

// R09.7 — the "this week" time-card preview (heading total, optional deep link, per-day grid),
// extracted verbatim from WorkerClockPanel.tsx. Pure presentational — the parent still folds the
// live open-shift minutes into `weekActivity` before passing it here as `displayWeekActivity`.
import { WorkerLink } from '@/components/worker-pwa/WorkerLink';
import { formatWorkedDuration } from '@/lib/reporting/report-format';
import type { AppLocale } from '@/lib/i18n/locale';
import type { WorkerStrings } from '@/lib/i18n/worker';
import type { WorkerWeekActivity } from './format';

interface TimeCardPreviewProps {
  displayWeekActivity: WorkerWeekActivity | null;
  timeCardHref: string | null;
  locale: AppLocale;
  t: WorkerStrings;
}

export function TimeCardPreview({ displayWeekActivity, timeCardHref, locale, t }: TimeCardPreviewProps) {
  return (
    <section className="wk-time-preview" aria-labelledby="wk-time-preview-title">
      <div className="wk-time-preview-heading">
        <h2 id="wk-time-preview-title">{t.timeCardTitle}</h2>
        {displayWeekActivity ? <span>{formatWorkedDuration(displayWeekActivity.totalMinutes, locale)}</span> : null}
      </div>

      {timeCardHref ? (
        <WorkerLink href={timeCardHref} className="wk-time-preview-link">
          <span>{t.viewAndEditHours}</span>
          <span aria-hidden="true">→</span>
        </WorkerLink>
      ) : null}

      {displayWeekActivity ? (
        <ol className="wk-week-grid">
          {displayWeekActivity.days.map((day) => {
            const body = (
              <>
                <span className="wk-week-day-label">{day.label}</span>
                <span className="wk-week-day-hours">{day.totalMinutes > 0 ? formatWorkedDuration(day.totalMinutes, locale) : '—'}</span>
              </>
            );
            return (
              <li key={day.date} className={`wk-week-day${day.isToday ? ' today' : ''}`}>
                {day.href ? (
                  <WorkerLink href={day.href} className="wk-week-day-link">
                    {body}
                  </WorkerLink>
                ) : (
                  <span className="wk-week-day-link wk-week-day-link-disabled">{body}</span>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="wk-empty">{t.noCompletedTimeEntries}</p>
      )}
    </section>
  );
}
