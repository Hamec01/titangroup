import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { InstallPrompt } from '@/components/worker-pwa/InstallPrompt';

// docs/titanor-time/T8_PWA_DESIGN.md §C.1/§C.2 — same session/role gate as app/worker/page.tsx
// (no session → /login; wrong role → in-page "Access denied", not a redirect). Static SSR shell —
// zero window/navigator/user-agent reads anywhere in this file; all browser-capability detection
// lives in the one Client Component below, inside its own mount effect.
export default async function WorkerInstallPage() {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }

  if (!session.user.roles.includes('WORKER')) {
    return (
      <main className="wk-page">
        <p className="login-error" role="alert">
          Access denied — this page requires the WORKER role.
        </p>
      </main>
    );
  }

  return (
    <main className="wk-page">
      <div className="wk-card pwa-install-card">
        <h1>Install Titanor Time</h1>
        <p className="pwa-install-lead">Add Titanor Time to your home screen for one-tap access and a working clock screen even when you lose signal.</p>
        <ul className="pwa-install-benefits">
          <li>Opens straight to your clock — no address bar, no browser tabs.</li>
          <li>Check in and out still works after a full network drop, once set up.</li>
          <li>No extra download — it installs directly from this page.</li>
        </ul>
        <InstallPrompt />
        <Link href="/worker" className="wk-back-link">
          ← Back to clock
        </Link>
      </div>
    </main>
  );
}
