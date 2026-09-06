import type { ReactNode } from 'react';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { resolveAppLocale } from '@/lib/i18n/server';
import { ADMIN_STRINGS, ADMIN_NAV } from '@/lib/i18n/admin';
import { ADMIN_DESIGN_COOKIE, normalizeAdminDesignMode } from '@/lib/admin-design';
import { AppLocaleProvider } from '@/components/i18n/AppLocaleProvider';
import { LanguageSwitcher } from '@/components/i18n/LanguageSwitcher';
import { AdminNav } from '@/components/admin/AdminNav';
import { LogoutButton } from '@/components/admin/LogoutButton';
import { NotificationCenter } from '@/components/admin/NotificationCenter';
import { ReviewQueueIndicator } from '@/components/admin/ReviewQueueIndicator';
import { AdminModernShell } from '@/components/admin/AdminModernShell';
import { AdminDesignToggle } from '@/components/admin/AdminDesignToggle';

export default async function AdminLayout({ children }: Readonly<{ children: ReactNode }>) {
  const [session, locale, cookieStore] = await Promise.all([resolveServerSession(), resolveAppLocale(), cookies()]);
  const designMode = normalizeAdminDesignMode(cookieStore.get(ADMIN_DESIGN_COOKIE)?.value);
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

  // Shared header actions — identical content in both shells, only the surrounding chrome differs.
  const headerActions = (
    <div className="admin-header-actions">
      <AdminDesignToggle mode={designMode} />
      <Link href="/admin/profile" className="admin-guide-link">
        {t.profileLink}
      </Link>
      <Link href="/guide" className="admin-guide-link">
        {t.guideLink}
      </Link>
      <ReviewQueueIndicator locale={locale} />
      <NotificationCenter strings={t} locale={locale} />
      <LanguageSwitcher compact />
      <LogoutButton signOut={t.signOut} signingOut={t.signingOut} error={t.signOutError} />
    </div>
  );

  if (designMode === 'classic') {
    // Byte-for-byte the pre-redesign shell (admin-shell > admin-header > brand / identity /
    // actions, then AdminNav, then admin-content) plus the design toggle inside the actions.
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
            {headerActions}
          </header>
          <AdminNav strings={ADMIN_NAV[locale]} ariaLabel={t.adminNavigation} />
          <div className="admin-content">{children}</div>
        </div>
      </AppLocaleProvider>
    );
  }

  const modernHeader = (
    <>
      <Link className="admin-brand" href="/admin">
        Titanor Time
      </Link>
      <span className="admin-identity">
        {session.user.username} · {session.user.roles.join(', ')}
      </span>
      {headerActions}
    </>
  );

  return (
    <AppLocaleProvider locale={locale}>
      <AdminModernShell header={modernHeader} nav={ADMIN_NAV[locale]} locale={locale}>
        {children}
      </AdminModernShell>
    </AppLocaleProvider>
  );
}
