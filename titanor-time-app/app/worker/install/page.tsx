import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { InstallPrompt } from '@/components/worker-pwa/InstallPrompt';
import { resolveAppLocale } from '@/lib/i18n/server';
import { COMMON_STRINGS } from '@/lib/i18n/common';
import { WORKER_STRINGS } from '@/lib/i18n/worker';

// docs/titanor-time/T8_PWA_DESIGN.md §C.1/§C.2 — same session/role gate as app/worker/page.tsx
// (no session → /login; wrong role → in-page "Access denied", not a redirect). Static SSR shell —
// zero window/navigator/user-agent reads anywhere in this file; all browser-capability detection
// lives in the one Client Component below, inside its own mount effect.
export default async function WorkerInstallPage() {
  const [session, locale] = await Promise.all([resolveServerSession(), resolveAppLocale()]);
  const common = COMMON_STRINGS[locale];
  const t = WORKER_STRINGS[locale];
  if (!session) {
    redirect('/login');
  }

  if (!session.user.roles.includes('WORKER')) {
    return (
      <main className="wk-page">
        <p className="login-error" role="alert">
          {common.accessDeniedWorker}
        </p>
      </main>
    );
  }

  return (
    <main className="wk-page">
      <div className="wk-card pwa-install-card">
        <h1>{t.installTitle}</h1>
        <p className="pwa-install-lead">{t.installLead}</p>
        <ul className="pwa-install-benefits">
          <li>{t.installBenefit1}</li>
          <li>{t.installBenefit2}</li>
          <li>{t.installBenefit3}</li>
        </ul>
        <InstallPrompt />
        <Link href="/worker" className="wk-back-link">
          {common.backToClock}
        </Link>
      </div>
    </main>
  );
}
