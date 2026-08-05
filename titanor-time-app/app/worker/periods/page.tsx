import { redirect } from 'next/navigation';
import Link from 'next/link';
import { resolveServerSession } from '@/lib/server-session';
import { listActionablePeriods } from '@/lib/worker-context';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §3 `/worker/periods` — entry point when the
// worker has more than one actionable period (single-period case redirects
// straight through from /worker). DoD: two simultaneous actionable periods are
// shown distinctly, each linking to its own timesheetId via its periodId.
const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Not started',
  RETURNED: 'Returned — needs your attention',
  SUBMITTED: 'Submitted — awaiting review',
  FOREMAN_APPROVED: 'Approved by foreman'
};

export default async function WorkerPeriodsPage() {
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

  const periods = await listActionablePeriods(session.user.employeeId);

  return (
    <main className="wk-page">
      <div className="wk-card">
        <h1>Your periods</h1>
        {periods.length === 0 ? (
          <p className="wk-empty">You haven&apos;t been assigned to a site yet.</p>
        ) : (
          <ul className="wk-period-list">
            {periods.map((period) => (
              <li key={period.id}>
                <Link href={`/worker/periods/${period.id}`} className="wk-period-item">
                  <span className="wk-period-dates">
                    {period.startDate} – {period.endDate}
                  </span>
                  <span className={`wk-status-badge wk-status-${period.timesheetStatus.toLowerCase()}`}>
                    {STATUS_LABELS[period.timesheetStatus] ?? period.timesheetStatus}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
