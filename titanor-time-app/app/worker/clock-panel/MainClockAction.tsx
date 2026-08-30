'use client';

// R09.7 — the big Check In / Check Out action (with the live elapsed timer and "since" line while
// clocked in), extracted verbatim from WorkerClockPanel.tsx. Pure presentational — the parent still
// owns the handlers, the disabled predicate and every piece of state; this only lays them out.
import type { WorkerStrings } from '@/lib/i18n/worker';
import { formatDuration, formatHelsinkiTime } from './format';

interface MainClockActionProps {
  isClockedIn: boolean;
  openedAt: string | null;
  durationMs: number;
  actionLabel: string;
  actionHint: string;
  actionHelper: string;
  disabled: boolean;
  onClick: () => void;
  t: WorkerStrings;
}

export function MainClockAction({ isClockedIn, openedAt, durationMs, actionLabel, actionHint, actionHelper, disabled, onClick, t }: MainClockActionProps) {
  return (
    <div className={`wk-main-action-wrap ${isClockedIn ? 'in' : 'out'}`}>
      {isClockedIn && openedAt && (
        <p className="wk-main-action-timer" aria-label={`Elapsed time ${formatDuration(durationMs)}`}>
          {formatDuration(durationMs)}
        </p>
      )}
      {isClockedIn && openedAt ? <p className="wk-main-action-since">{t.sinceTime(formatHelsinkiTime(openedAt))}</p> : null}

      <button
        type="button"
        className={`wk-main-action ${isClockedIn ? 'out' : 'in'}`}
        onClick={onClick}
        disabled={disabled}
        aria-live="polite"
        aria-label={isClockedIn ? t.checkOut : t.checkIn}
      >
        <span className="wk-main-action-title">{actionLabel}</span>
        <span className="wk-main-action-subtitle">{actionHint}</span>
        <span className="wk-main-action-helper">{actionHelper}</span>
      </button>
    </div>
  );
}
