import { redirect } from 'next/navigation';
import { resolveServerSession } from '@/lib/server-session';
import { listWorkerTimesheets } from '@/lib/worker-context';
import { SnapshotWriter } from '@/components/worker-pwa/SnapshotWriter';
import { ConnectivityBanner } from '@/components/worker-pwa/ConnectivityBanner';
import { WorkerLink } from '@/components/worker-pwa/WorkerLink';
import type { HistoryListPayload } from '@/lib/offline-outbox/read-snapshots';

export const dynamic = 'force-dynamic';

// docs/titanor-time/01_SCREEN_MAP.md §3 `/worker/history` — all periods, not just actionable.
// Links straight to the already-built /worker/periods/[periodId] rather than a separate
// /worker/history/[timesheetId] route — that page already branches editable-vs-read-only by
// status, which is exactly what a history entry (often FINAL_APPROVED) needs.
const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Not started',
  RETURNED: 'Returned — needs your attention',
  SUBMITTED: 'Submitted — awaiting review',
  FOREMAN_APPROVED: 'Review complete — awaiting final approval',
  FINAL_APPROVED: 'Finalized'
};

export default async function WorkerHistoryPage() {
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

  const timesheets = await listWorkerTimesheets(session.user.employeeId);

  const snapshotPayload: HistoryListPayload = {
    timesheets: timesheets.map((t) => ({ id: t.id, startDate: t.startDate, endDate: t.endDate, timesheetId: t.timesheetId, timesheetStatus: t.timesheetStatus }))
  };

  return (
    <main className="wk-page">
      <div className="wk-card">
        <ConnectivityBanner />
        <WorkerLink href="/worker/periods" className="wk-back-link">
          ← Current periods
        </WorkerLink>
        <h1>History</h1>
        {timesheets.length === 0 ? (
          <p className="wk-empty">No periods yet.</p>
        ) : (
          <ul className="wk-period-list">
            {timesheets.map((t) => (
              <li key={t.timesheetId}>
                <WorkerLink href={`/worker/periods/${t.id}`} className="wk-period-item">
                  <span className="wk-period-dates">
                    {t.startDate} – {t.endDate}
                  </span>
                  <span className={`wk-status-badge wk-status-${t.timesheetStatus.toLowerCase()}`}>{STATUS_LABELS[t.timesheetStatus] ?? t.timesheetStatus}</span>
                </WorkerLink>
              </li>
            ))}
          </ul>
        )}
      </div>
      <SnapshotWriter routeKind="history-list" ownerUserId={session.user.id} payload={snapshotPayload} />
    </main>
  );
}
