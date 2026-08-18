'use client';

import { useEffect } from 'react';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10C.1" §C — registers
// public/sw.js with scope '/worker' (no trailing slash — Next.js serves the worker clock page at
// the bare path '/worker', and Service Worker scope matching is a literal string-prefix check:
// '/worker/' would exclude '/worker' itself, since "/worker".startsWith("/worker/") is false). The
// scope itself (a browser-enforced boundary, not just application logic) is what makes it
// structurally impossible for this service worker to ever intercept /admin/**, /foreman/**,
// /login, /api/**, or anything else outside the /worker* prefix — on top of the allowlist the
// worker script itself implements. No-op (renders nothing, does nothing) in any browser without
// Service Worker support.
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
      return;
    }
    navigator.serviceWorker.register('/sw.js', { scope: '/worker' }).catch(() => {
      // Registration failure (unsupported browser, blocked by policy, etc.) degrades gracefully —
      // the app remains fully usable online; it just cannot serve an offline cold start.
    });
  }, []);

  return null;
}
