import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { getSetupStatus, type SetupStatus } from '@/lib/setup-status';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §2 (/admin/setup): checklist of the
// first vertical scenario, "не декоративный dashboard" — every item below is
// a plain done/not-done flag from getSetupStatus(), no counts, no invented
// numbers. Items link only to real routes: work areas are managed within a
// site, while templates currently support creating another template but do
// not yet have a separate list screen.
interface ChecklistItem {
  key: keyof SetupStatus;
  label: string;
  createHref: string | null;
  doneHref: string | null;
  doneActionLabel?: string;
}

const CHECKLIST: ChecklistItem[] = [
  { key: 'hasCity', label: 'City (optional)', createHref: null, doneHref: null },
  { key: 'hasSite', label: 'Site', createHref: '/admin/sites/new', doneHref: '/admin/sites' },
  { key: 'hasWorkArea', label: 'Work area', createHref: '/admin/sites', doneHref: '/admin/sites' },
  {
    key: 'hasTemplate',
    label: 'Work schedule template',
    createHref: '/admin/templates/new',
    doneHref: '/admin/templates/new',
    doneActionLabel: 'Create another'
  },
  { key: 'hasWorker', label: 'Worker', createHref: '/admin/workers/new', doneHref: '/admin/workers' },
  {
    key: 'hasAssignment',
    label: 'Assignment',
    createHref: '/admin/assignments/new',
    doneHref: '/admin/assignments'
  },
  { key: 'hasOpenPeriod', label: 'Open payroll period', createHref: '/admin/periods', doneHref: '/admin/periods' }
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
            const actionHref = done ? item.doneHref : item.createHref;
            const actionLabel = done ? (item.doneActionLabel ?? 'Manage') : 'Create';
            return (
              <li key={item.key} className="setup-item">
                <span className={done ? 'setup-status setup-status-done' : 'setup-status setup-status-pending'}>
                  {done ? 'Done' : 'Not done'}
                </span>
                <span className="setup-label">{item.label}</span>
                {actionHref ? (
                  <Link className="setup-action" href={actionHref}>
                    {actionLabel}
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </main>
  );
}
