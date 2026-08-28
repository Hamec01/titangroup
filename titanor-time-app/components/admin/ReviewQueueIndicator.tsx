'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const POLL_INTERVAL_MS = 5 * 60 * 1000;

interface ReviewQueueWeek {
  periodId: string;
  startDate: string;
  endDate: string;
  count: number;
}

function CalendarIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="m8.5 14 2.2 2.2L15.5 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function formatWeek(startDate: string, endDate: string, ru: boolean): string {
  const fmt = (d: string) => (d ? new Date(d).toLocaleDateString(ru ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'short' }) : '');
  return `${fmt(startDate)} – ${fmt(endDate)}`;
}

// Task B + T12 §1a — the "часы на утверждении" indicator next to the notification bell. Same poll
// cadence as NotificationCenter. Clicking opens a small drawer with the per-week (per open period)
// breakdown; each row and the footer open /admin/review.
export function ReviewQueueIndicator({ locale }: { locale: 'EN' | 'RU' }) {
  const router = useRouter();
  const ru = locale === 'RU';
  const [count, setCount] = useState(0);
  const [weeks, setWeeks] = useState<ReviewQueueWeek[]>([]);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/review-queue', { credentials: 'same-origin' });
      if (!res.ok) return;
      const body = await res.json();
      setCount(typeof body.count === 'number' ? body.count : 0);
      setWeeks(Array.isArray(body.weeks) ? body.weeks : []);
    } catch {
      // non-blocking convenience, same as the bell
    }
  }, []);

  useEffect(() => {
    load();
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    const interval = window.setInterval(load, POLL_INTERVAL_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(interval);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    function onPointerDown(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node) && buttonRef.current && !buttonRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  const label =
    count > 0
      ? ru
        ? `${count} табелей на утверждении`
        : `${count} timesheet${count === 1 ? '' : 's'} awaiting approval`
      : ru
        ? 'Часы на утверждении'
        : 'Timesheets awaiting approval';

  function goToReview(): void {
    setOpen(false);
    router.push('/admin/review');
  }

  return (
    <div className="notif-bell-wrap">
      <button
        type="button"
        ref={buttonRef}
        className="notif-bell-button"
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => (count > 0 ? setOpen((v) => !v) : goToReview())}
      >
        <CalendarIcon />
        {count > 0 ? (
          <span className="notif-badge notif-badge-warning" aria-hidden="true">
            {count > 9 ? '9+' : count}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="notif-drawer" role="dialog" aria-label={ru ? 'Табели на утверждении по неделям' : 'Timesheets awaiting approval by week'} ref={panelRef}>
          <div className="notif-drawer-head">
            <h2>{ru ? 'На утверждении' : 'Awaiting approval'}</h2>
            <button type="button" className="notif-drawer-close" onClick={() => setOpen(false)} aria-label={ru ? 'Закрыть' : 'Close'}>
              ×
            </button>
          </div>
          {weeks.length === 0 ? (
            <p className="notif-drawer-empty">{ru ? 'Нет табелей на утверждении.' : 'Nothing awaiting approval.'}</p>
          ) : (
            <ul className="notif-drawer-list">
              {weeks.map((w) => (
                <li key={w.periodId} className="notif-drawer-item notif-drawer-item-warning">
                  <button type="button" className="notif-drawer-item-link" onClick={goToReview} style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                    <span>
                      {ru ? 'Неделя' : 'Week'} {formatWeek(w.startDate, w.endDate, ru)}
                    </span>
                    <strong>{w.count}</strong>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="notif-drawer-item-link" onClick={goToReview}>
            {ru ? 'Открыть очередь проверки' : 'Open the review queue'} →
          </button>
        </div>
      ) : null}
    </div>
  );
}
