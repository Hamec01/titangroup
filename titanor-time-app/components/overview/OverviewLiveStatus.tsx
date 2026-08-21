'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

const OVERVIEW_REFRESH_MS = 30 * 60 * 1000;
const ELAPSED_REFRESH_MS = 60 * 1000;

function formatElapsed(startedAtMs: number, nowMs: number): string {
  const totalMinutes = Math.max(0, Math.floor((nowMs - startedAtMs) / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours === 0 ? `${minutes} min` : `${hours} h ${minutes} min`;
}

/**
 * The durable source is EmployeeOpenShift.openedAt. This component only derives the display
 * duration in the browser; it never writes periodic timer rows to the database.
 */
export function LiveShiftDuration({ openedAt, initialAsOf }: { openedAt: string; initialAsOf: string }) {
  const startedAtMs = Date.parse(openedAt);
  const [nowMs, setNowMs] = useState(() => Date.parse(initialAsOf));

  useEffect(() => {
    const update = () => setNowMs(Date.now());
    update();
    const timer = window.setInterval(update, ELAPSED_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  return <span className="ov-live-duration">elapsed {formatElapsed(startedAtMs, nowMs)}</span>;
}

/** Re-reads authoritative overview state twice an hour while this page is actually visible. */
export function OverviewAutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        router.refresh();
      }
    }, OVERVIEW_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [router]);

  return null;
}
