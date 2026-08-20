import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { listActionablePeriods } from '@/lib/worker-context';
import { SnapshotWriter } from '@/components/worker-pwa/SnapshotWriter';
import { ConnectivityBanner } from '@/components/worker-pwa/ConnectivityBanner';
import { WorkerLink } from '@/components/worker-pwa/WorkerLink';
import type { PeriodsListPayload } from '@/lib/offline-outbox/read-snapshots';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §3 `/worker/periods` — entry point when the
// worker has more than one actionable period (single-period case redirects
// straight through from /worker). DoD: two simultaneous actionable periods are
// shown distinctly, each linking to its own timesheetId via its periodId.
const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Not started',
  RETURNED: 'Returned — needs your attention',
  SUBMITTED: 'Submitted — awaiting review',
  FOREMAN_APPROVED: 'Review complete — awaiting final approval'
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

  const snapshotPayload: PeriodsListPayload = {
    periods: periods.map((p) => ({ id: p.id, startDate: p.startDate, endDate: p.endDate, timesheetId: p.timesheetId, timesheetStatus: p.timesheetStatus }))
  };

  return (
    <main className="wk-page">
      <div className="wk-card">
        <ConnectivityBanner />
        <h1>Your periods</h1>
        <WorkerLink href="/worker/history" className="wk-back-link">
          View history →
        </WorkerLink>
        {periods.length === 0 ? (
          <p className="wk-empty">You haven&apos;t been assigned to a site yet.</p>
        ) : (
          <ul className="wk-period-list">
            {periods.map((period) => (
              <li key={period.id}>
                <WorkerLink href={`/worker/periods/${period.id}`} className="wk-period-item">
                  <span className="wk-period-dates">
                    {period.startDate} – {period.endDate}
                  </span>
                  <span className={`wk-status-badge wk-status-${period.timesheetStatus.toLowerCase()}`}>
                    {STATUS_LABELS[period.timesheetStatus] ?? period.timesheetStatus}
                  </span>
                </WorkerLink>
              </li>
            ))}
          </ul>
        )}
      </div>
      <SnapshotWriter routeKind="periods-list" ownerUserId={session.user.id} payload={snapshotPayload} />
    </main>
  );
}
