import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { getSetupStatus, type SetupStatus } from '@/lib/setup-status';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §2 (/admin/setup): checklist of the
// first vertical scenario, "не декоративный dashboard" — every item below is
// a plain done/not-done flag from getSetupStatus(), no counts, no invented
// numbers. Items link only to real routes: work areas are managed within a
// site; templates have their own list at /admin/templates.
interface ChecklistItem {
  key: keyof SetupStatus;
  label: string;
  description: string;
  optional?: boolean;
  createHref: string | null;
  doneHref: string | null;
  createActionLabel?: string;
  doneActionLabel?: string;
}

const CHECKLIST: ChecklistItem[] = [
  {
    key: 'hasCity',
    label: 'City',
    description: 'Optional reference for grouping sites. It does not block setup.',
    optional: true,
    createHref: '/admin/cities/new',
    doneHref: '/admin/cities/new',
    doneActionLabel: 'Add another'
  },
  {
    key: 'hasSite',
    label: 'Site',
    description: 'The actual workplace a worker can be assigned to and check in at.',
    createHref: '/admin/sites/new',
    doneHref: '/admin/sites'
  },
  {
    key: 'hasWorkArea',
    label: 'Work area',
    description: 'Optional subdivision inside a site. Skip it when the whole site is one work area.',
    optional: true,
    createHref: '/admin/sites',
    doneHref: '/admin/sites',
    createActionLabel: 'Manage sites'
  },
  {
    key: 'hasTemplate',
    label: 'Work schedule template',
    description: 'Defines the worker\'s usual working week.',
    createHref: '/admin/templates/new',
    doneHref: '/admin/templates'
  },
  {
    key: 'hasWorker',
    label: 'Worker',
    description: 'Employee account that will use Check In/Out and enter hours.',
    createHref: '/admin/workers/new',
    doneHref: '/admin/workers'
  },
  {
    key: 'hasAssignment',
    label: 'Assignment',
    description: 'Connects a worker to a site and schedule for a date range.',
    createHref: '/admin/assignments/new',
    doneHref: '/admin/assignments'
  },
  {
    key: 'hasSubmissionScheduleConfigured',
    label: 'Timesheet submission cycle',
    description: 'Choose Weekly or Every two weeks on each active worker. Payroll periods are then created automatically.',
    createHref: '/admin/workers',
    doneHref: '/admin/workers',
    createActionLabel: 'Configure workers'
  }
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
            const actionLabel = done ? (item.doneActionLabel ?? 'Manage') : (item.createActionLabel ?? 'Create');
            return (
              <li key={item.key} className="setup-item">
                <span
                  className={done ? 'setup-status setup-status-done' : item.optional ? 'setup-status setup-status-optional' : 'setup-status setup-status-pending'}
                >
                  {done ? 'Done' : item.optional ? 'Optional' : 'Not done'}
                </span>
                <span className="setup-copy">
                  <span className="setup-label">{item.label}</span>
                  <span className="setup-description">{item.description}</span>
                </span>
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
