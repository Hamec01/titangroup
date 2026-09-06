'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import type { AdminNavStrings } from '@/lib/i18n/admin';
import type { AppLocale } from '@/lib/i18n/locale';

const STORAGE_KEY = 'titanor-admin-design';

export function AdminDesignFrame({
  children,
  header,
  legacyNav,
  nav,
  locale
}: {
  children: ReactNode;
  header: ReactNode;
  legacyNav: ReactNode;
  nav: AdminNavStrings;
  locale: AppLocale;
}) {
  const [mode, setMode] = useState<'modern' | 'classic'>('modern');
  const [mobileOpen, setMobileOpen] = useState(false);
  const ru = locale === 'RU';

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'classic' || saved === 'modern') setMode(saved);
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<'modern' | 'classic'>).detail;
      if (next === 'classic' || next === 'modern') setMode(next);
    };
    window.addEventListener('titanor-admin-design', onChange);
    return () => window.removeEventListener('titanor-admin-design', onChange);
  }, []);

  useEffect(() => setMobileOpen(false), [mode]);

  if (mode === 'classic') {
    return <div className="admin-shell admin-shell-classic">{header}{legacyNav}<div className="admin-content">{children}</div></div>;
  }

  return (
    <div className="admin-modern-shell">
      <button type="button" className="admin-mobile-menu" onClick={() => setMobileOpen(true)} aria-label={ru ? 'Открыть меню' : 'Open menu'}>☰</button>
      <aside className={mobileOpen ? 'admin-modern-sidebar is-open' : 'admin-modern-sidebar'} aria-label={ru ? 'Разделы админки' : 'Admin sections'}>
        <div className="admin-modern-brand">
          <span className="admin-brand-mark">T</span>
          <span><strong>Titanor</strong><small>Time workspace</small></span>
        </div>
        <button type="button" className="admin-sidebar-close" onClick={() => setMobileOpen(false)} aria-label={ru ? 'Закрыть меню' : 'Close menu'}>×</button>
        <Link className="admin-modern-today" href={nav.overview.href} onClick={() => setMobileOpen(false)}>
          <span className="admin-nav-icon">⌂</span>{nav.overview.label}
        </Link>
        <p className="admin-modern-label">{ru ? 'Рабочие разделы' : 'Workspace'}</p>
        <div className="admin-modern-links">
          {nav.groups.map((group) => {
            const isReports = group.key === 'reports';
            return (
              <div className="admin-modern-group" key={group.key}>
                <p className={isReports ? 'admin-modern-group-title is-report' : 'admin-modern-group-title'}><span className="admin-nav-icon">{iconForGroup(group.key)}</span>{group.label}</p>
                <div className="admin-modern-sub-links">
                  {group.items.map((item) => <Link key={item.href} href={item.href} onClick={() => setMobileOpen(false)}>{item.label}</Link>)}
                </div>
              </div>
            );
          })}
        </div>
        <div className="admin-modern-sidebar-foot">{ru ? 'Все данные защищены правами доступа' : 'All data is permission protected'}</div>
      </aside>
      {mobileOpen && <button className="admin-sidebar-backdrop" type="button" onClick={() => setMobileOpen(false)} aria-label={ru ? 'Закрыть меню' : 'Close menu'} />}
      <div className="admin-modern-main">
        <header className="admin-modern-header">
          <div className="admin-modern-header-left"><button type="button" className="admin-menu-button" onClick={() => setMobileOpen(true)} aria-label={ru ? 'Открыть меню' : 'Open menu'}>☰</button><span className="admin-modern-context">{ru ? 'Панель управления' : 'Control center'}</span></div>
          <div className="admin-modern-header-content">{header}</div>
        </header>
        <main className="admin-modern-content">{children}</main>
      </div>
    </div>
  );
}

function iconForGroup(key: string): string {
  if (key === 'setup') return '⌘';
  if (key === 'people') return '♙';
  if (key === 'time') return '◷';
  if (key === 'review') return '✓';
  if (key === 'reports') return '▥';
  return '•';
}
