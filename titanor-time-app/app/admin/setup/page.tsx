import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { getSetupStatus, type SetupStatus } from '@/lib/setup-status';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §2 (/admin/setup): checklist of the
// first vertical scenario, "не декоративный dashboard" — every item below is
// a plain done/not-done flag from getSetupStatus(), no counts, no invented
// numbers. hasCity/hasWorkArea have no dedicated "create" destination per
// the screen map's own "Куда" list (city is optional; work areas are
// created within a site, not from a standalone page) — shown status-only,
// not linked, rather than inventing a route the docs don't specify.
interface ChecklistItem {
  key: keyof SetupStatus;
  label: string;
  href: string | null;
}

const CHECKLIST: ChecklistItem[] = [
  { key: 'hasCity', label: 'City (optional)', href: null },
  { key: 'hasSite', label: 'Site', href: '/admin/sites/new' },
  { key: 'hasWorkArea', label: 'Work area', href: null },
  { key: 'hasTemplate', label: 'Work schedule template', href: '/admin/templates/new' },
  { key: 'hasWorker', label: 'Worker', href: '/admin/workers/new' },
  { key: 'hasAssignment', label: 'Assignment', href: '/admin/assignments/new' },
  { key: 'hasOpenPeriod', label: 'Open payroll period', href: '/admin/periods' }
];

export default async function AdminSetupPage() {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }

  const isAdmin = session.user.roles.includes('ADMIN') || session.user.roles.includes('SUPER_ADMIN');
  if (!isAdmin) {
    return (
      <main className="setup-page">
        <p className="login-error" role="alert">
          Access denied — this page requires the ADMIN or SUPER_ADMIN role.
        </p>
      </main>
    );
  }

  const status = await getSetupStatus();

  return (
    <main className="setup-page">
      <div className="setup-card">
        <h1>Setup checklist</h1>
        <p className="setup-subtitle">
          Signed in as {session.user.username} ({session.user.roles.join(', ')})
        </p>
        <ul className="setup-list">
          {CHECKLIST.map((item) => {
            const done = status[item.key];
            return (
              <li key={item.key} className="setup-item">
                <span className={done ? 'setup-status setup-status-done' : 'setup-status setup-status-pending'}>
                  {done ? 'Done' : 'Not done'}
                </span>
                <span className="setup-label">{item.label}</span>
                {!done && item.href ? (
                  <a className="setup-action" href={item.href}>
                    Create
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </main>
  );
}
