'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { WorkerLink } from '@/components/worker-pwa/WorkerLink';

const CSRF_HEADER_VALUE = 'titanor-time';

export function WorkerAppNavigation({ username }: { username: string }) {
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
      setLogoutError('Could not sign out. Check your connection and try again.');
      pendingRef.current = false;
      setLogoutPending(false);
    }
  }

  return (
    <header className="wk-app-header">
      <div className="wk-app-header-inner">
        <WorkerLink href="/worker" className="wk-app-brand" aria-label="Titanor Time home">
          Titanor Time
        </WorkerLink>
        <button
          type="button"
          className="wk-menu-button"
          aria-expanded={open}
          aria-controls="worker-app-menu"
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden="true">{open ? '×' : '☰'}</span>
        </button>
      </div>

      {open ? (
        <>
          <button type="button" className="wk-menu-backdrop" aria-hidden="true" tabIndex={-1} onClick={() => setOpen(false)} />
          <nav id="worker-app-menu" className="wk-app-menu" aria-label="Worker navigation">
            <p className="wk-menu-account">
              Signed in as <strong>{username}</strong>
            </p>
            <WorkerLink href="/worker" className="wk-menu-link" aria-current={pathname === '/worker' ? 'page' : undefined}>
              Home
            </WorkerLink>
            <WorkerLink
              href="/worker/periods"
              className="wk-menu-link"
              aria-current={pathname.startsWith('/worker/periods') ? 'page' : undefined}
            >
              Calendar and hours
            </WorkerLink>
            <WorkerLink href="/worker/history" className="wk-menu-link" aria-current={pathname === '/worker/history' ? 'page' : undefined}>
              History
            </WorkerLink>
            <WorkerLink href="/worker/install" className="wk-menu-link" aria-current={pathname === '/worker/install' ? 'page' : undefined}>
              Install app
            </WorkerLink>
            <button type="button" className="wk-menu-logout" disabled={logoutPending} onClick={logout}>
              {logoutPending ? 'Signing out…' : 'Sign out'}
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
