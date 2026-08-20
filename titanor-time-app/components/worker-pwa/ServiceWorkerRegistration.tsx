'use client';

import { useEffect } from 'react';
import { setSwRegistrationOutcome } from '@/lib/offline-outbox/sw-registration-outcome';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10C.1" §C — registers
// public/sw.js with scope '/worker' (no trailing slash — Next.js serves the worker clock page at
// the bare path '/worker', and Service Worker scope matching is a literal string-prefix check:
// '/worker/' would exclude '/worker' itself, since "/worker".startsWith("/worker/") is false). The
// scope itself (a browser-enforced boundary, not just application logic) is what makes it
// structurally impossible for this service worker to ever intercept /admin/**, /foreman/**,
// /login, /api/**, or anything else outside the /worker* prefix — on top of the allowlist the
// worker script itself implements. No-op (renders nothing, does nothing) in any browser without
// Service Worker support.
//
// docs/titanor-time/T8_PWA_DESIGN.md §C.5 — also records the outcome (success/unsupported/error)
// into a tiny decoupled module so components/worker-pwa/InstallPrompt.tsx can show a friendly note
// when appropriate. This is purely additive — the registration call and its silent-degrade
// behavior for the online clock are unchanged.
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
      setSwRegistrationOutcome('unsupported');
      return;
    }
    navigator.serviceWorker
      .register('/sw.js', { scope: '/worker' })
      .then(() => {
        setSwRegistrationOutcome('success');
      })
      .catch(() => {
        // Registration failure (unsupported browser, blocked by policy, etc.) degrades gracefully —
        // the app remains fully usable online; it just cannot serve an offline cold start.
        setSwRegistrationOutcome('error');
      });
  }, []);

  return null;
}
