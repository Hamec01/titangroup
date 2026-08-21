'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { WorkerLink } from '@/components/worker-pwa/WorkerLink';
import { LanguageSwitcher } from '@/components/i18n/LanguageSwitcher';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { COMMON_STRINGS } from '@/lib/i18n/common';

const CSRF_HEADER_VALUE = 'titanor-time';

export function WorkerAppNavigation({ username }: { username: string }) {
  const locale = useAppLocale();
  const t = COMMON_STRINGS[locale];
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const pendingRef = useRef(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  async function logout() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setLogoutPending(true);
    setLogoutError(null);
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'X-Requested-With': CSRF_HEADER_VALUE }
      });
      if (!response.ok) throw new Error('LOGOUT_FAILED');
      router.replace('/login');
      router.refresh();
    } catch {
      setLogoutError(t.navSignOutError);
      pendingRef.current = false;
      setLogoutPending(false);
    }
  }

  return (
    <header className="wk-app-header">
      <div className="wk-app-header-inner">
        <WorkerLink href="/worker" className="wk-app-brand" aria-label={`Titanor Time — ${t.navHome}`}>
          Titanor Time
        </WorkerLink>
        <div className="wk-app-header-actions">
          {pathname !== '/worker' ? (
            <WorkerLink href="/worker" className="wk-home-button" aria-label={t.backToClock}>
              <span aria-hidden="true">⌂</span>
              <span>{t.navHome}</span>
            </WorkerLink>
          ) : null}
          <button
            type="button"
            className="wk-menu-button"
            aria-expanded={open}
            aria-controls="worker-app-menu"
            aria-label={open ? t.navCloseMenu : t.navOpenMenu}
            onClick={() => setOpen((value) => !value)}
          >
            <span aria-hidden="true">{open ? '×' : '☰'}</span>
          </button>
        </div>
      </div>

      {open ? (
        <>
          <button type="button" className="wk-menu-backdrop" aria-hidden="true" tabIndex={-1} onClick={() => setOpen(false)} />
          <nav id="worker-app-menu" className="wk-app-menu" aria-label={locale === 'RU' ? 'Навигация работника' : 'Worker navigation'}>
            <p className="wk-menu-account">
              {t.navSignedInAs} <strong>{username}</strong>
            </p>
            <WorkerLink href="/worker" className="wk-menu-link" aria-current={pathname === '/worker' ? 'page' : undefined}>
              {t.navHome}
            </WorkerLink>
            <WorkerLink
              href="/worker/periods"
              className="wk-menu-link"
              aria-current={pathname.startsWith('/worker/periods') ? 'page' : undefined}
            >
              {t.navCalendarAndHours}
            </WorkerLink>
            <WorkerLink href="/worker/history" className="wk-menu-link" aria-current={pathname === '/worker/history' ? 'page' : undefined}>
              {t.navHistory}
            </WorkerLink>
            <WorkerLink href="/worker/install" className="wk-menu-link" aria-current={pathname === '/worker/install' ? 'page' : undefined}>
              {t.navInstallApp}
            </WorkerLink>
            <div className="wk-menu-language">
              <span>{t.navLanguage}</span>
              <LanguageSwitcher compact />
            </div>
            <button type="button" className="wk-menu-logout" disabled={logoutPending} onClick={logout}>
              {logoutPending ? t.navSigningOut : t.navSignOut}
            </button>
            {logoutError ? (
              <p className="wk-menu-error" role="alert">
                {logoutError}
              </p>
            ) : null}
          </nav>
        </>
      ) : null}
    </header>
  );
}
