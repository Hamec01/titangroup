import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { resolveAppLocale } from '@/lib/i18n/server';
import { AppLocaleProvider } from '@/components/i18n/AppLocaleProvider';
import { LanguageSwitcher } from '@/components/i18n/LanguageSwitcher';
import { LogoutButton } from '@/components/admin/LogoutButton';

export default async function ForemanLayout({ children }: { children: ReactNode }) {
  const [session, locale] = await Promise.all([resolveServerSession(), resolveAppLocale()]);

  // An ADMIN/SUPER_ADMIN with no FOREMAN role and no ForemanAssignment who lands on any
  // /foreman/* route (bookmark, shared link, typed URL) hits every child page's own "access
  // denied" text, styled identically to a login failure — confusing for a non-technical admin
  // who reads it as "I can't get into the site." They already have the same functionality,
  // company-wide rather than site-scoped, under /admin — send them there instead of showing an
  // error they can't act on. Scoped to ADMIN/SUPER_ADMIN only: a WORKER, or a dual-role
  // FOREMAN+WORKER whose FOREMAN permissions were revoked, must still see each page's existing
  // access-denied text unchanged (task §3 contract — session.user.roles already reflects only
  // currently active UserRole rows, per lib/auth.ts).
  if (session && !session.user.roles.includes('FOREMAN') && (session.user.roles.includes('ADMIN') || session.user.roles.includes('SUPER_ADMIN'))) {
    redirect('/admin');
  }

  const ru = locale === 'RU';
  return (
    <AppLocaleProvider locale={locale}>
      <div className="foreman-shell">
        {session ? (
          <header className="foreman-header">
            <Link href="/foreman" className="admin-brand">Titanor Time</Link>
            <nav aria-label={ru ? 'Навигация уполномоченного' : 'Authorized reviewer navigation'}>
              <Link href="/foreman">{ru ? 'Сегодня' : 'Today'}</Link>
              <Link href="/foreman/workers">{ru ? 'Работники' : 'Workers'}</Link>
              <Link href="/foreman/review">{ru ? 'Проверка табелей' : 'Timesheet review'}</Link>
              <Link href="/foreman/attendance/exceptions">{ru ? 'Проблемы учёта' : 'Attendance issues'}</Link>
              <Link href="/foreman/reports/sites">{ru ? 'Отчёты по объектам' : 'Site reports'}</Link>
            </nav>
            <div className="admin-header-actions">
              <Link href="/guide" className="admin-guide-link">
                {ru ? 'Инструкция' : 'User guide'}
              </Link>
              <LanguageSwitcher compact />
              <LogoutButton
                signOut={ru ? 'Выйти' : 'Sign out'}
                signingOut={ru ? 'Выполняется выход…' : 'Signing out…'}
                error={ru ? 'Не удалось выйти. Проверьте соединение и попробуйте ещё раз.' : 'Could not sign out. Check your connection and try again.'}
              />
            </div>
          </header>
        ) : null}
        {children}
      </div>
    </AppLocaleProvider>
  );
}
