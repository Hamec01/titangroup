import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { resolveAppLocale } from '@/lib/i18n/server';
import { ADMIN_STRINGS } from '@/lib/i18n/admin';
import { AppLocaleProvider } from '@/components/i18n/AppLocaleProvider';
import { LanguageSwitcher } from '@/components/i18n/LanguageSwitcher';

const ADMIN_NAVIGATION = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/setup', label: 'Setup' },
  { href: '/admin/workers', label: 'Workers' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/sites', label: 'Sites' },
  { href: '/admin/templates', label: 'Templates' },
  { href: '/admin/assignments', label: 'Assignments' },
  { href: '/admin/periods', label: 'Periods' },
  { href: '/admin/timesheets', label: 'Timesheets' },
  { href: '/admin/reports', label: 'Reports' },
  { href: '/admin/review-scopes', label: 'Review' },
  { href: '/admin/corrections', label: 'Corrections' },
  { href: '/admin/export', label: 'Exports' },
  { href: '/admin/attendance/exceptions', label: 'Attendance exceptions' },
  { href: '/admin/attendance/policy', label: 'Attendance policy' }
] as const;

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
        <LanguageSwitcher compact />
      </header>
      <nav className="admin-nav" aria-label={t.adminNavigation}>
        <div className="admin-nav-inner">
          {ADMIN_NAVIGATION.map((item) => (
            <Link key={item.href} href={item.href}>
              {t.nav[item.label] ?? item.label}
            </Link>
          ))}
        </div>
      </nav>
      <div className="admin-content">{children}</div>
    </div>
    </AppLocaleProvider>
  );
}
