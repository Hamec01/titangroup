'use client';

import { useEffect, useState } from 'react';

// docs/titanor-time/T8_PWA_DESIGN.md §F — shared connectivity banner for Worker pages OTHER than
// /worker itself, which already has its own offline indicator (WorkerClockPanel's `wk-offline-bar`)
// — this is deliberately never rendered there, to avoid two overlapping status banners on the same
// screen. Hydration-safe: `isOnline` starts `true` (matches what SSR renders — nothing, see below)
// on both the server and the first client render, and is only corrected inside a mount effect, the
// same pattern WorkerClockPanel's own indicator already uses.
export function ConnectivityBanner() {
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    setIsOnline(navigator.onLine);
    function handleOnline() {
      setIsOnline(true);
    }
    function handleOffline() {
      setIsOnline(false);
    }
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (isOnline) {
    return null;
  }

  return (
    <div className="wk-connectivity-banner" role="status" aria-live="polite">
      Offline — clock actions on /worker are saved and will sync later. This page shows the last saved information.
    </div>
  );
}
