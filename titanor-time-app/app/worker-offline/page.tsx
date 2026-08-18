import { OfflineShellClient } from './OfflineShellClient';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10C.1" §C — deliberately NOT
// `dynamic = 'force-dynamic'`, no cookies()/headers()/resolveServerSession() call anywhere in this
// tree. This route has zero per-request personalization — every visitor gets the byte-identical
// static HTML, which is exactly what makes it safe for the service worker to cache (public/sw.js)
// as the offline fallback for /worker navigation. All real personalization (who is this worker,
// what did they last check into) is read client-side from IndexedDB by OfflineShellClient, never
// baked into this page's own server-rendered markup.
export default function WorkerOfflineShellPage() {
  return (
    <main className="wk-page">
      <OfflineShellClient />
    </main>
  );
}
