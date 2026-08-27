'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

const POLL_INTERVAL_MS = 5 * 60 * 1000;

function CalendarIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="m8.5 14 2.2 2.2L15.5 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Task B — the "часы на утверждении" indicator, sitting next to the notification bell. Same poll
// cadence as NotificationCenter; click goes to /admin/review.
export function ReviewQueueIndicator({ locale }: { locale: 'EN' | 'RU' }) {
  const router = useRouter();
  const [count, setCount] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/review-queue', { credentials: 'same-origin' });
      if (!res.ok) return;
      const body = await res.json();
      setCount(typeof body.count === 'number' ? body.count : 0);
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

  const label =
    count > 0
      ? locale === 'RU'
        ? `${count} табелей на утверждении`
        : `${count} timesheet${count === 1 ? '' : 's'} awaiting approval`
      : locale === 'RU'
        ? 'Часы на утверждении'
        : 'Timesheets awaiting approval';

  return (
    <div className="notif-bell-wrap">
      <button type="button" className="notif-bell-button" aria-label={label} onClick={() => router.push('/admin/review')}>
        <CalendarIcon />
        {count > 0 ? (
          <span className="notif-badge notif-badge-warning" aria-hidden="true">
            {count > 9 ? '9+' : count}
          </span>
        ) : null}
      </button>
    </div>
  );
}
