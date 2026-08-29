import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ServiceWorkerRegistration } from '@/components/worker-pwa/ServiceWorkerRegistration';
import { PullToRefresh } from '@/components/worker-pwa/PullToRefresh';
import { WorkerAppNavigation } from '@/components/worker-pwa/WorkerAppNavigation';
import { resolveServerSession } from '@/lib/server-session';
import { resolveAppLocale } from '@/lib/i18n/server';
import { AppLocaleProvider } from '@/components/i18n/AppLocaleProvider';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10C.1" §C — the PWA manifest
// link and service worker registration are scoped to the /worker* prefix ONLY via this nested
// layout, never added to the app-wide root layout. Next.js merges this `metadata.manifest` into
// <head> only for routes under this layout.
//
// docs/titanor-time/T8_PWA_DESIGN.md §B — `icons.apple`/`appleWebApp` close a real iOS
// installability/fidelity gap (no apple-touch-icon or apple-mobile-web-app-capable existed
// anywhere before this slice). Scoped here for the same reason as `manifest` above — the root
// layout defines neither field, so /admin, /foreman, /login inherit none of this.
export const metadata: Metadata = {
  manifest: '/manifest.webmanifest',
  icons: {
    apple: { url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }
  },
  appleWebApp: {
    capable: true,
    title: 'Titanor Time',
    statusBarStyle: 'black-translucent'
  }
};

// `themeColor` moved out of `Metadata` into a separate `Viewport` export per Next.js's current
// contract (metadata.themeColor is deprecated) — matches manifest.webmanifest's own theme_color.
export const viewport: Viewport = {
  themeColor: '#05070b'
};

export default async function WorkerLayout({ children }: { children: ReactNode }) {
  const [session, locale] = await Promise.all([resolveServerSession(), resolveAppLocale()]);
  const workerSession = session?.user.roles.includes('WORKER') ? session : null;

  return (
    <AppLocaleProvider locale={locale}>
      <ServiceWorkerRegistration />
      {workerSession ? (
        <div className="wk-app-shell">
          <PullToRefresh />
          <WorkerAppNavigation username={workerSession.user.username} />
          <div className="wk-app-content">{children}</div>
        </div>
      ) : (
        children
      )}
    </AppLocaleProvider>
  );
}
