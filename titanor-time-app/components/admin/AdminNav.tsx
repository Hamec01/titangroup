'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { AdminNavStrings } from '@/lib/i18n/admin';

// Grouped dropdown nav for /admin — replaces a flat 15-link row (see lib/i18n/admin.ts's own
// comment for why). Presentation only: every link is an existing route, nothing added/removed.
// Click-to-toggle (not hover-only) so it works the same on touch devices; closes on outside
// click, Escape, or route change so it never gets left open across a navigation.
export function AdminNav({ strings, ariaLabel }: { strings: AdminNavStrings; ariaLabel: string }) {
  const pathname = usePathname();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setOpenKey(null);
  }, [pathname]);

  useEffect(() => {
    function onDocPointerDown(event: MouseEvent) {
      if (navRef.current && !navRef.current.contains(event.target as Node)) {
        setOpenKey(null);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpenKey(null);
      }
    }
    document.addEventListener('mousedown', onDocPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  function isActiveHref(href: string): boolean {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <nav className="admin-nav" aria-label={ariaLabel} ref={navRef}>
      <div className="admin-nav-inner">
        <Link
          href={strings.overview.href}
          className={pathname === strings.overview.href ? 'admin-nav-top admin-nav-top-active' : 'admin-nav-top'}
        >
          {strings.overview.label}
        </Link>
        {strings.groups.map((group) => {
          const groupActive = group.items.some((item) => isActiveHref(item.href));
          const open = openKey === group.key;
          return (
            <div className="admin-nav-group" key={group.key}>
              <button
                type="button"
                className={groupActive ? 'admin-nav-top admin-nav-group-trigger admin-nav-top-active' : 'admin-nav-top admin-nav-group-trigger'}
                aria-haspopup="true"
                aria-expanded={open}
                onClick={() => setOpenKey(open ? null : group.key)}
              >
                {group.label}
                <span className="admin-nav-caret" aria-hidden="true">
                  ▾
                </span>
              </button>
              {open ? (
                <div className="admin-nav-menu" role="menu">
                  {group.items.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      role="menuitem"
                      className={isActiveHref(item.href) ? 'admin-nav-menu-link admin-nav-menu-link-active' : 'admin-nav-menu-link'}
                      onClick={() => setOpenKey(null)}
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
