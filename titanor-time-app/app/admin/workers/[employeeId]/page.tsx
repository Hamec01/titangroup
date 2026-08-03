import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { getWorkerDetail } from '@/lib/workers';
import { WorkerActions } from './WorkerActions';

export const dynamic = 'force-dynamic';

const ACTIVATION_STATUS_LABEL: Record<string, string> = {
  ALREADY_ACTIVE: 'Already active',
  READY_FOR_ACTIVATION: 'Ready — activation code can be issued',
  SETUP_INCOMPLETE: 'Setup incomplete (needs a current assignment + open payroll period)'
};

// docs/titanor-time/01_SCREEN_MAP.md §2 (/admin/workers/[employeeId]).
// "Последние Timesheet" from the screen map's data list is not shown —
// Timesheet has no real data or endpoints yet (ЭТАП 7), so this only
// renders what getWorkerDetail() actually computes from real rows, same
// "не декоративный dashboard" principle as /admin/setup.
export default async function WorkerDetailPage({ params }: { params: Promise<{ employeeId: string }> }) {
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

  const { employeeId } = await params;
  const worker = await getWorkerDetail(employeeId);

  if (!worker) {
    return (
      <main className="setup-page">
        <div className="setup-card">
          <p className="login-error" role="alert">
            No worker found with this id.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <h1>
          {worker.firstName} {worker.lastName}
        </h1>
        <p className="setup-subtitle">
          #{worker.employeeNumber} · {worker.employment?.active ? 'Active employment' : 'Employment ended'} ·{' '}
          {ACTIVATION_STATUS_LABEL[worker.activationStatus]}
        </p>

        <h2>Current assignments</h2>
        {worker.currentAssignments.length === 0 ? (
          <p>None.</p>
        ) : (
          <ul className="setup-list">
            {worker.currentAssignments.map((assignment) => (
              <li key={assignment.siteId} className="setup-item">
                <span className="setup-label">
                  {assignment.siteName}
                  {assignment.isPrimary ? ' (primary)' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}

        {worker.employment && !worker.employment.active ? (
          <p className="setup-subtitle">
            Ended {worker.employment.endDate}
            {worker.employment.deactivationReason ? ` — ${worker.employment.deactivationReason}` : ''}
          </p>
        ) : null}

        <WorkerActions worker={worker} />
      </div>
    </main>
  );
}
