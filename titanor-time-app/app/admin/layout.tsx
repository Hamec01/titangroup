import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';

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
  { href: '/admin/review-scopes', label: 'Review' },
  { href: '/admin/corrections', label: 'Corrections' },
  { href: '/admin/attendance/exceptions', label: 'Attendance exceptions' }
] as const;

export default async function AdminLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }

  const isAdmin = session.user.roles.includes('ADMIN') || session.user.roles.includes('SUPER_ADMIN');
  if (!isAdmin) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          Access denied — this area requires the ADMIN or SUPER_ADMIN role.
        </p>
      </main>
    );
  }

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <Link className="admin-brand" href="/admin">
          Titanor Time
        </Link>
        <span className="admin-identity">
          {session.user.username} · {session.user.roles.join(', ')}
        </span>
      </header>
      <nav className="admin-nav" aria-label="Admin navigation">
        <div className="admin-nav-inner">
          {ADMIN_NAVIGATION.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </div>
      </nav>
      <div className="admin-content">{children}</div>
    </div>
  );
}
