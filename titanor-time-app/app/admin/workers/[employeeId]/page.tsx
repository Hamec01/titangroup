import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { getWorkerDetail, helsinkiToday } from '@/lib/workers';
import { NewAssignmentForm } from '@/app/admin/assignments/new/NewAssignmentForm';
import { WorkerActions } from './WorkerActions';
import { WorkerSubmissionScheduleForm } from './WorkerSubmissionScheduleForm';
import { getWorkerSubmissionScheduleView } from '@/lib/timesheet-submission-schedules';

export const dynamic = 'force-dynamic';

const ACTIVATION_STATUS_LABEL: Record<string, string> = {
  ALREADY_ACTIVE: 'Already active',
  READY_FOR_ACTIVATION: 'Ready — activation code can be issued',
  SETUP_INCOMPLETE: 'Setup incomplete — follow the steps below'
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

  const submissionSchedule = await getWorkerSubmissionScheduleView(employeeId);

  return (
    <main className="setup-page">
      <div className="setup-card worker-card">
        <p className="setup-subtitle"><Link href="/admin">← Back to Today</Link></p>
        <h1>
          {worker.firstName} {worker.lastName}
        </h1>
        <p className="setup-subtitle">
          Employee number: {worker.employeeNumber} · Login username: {worker.username} ·{' '}
          {worker.employment?.active ? 'Active employment' : 'Employment ended'} ·{' '}
          {ACTIVATION_STATUS_LABEL[worker.activationStatus]}
        </p>
        <p>
          <Link href={`/admin/reports?employeeId=${employeeId}`}>View time report</Link>
        </p>
        <p>
          <Link href={`/admin/workers/${employeeId}/locations`}>View Check In/Out locations on map</Link>
        </p>

        <h2>Current assignments</h2>
        {worker.currentAssignments.length === 0 ? (
          <div className="worker-setup-callout">
            <p>None yet. The worker may activate and install the app now; the app will explain that no site has been assigned.</p>
          </div>
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

        <section className="worker-work-setup">
          <h2>Add a site and work schedule</h2>
          <p className="setup-subtitle">
            Choose the worker&apos;s site, optional work area, schedule template and start date here. You do not need to leave this worker page.
          </p>
          <NewAssignmentForm
            initialEmployeeId={worker.id}
            initialValidFrom={helsinkiToday().toISOString().slice(0, 10)}
            initialIsPrimary={worker.currentAssignments.length === 0}
            returnEmployeeId={worker.id}
            lockEmployee
          />
        </section>

        {submissionSchedule ? (
          <section className="worker-work-setup">
            <h2>Timesheet submission</h2>
            <p className="setup-subtitle">Choose whether this worker submits every week or every two weeks. Periods are prepared automatically.</p>
            <WorkerSubmissionScheduleForm employeeId={worker.id} view={submissionSchedule} />
          </section>
        ) : null}

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
