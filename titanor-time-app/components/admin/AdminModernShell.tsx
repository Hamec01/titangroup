'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { AdminNavStrings } from '@/lib/i18n/admin';
import type { AppLocale } from '@/lib/i18n/locale';

// docs/titanor-time/REPORT_REDESIGN_PRODUCTION_READINESS_RU.md §4. The MODERN admin shell only —
// the classic shell is server-rendered directly in app/admin/layout.tsx from the design cookie,
// so there is no client flash and no dependency of the classic layout on this component.
// This component owns the mobile menu (open/close, Escape closes it, focus returns to the
// trigger, backdrop) and the active-section highlight.

function iconForGroup(key: string): string {
  if (key === 'setup') return '⌘';
  if (key === 'people') return '♙';
  if (key === 'time') return '◷';
  if (key === 'review') return '✓';
  if (key === 'reports') return '▥';
  return '•';
}

export function AdminModernShell({
  children,
  header,
  nav,
  locale
}: {
  children: ReactNode;
  header: ReactNode;
  nav: AdminNavStrings;
  locale: AppLocale;
}) {
  const ru = locale === 'RU';
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sidebarId = useId();

  // Close on navigation.
  useEffect(() => setMobileOpen(false), [pathname]);

  // Escape closes the mobile menu and returns focus to the trigger (§4.8).
  useEffect(() => {
    if (!mobileOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMobileOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  const isActive = (href: string): boolean => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="admin-modern-shell" data-mobile-open={mobileOpen ? 'true' : undefined}>
      <aside
        id={sidebarId}
        className={mobileOpen ? 'admin-modern-sidebar is-open' : 'admin-modern-sidebar'}
        aria-label={ru ? 'Разделы админки' : 'Admin sections'}
      >
        <div className="admin-modern-brand">
          <span className="admin-brand-mark">T</span>
          <span>
            <strong>Titanor</strong>
            <small>Time workspace</small>
          </span>
        </div>
        <button
          type="button"
          className="admin-sidebar-close"
          onClick={() => {
            setMobileOpen(false);
            triggerRef.current?.focus();
          }}
          aria-label={ru ? 'Закрыть меню' : 'Close menu'}
        >
          ×
        </button>
        <Link
          className={isActive(nav.overview.href) && pathname === nav.overview.href ? 'admin-modern-today is-current' : 'admin-modern-today'}
          href={nav.overview.href}
          aria-current={pathname === nav.overview.href ? 'page' : undefined}
        >
          <span className="admin-nav-icon">⌂</span>
          {nav.overview.label}
        </Link>
        <p className="admin-modern-label">{ru ? 'Рабочие разделы' : 'Workspace'}</p>
        <div className="admin-modern-links">
          {nav.groups.map((group) => (
            <div className="admin-modern-group" key={group.key}>
              <p className={group.key === 'reports' ? 'admin-modern-group-title is-report' : 'admin-modern-group-title'}>
                <span className="admin-nav-icon">{iconForGroup(group.key)}</span>
                {group.label}
              </p>
              <div className="admin-modern-sub-links">
                {group.items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={isActive(item.href) ? 'is-current' : undefined}
                    aria-current={isActive(item.href) ? 'page' : undefined}
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="admin-modern-sidebar-foot">{ru ? 'Все данные защищены правами доступа' : 'All data is permission protected'}</div>
      </aside>

      {mobileOpen && (
        <button
          className="admin-sidebar-backdrop"
          type="button"
          onClick={() => {
            setMobileOpen(false);
            triggerRef.current?.focus();
          }}
          aria-label={ru ? 'Закрыть меню' : 'Close menu'}
        />
      )}

      <div className="admin-modern-main">
        <header className="admin-modern-header">
          <div className="admin-modern-header-left">
            <button
              ref={triggerRef}
              type="button"
              className="admin-menu-button"
              onClick={() => setMobileOpen(true)}
              aria-expanded={mobileOpen}
              aria-controls={sidebarId}
              aria-label={ru ? 'Открыть меню' : 'Open menu'}
            >
              ☰
            </button>
            <span className="admin-modern-context">{ru ? 'Панель управления' : 'Control center'}</span>
          </div>
          <div className="admin-modern-header-content">{header}</div>
        </header>
        <main className="admin-modern-content">{children}</main>
      </div>
    </div>
  );
}
