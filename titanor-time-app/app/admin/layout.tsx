import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { resolveAppLocale } from '@/lib/i18n/server';
import { ADMIN_STRINGS, ADMIN_NAV } from '@/lib/i18n/admin';
import { AppLocaleProvider } from '@/components/i18n/AppLocaleProvider';
import { LanguageSwitcher } from '@/components/i18n/LanguageSwitcher';
import { AdminNav } from '@/components/admin/AdminNav';
import { LogoutButton } from '@/components/admin/LogoutButton';
import { NotificationCenter } from '@/components/admin/NotificationCenter';
import { ReviewQueueIndicator } from '@/components/admin/ReviewQueueIndicator';

export default async function AdminLayout({ children }: Readonly<{ children: ReactNode }>) {
  const [session, locale] = await Promise.all([resolveServerSession(), resolveAppLocale()]);
  const t = ADMIN_STRINGS[locale];
  if (!session) {
    redirect('/login');
  }

  const isAdmin = session.user.roles.includes('ADMIN') || session.user.roles.includes('SUPER_ADMIN');
  if (!isAdmin) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          {t.accessDenied}
        </p>
      </main>
    );
  }

  return (
    <AppLocaleProvider locale={locale}>
    <div className="admin-shell">
      <header className="admin-header">
        <Link className="admin-brand" href="/admin">
          Titanor Time
        </Link>
        <span className="admin-identity">
          {session.user.username} · {session.user.roles.join(', ')}
        </span>
        <div className="admin-header-actions">
          <Link href="/guide" className="admin-guide-link">
            {t.guideLink}
          </Link>
          <ReviewQueueIndicator locale={locale} />
          <NotificationCenter strings={t} locale={locale} />
          <LanguageSwitcher compact />
          <LogoutButton signOut={t.signOut} signingOut={t.signingOut} error={t.signOutError} />
        </div>
      </header>
      <AdminNav strings={ADMIN_NAV[locale]} ariaLabel={t.adminNavigation} />
      <div className="admin-content">{children}</div>
    </div>
    </AppLocaleProvider>
  );
}
