import Link from 'next/link';
import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { listActionablePeriods, listWorkerCurrentAssignments } from '@/lib/worker-context';
import { helsinkiToday } from '@/lib/workers';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §3 `/worker/periods/[periodId]` — "финальная
// точка первого вертикального сценария": объект(ы), рабочая область, шаблон и
// статус табеля этого периода. Editable statuses (DRAFT/RETURNED) get an "Enter
// hours" link to .../hours — not built yet (ЭТАП 7's next slice after this one),
// same as this project's established precedent for a real link to a destination
// not yet built (see IMPLEMENTATION_STATUS.md on /admin/setup's Create-links).
const EDITABLE_STATUSES = new Set(['DRAFT', 'RETURNED']);
const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Not started',
  RETURNED: 'Returned — needs your attention',
  SUBMITTED: 'Submitted — awaiting review',
  FOREMAN_APPROVED: 'Approved by foreman'
};

type RouteParams = { params: Promise<{ periodId: string }> };

export default async function WorkerPeriodDetailPage({ params }: RouteParams) {
  const session = await resolveServerSession();
  if (!session) {
    redirect('/login');
  }

  if (!session.user.roles.includes('WORKER')) {
    return (
      <main className="wk-page">
        <p className="login-error" role="alert">
          Access denied — this page requires the WORKER role.
        </p>
      </main>
    );
  }
  if (!session.user.employeeId) {
    return (
      <main className="wk-page">
        <div className="wk-card">
          <p>Your account has no linked employee profile.</p>
        </div>
      </main>
    );
  }

  const { periodId } = await params;
  const employeeId = session.user.employeeId;

  const [periods, assignments] = await Promise.all([listActionablePeriods(employeeId), listWorkerCurrentAssignments(employeeId, helsinkiToday())]);
  const period = periods.find((p) => p.id === periodId);

  if (!period) {
    return (
      <main className="wk-page">
        <div className="wk-card">
          <p>This period is not available to you.</p>
          <Link href="/worker/periods" className="wk-back-link">
            Back to your periods
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="wk-page">
      <div className="wk-card">
        <h1>
          {period.startDate} – {period.endDate}
        </h1>
        <span className={`wk-status-badge wk-status-${period.timesheetStatus.toLowerCase()}`}>{STATUS_LABELS[period.timesheetStatus] ?? period.timesheetStatus}</span>

        <h2 className="wk-section-title">Your assignments</h2>
        {assignments.length === 0 ? (
          <p className="wk-empty">You haven&apos;t been assigned to a site yet.</p>
        ) : (
          <ul className="wk-assignment-list">
            {assignments.map((assignment) => (
              <li key={assignment.id} className="wk-assignment-item">
                <span className="wk-assignment-site">
                  {assignment.siteName}
                  {assignment.isPrimary ? ' (primary)' : ''}
                </span>
                {assignment.workAreaName && <span className="wk-assignment-detail">{assignment.workAreaName}</span>}
                {assignment.templateName && <span className="wk-assignment-detail">{assignment.templateName}</span>}
              </li>
            ))}
          </ul>
        )}

        {EDITABLE_STATUSES.has(period.timesheetStatus) ? (
          <Link href={`/worker/periods/${period.id}/hours`} className="wk-action-button">
            Enter hours
          </Link>
        ) : (
          <p className="wk-readonly-note">Your hours are read-only while this timesheet is being reviewed.</p>
        )}
      </div>
    </main>
  );
}
